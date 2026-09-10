import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { seedDefaultTenantFromEnv } from "./bootstrap";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

let _client: postgres.Sql | null = null;
let _db: DrizzleDb | null = null;

export function getDb(url?: string): DrizzleDb {
  if (_db) return _db;
  const connUrl = url ?? process.env.DATABASE_URL;
  if (!connUrl) throw new Error("DATABASE_URL is not set");
  _client = postgres(connUrl, { max: 10 });
  _db = drizzle(_client, { schema });
  return _db;
}

// drizzle's postgres-js `execute` resolves to a RowList (an array), so the
// callers below read it by length / index, never through a `.rows` property.
async function columnExists(
  db: PostgresJsDatabase<Record<string, unknown>>,
  table: string,
  column: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);
  return (res as unknown as unknown[]).length > 0;
}

async function constraintExists(
  db: PostgresJsDatabase<Record<string, unknown>>,
  name: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM pg_constraint WHERE conname = ${name}
  `);
  return (res as unknown as unknown[]).length > 0;
}

// Old constraints exist under two names: the drizzle-style `..._unique`
// names (databases migrated with drizzle-kit) and the Postgres default
// `..._key` names (databases created by this file's inline UNIQUE SQL).
async function dropIfExists(
  db: PostgresJsDatabase<Record<string, unknown>>,
  table: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    if (await constraintExists(db, name)) {
      await db.execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`));
    }
  }
}

