import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

export async function createTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  await db.execute(sql`
    DROP TABLE IF EXISTS tenant_health_state CASCADE;
    DROP TABLE IF EXISTS tenant_whitelist_uids CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
  `);

  await db.execute(sql`
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
      id              SERIAL PRIMARY KEY,
      snapshot_date   TEXT NOT NULL,
      client_id       INTEGER NOT NULL,
      name            TEXT,
      email           TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(snapshot_date, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_date
      ON client_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS notify_recipients (
      id         SERIAL PRIMARY KEY,
      -- Nullable interim column: Task 6 replaces this block with the final
      -- NOT NULL + UNIQUE(tenant_id, line_uid) shape.
      tenant_id  INTEGER REFERENCES tenants(id),
      line_uid   TEXT NOT NULL UNIQUE,
      label      TEXT,
      active     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_report_notifications (
      snapshot_date TEXT PRIMARY KEY,
      sent_at       TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS line_users (
      line_uid        TEXT PRIMARY KEY,
      first_seen_at   TIMESTAMP NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
      request_count   INTEGER NOT NULL DEFAULT 1,
      last_event_type TEXT
    );

    CREATE TABLE IF NOT EXISTS report_range_snapshots (
      id         SERIAL PRIMARY KEY,
      period     TEXT NOT NULL,
      from_date  TEXT NOT NULL,
      to_date    TEXT NOT NULL,
      raw_json   TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(period, from_date, to_date)
    );

    CREATE TABLE IF NOT EXISTS client_request_snapshots (
      id            SERIAL PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_req_snapshot_date
      ON client_request_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS client_request_snapshot_rows (
      id          SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES client_request_snapshots(id),
      client_id   INTEGER NOT NULL,
      UNIQUE(snapshot_id, client_id)
    );
  `);

  return { db, client };
}

export async function closeTestDb(client: postgres.Sql) {
  await client.end();
}
