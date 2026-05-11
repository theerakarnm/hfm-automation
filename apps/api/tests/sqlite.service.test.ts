import { expect, test, beforeEach, afterEach } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb } from "../src/db/connection";
import * as schema from "../src/db/schema";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  client = postgres(TEST_DATABASE_URL, { max: 1 });
  db = drizzle(client, { schema });
  await db.execute(sql`
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
  expect(indexNames).toContain("idx_snapshot_date");
  expect(indexNames).toContain("idx_req_snapshot_date");
});

test("client_snapshots has UNIQUE constraint on snapshot_date and client_id", async () => {
  await initDb(db);

  await db.execute(sql`
    INSERT INTO client_snapshots (snapshot_date, client_id) VALUES ('2026-04-26', 456)
  `);

  await expect(
    db.execute(sql`
      INSERT INTO client_snapshots (snapshot_date, client_id) VALUES ('2026-04-26', 456)
    `),
  ).rejects.toThrow();
});

test("initDb is idempotent — calling twice does not error", async () => {
  await initDb(db);
  await expect(initDb(db)).resolves.not.toThrow();
});