export async function initDb(db?: DrizzleDb | PostgresJsDatabase<Record<string, unknown>>): Promise<void> {
  const target = (db ?? getDb()) as PostgresJsDatabase<Record<string, unknown>>;

  // 1. Create every table in its NEW shape (IF NOT EXISTS is a no-op on
  //    databases that already ran the migration).
  await target.execute(sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id                            SERIAL PRIMARY KEY,
      webhook_id                    TEXT NOT NULL UNIQUE,
      label                         TEXT NOT NULL,
      active                        INTEGER NOT NULL DEFAULT 0,
      line_channel_access_token_enc TEXT NOT NULL,
      line_channel_secret_enc       TEXT NOT NULL,
      line_bot_user_id              TEXT,
      line_basic_id                 TEXT,
      line_display_name             TEXT,
      hfm_api_key_enc               TEXT NOT NULL,
      hfm_api_base_url              TEXT NOT NULL DEFAULT 'https://api.hfaffiliates.com',
      target_wallet                 INTEGER NOT NULL,
      whitelist_enabled             INTEGER NOT NULL DEFAULT 1,
      key_version                   INTEGER NOT NULL DEFAULT 1,
      last_tested_at                TIMESTAMP,
      last_test_result              TEXT,
      created_at                    TIMESTAMP NOT NULL DEFAULT now(),
      updated_at                    TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tenant_whitelist_uids (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      line_uid   TEXT NOT NULL,
      label      TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, line_uid)
    );

    CREATE TABLE IF NOT EXISTS tenant_health_state (
      tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      healthy    INTEGER NOT NULL,
      changed_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS client_snapshots (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
      snapshot_date TEXT NOT NULL,
      client_id     INTEGER NOT NULL,
      name          TEXT,
      email         TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT client_snapshots_tenant_date_client_unique
        UNIQUE (tenant_id, snapshot_date, client_id)
    );

    CREATE TABLE IF NOT EXISTS notify_recipients (
      id        SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      line_uid  TEXT NOT NULL,
      label     TEXT,
      active    INTEGER NOT NULL DEFAULT 1,
      CONSTRAINT notify_recipients_tenant_uid_unique UNIQUE (tenant_id, line_uid)
    );

    CREATE TABLE IF NOT EXISTS daily_report_notifications (
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
      snapshot_date TEXT NOT NULL,
      sent_at       TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT daily_report_notifications_tenant_date_pkey
        PRIMARY KEY (tenant_id, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS line_users (
      tenant_id        INTEGER NOT NULL REFERENCES tenants(id),
      line_uid         TEXT NOT NULL,
      first_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
      last_seen_at     TIMESTAMP NOT NULL DEFAULT now(),
      request_count    INTEGER NOT NULL DEFAULT 1,
      last_event_type  TEXT,
      CONSTRAINT line_users_tenant_uid_pkey PRIMARY KEY (tenant_id, line_uid)
    );

    CREATE TABLE IF NOT EXISTS report_range_snapshots (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      period     TEXT NOT NULL,
      from_date  TEXT NOT NULL,
      to_date    TEXT NOT NULL,
      raw_json   TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT report_range_snapshots_tenant_period_unique
        UNIQUE (tenant_id, period, from_date, to_date)
    );

    CREATE TABLE IF NOT EXISTS client_request_snapshots (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
      snapshot_date TEXT NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS client_request_snapshot_rows (
      id          SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES client_request_snapshots(id),
      client_id   INTEGER NOT NULL,
      UNIQUE(snapshot_id, client_id)
    );
  `);

  // 2. Seed the default tenant from env (no-op when tenants already exist).
  await seedDefaultTenantFromEnv((db ?? getDb()) as DrizzleDb);

  // 3. Migrate existing legacy tables: add tenant_id, backfill, constrain.
  //    The order matters: the backfill needs at least one tenant row.
  const LEGACY_TABLES = [
    "client_snapshots",
    "notify_recipients",
    "daily_report_notifications",
    "line_users",
    "report_range_snapshots",
    "client_request_snapshots",
  ] as const;

  for (const table of LEGACY_TABLES) {
    if (!(await columnExists(target, table, "tenant_id"))) {
      await target.execute(
        sql.raw(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER`),
      );
    }
  }

  // The tenant indexes live here, not in the CREATE batch above: on a legacy
  // database the columns they reference only exist after the loop above, and
  // one failing statement aborts the whole multi-statement batch.
  await target.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_snapshot_tenant_date
    ON client_snapshots(tenant_id, snapshot_date)
  `);
  await target.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_req_snapshot_tenant_date
    ON client_request_snapshots(tenant_id, snapshot_date)
  `);

  const tenantRows = (await target.execute(
    sql`SELECT MIN(id) AS first_id FROM tenants`,
  )) as unknown as { first_id: number | null }[];
  const defaultTenantId = tenantRows[0]?.first_id ?? null;

  const orphanCheck = (await target.execute(sql`
    SELECT
      (SELECT count(*) FROM client_snapshots WHERE tenant_id IS NULL) +
      (SELECT count(*) FROM daily_report_notifications WHERE tenant_id IS NULL) +
      (SELECT count(*) FROM line_users WHERE tenant_id IS NULL) +
      (SELECT count(*) FROM notify_recipients WHERE tenant_id IS NULL) +
      (SELECT count(*) FROM report_range_snapshots WHERE tenant_id IS NULL) +
      (SELECT count(*) FROM client_request_snapshots WHERE tenant_id IS NULL) AS orphans
  `)) as unknown as { orphans: string }[];
  const orphans = Number(orphanCheck[0]?.orphans ?? 0);

  if (orphans > 0 && defaultTenantId === null) {
    throw new Error(
      `Legacy rows exist (${orphans}) but no tenant exists to backfill them. ` +
        "Set the per-OA env vars once so the bootstrap seed can run, then restart.",
    );
  }

  if (defaultTenantId !== null) {
    for (const table of LEGACY_TABLES) {
      await target.execute(
        sql.raw(`UPDATE ${table} SET tenant_id = ${defaultTenantId} WHERE tenant_id IS NULL`),
      );
    }
  }

  // NOT NULL + FK after the backfill, guarded so reruns are silent.
  for (const table of LEGACY_TABLES) {
    const nullRes = (await target.execute(
      sql.raw(`SELECT count(*) AS n FROM ${table} WHERE tenant_id IS NULL`),
    )) as unknown as { n: string }[];
    if (Number(nullRes[0]!.n) === 0) {
      await target.execute(
        sql.raw(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`),
      );
      await target.execute(
        sql.raw(
          `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_tenant_id_fkey`,
        ),
      );
      await target.execute(
        sql.raw(
          `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant_id_fkey ` +
            `FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
        ),
      );
    }
  }

  // Constraint rebuilds. Each drop covers both possible legacy names (the
  // drizzle-style `..._unique` and the Postgres default `..._key`), and each
  // ADD only runs when the new constraint is missing, so a fresh database
  // (whose CREATE block above already made the named constraints) and an
  // already-migrated database both skip every statement here.
  await dropIfExists(target, "client_snapshots", [
    "client_snapshots_snapshot_date_client_id_unique",
    "client_snapshots_snapshot_date_client_id_key",
  ]);
  if (!(await constraintExists(target, "client_snapshots_tenant_date_client_unique"))) {
    await target.execute(sql`
      ALTER TABLE client_snapshots
      ADD CONSTRAINT client_snapshots_tenant_date_client_unique
      UNIQUE (tenant_id, snapshot_date, client_id)
    `);
  }

  await dropIfExists(target, "notify_recipients", [
    "notify_recipients_line_uid_unique",
    "notify_recipients_line_uid_key",
  ]);
  if (!(await constraintExists(target, "notify_recipients_tenant_uid_unique"))) {
    await target.execute(sql`
      ALTER TABLE notify_recipients
      ADD CONSTRAINT notify_recipients_tenant_uid_unique
      UNIQUE (tenant_id, line_uid)
    `);
  }

  await dropIfExists(target, "daily_report_notifications", [
    "daily_report_notifications_pkey",
  ]);
  if (!(await constraintExists(target, "daily_report_notifications_tenant_date_pkey"))) {
    await target.execute(sql`
      ALTER TABLE daily_report_notifications
      ADD CONSTRAINT daily_report_notifications_tenant_date_pkey
      PRIMARY KEY (tenant_id, snapshot_date)
    `);
  }

  await dropIfExists(target, "line_users", ["line_users_pkey"]);
  if (!(await constraintExists(target, "line_users_tenant_uid_pkey"))) {
    await target.execute(sql`
      ALTER TABLE line_users
      ADD CONSTRAINT line_users_tenant_uid_pkey
      PRIMARY KEY (tenant_id, line_uid)
    `);
  }

  await dropIfExists(target, "report_range_snapshots", [
    "report_range_snapshots_period_from_date_to_date_unique",
    "report_range_snapshots_period_from_date_to_date_key",
  ]);
  if (!(await constraintExists(target, "report_range_snapshots_tenant_period_unique"))) {
    await target.execute(sql`
      ALTER TABLE report_range_snapshots
      ADD CONSTRAINT report_range_snapshots_tenant_period_unique
      UNIQUE (tenant_id, period, from_date, to_date)
    `);
  }

  // The single-tenant indexes are replaced by idx_snapshot_tenant_date and
  // idx_req_snapshot_tenant_date above; drop them on legacy databases.
  await target.execute(sql`DROP INDEX IF EXISTS idx_snapshot_date`);
  await target.execute(sql`DROP INDEX IF EXISTS idx_req_snapshot_date`);
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export function resetDbForTests(): void {
  _client = null;
  _db = null;
}
