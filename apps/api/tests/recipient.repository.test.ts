import { expect, test, beforeEach, afterEach } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { parseNotifyUids, seedFromEnv, getActiveUids } from "../src/repositories/recipient.repository";
import type { DrizzleDb } from "../src/db/connection";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

let client: postgres.Sql;
let db: DrizzleDb;

async function clearTables() {
  await db.execute(sql`DELETE FROM client_request_snapshot_rows`);
  await db.execute(sql`DELETE FROM client_request_snapshots`);
  await db.execute(sql`DELETE FROM notify_recipients`);
  await db.execute(sql`DELETE FROM daily_report_notifications`);
  await db.execute(sql`DELETE FROM client_snapshots`);
}

beforeEach(async () => {
  client = postgres(TEST_DATABASE_URL, { max: 1 });
  db = drizzle(client);
  await clearTables();
});

afterEach(async () => {
  await client.end();
});

test("parseNotifyUids trims and dedupes comma separated env", () => {
  expect(parseNotifyUids(" Uabc123, Udef456, Uabc123, ")).toEqual(["Uabc123", "Udef456"]);
});

test("parseNotifyUids handles empty string", () => {
  expect(parseNotifyUids("")).toEqual([]);
});

test("parseNotifyUids handles single UID", () => {
  expect(parseNotifyUids("Uabc123")).toEqual(["Uabc123"]);
});

test("seedFromEnv inserts recipients and getActiveUids returns them", async () => {
  await seedFromEnv(db, "Uabc123,Udef456");
  expect(await getActiveUids(db)).toEqual(["Uabc123", "Udef456"]);
});

test("seedFromEnv inserts recipients without overwriting active flag", async () => {
  await seedFromEnv(db, "Uabc123,Udef456");
  await db.execute(sql`UPDATE notify_recipients SET active = 0 WHERE line_uid = 'Uabc123'`);
  await seedFromEnv(db, "Uabc123,Udef456");
  expect(await getActiveUids(db)).toEqual(["Udef456"]);
});

test("seedFromEnv is idempotent — duplicate seeds do not create extra rows", async () => {
  await seedFromEnv(db, "Uabc123,Udef456");
  await seedFromEnv(db, "Uabc123,Udef456");
  const rows = await db.execute(sql`SELECT COUNT(*) as count FROM notify_recipients`);
  expect(Number(rows[0]!.count)).toBe(2);
});
