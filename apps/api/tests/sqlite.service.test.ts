import { expect, test, beforeEach, afterEach } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb } from "../src/db/connection";
import * as schema from "../src/db/schema";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import type { DrizzleDb } from "../src/db/connection";
import type { TenantInput } from "../src/types/tenant.types";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 16).toString("base64");

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const INPUT = (label: string): TenantInput => ({
  label,
  active: true,
  lineChannelAccessToken: `tok_${label}`,
  lineChannelSecret: `sec_${label}`,
  hfmApiKey: `hfm_${label}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 30506525,
  whitelistEnabled: true,
});

let client: postgres.Sql;
let db: DrizzleDb;

beforeEach(async () => {
  client = postgres(TEST_DATABASE_URL, { max: 1 });
  db = drizzle(client, { schema });
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
});

afterEach(async () => {
  await client.end();
});

test("initDb creates tables and indexes", async () => {
  await initDb(db);

  const tables = await db.execute(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const tableNames = tables.map((t: Record<string, unknown>) => t.tablename as string);
  expect(tableNames).toContain("client_snapshots");
  expect(tableNames).toContain("notify_recipients");
  expect(tableNames).toContain("daily_report_notifications");
  expect(tableNames).toContain("line_users");
  expect(tableNames).toContain("report_range_snapshots");
  expect(tableNames).toContain("client_request_snapshots");
  expect(tableNames).toContain("client_request_snapshot_rows");

  const indexes = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
    ORDER BY indexname
  `);
  const indexNames = indexes.map((i: Record<string, unknown>) => i.indexname as string);
  expect(indexNames).toContain("idx_snapshot_tenant_date");
  expect(indexNames).toContain("idx_req_snapshot_tenant_date");
  expect(indexNames).not.toContain("idx_snapshot_date");
  expect(indexNames).not.toContain("idx_req_snapshot_date");
});

test("client_snapshots rejects only same-tenant duplicates", async () => {
  await initDb(db);

  const tenantA = await insertTenantRow(db, INPUT("A"));
  const tenantB = await insertTenantRow(db, INPUT("B"));

  await db.execute(sql`
    INSERT INTO client_snapshots (tenant_id, snapshot_date, client_id)
    VALUES (${tenantA}, '2026-04-26', 456)
  `);

  // The composite UNIQUE(tenant_id, snapshot_date, client_id) rejects the
  // same client for the same tenant ...
  // db.execute returns Drizzle's PgRaw thenable, not a real Promise, and
  // bun:test's .rejects requires a genuine Promise. The async IIFE promotes it.
  await expect(
    (async () =>
      db.execute(sql`
        INSERT INTO client_snapshots (tenant_id, snapshot_date, client_id)
        VALUES (${tenantA}, '2026-04-26', 456)
      `))(),
  ).rejects.toThrow();

  // ... but a different tenant may hold the same date and client_id.
  await expect(
    (async () =>
      db.execute(sql`
        INSERT INTO client_snapshots (tenant_id, snapshot_date, client_id)
        VALUES (${tenantB}, '2026-04-26', 456)
      `))(),
  ).resolves.toBeDefined();

  const rows = await db.execute(sql`
    SELECT tenant_id, snapshot_date, client_id FROM client_snapshots
  `);
  expect(rows).toHaveLength(2);
});

test("initDb is idempotent - calling twice does not error", async () => {
  await initDb(db);
  await expect(initDb(db)).resolves.toBeUndefined();
});
