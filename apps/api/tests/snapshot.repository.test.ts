import { expect, test, beforeEach, afterEach } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb } from "../src/db/connection";
import { countByDate, insertMany, purgeOlderThan } from "../src/repositories/snapshot.repository";
import type { HFMPerformanceData } from "../src/types/hfm.types";
import type { DrizzleDb } from "../src/db/connection";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

let client: postgres.Sql;
let db: DrizzleDb;

const clientA: HFMPerformanceData = {
  client_id: 10023,
  account_id: 78451293,
  activity_status: "active",
  trades: 24,
  volume: 3.42,
  account_type: "Standard",
  balance: 12450.8,
  account_currency: "USD",
  equity: 12998.35,
  archived: null,
  subaffiliate: 0,
  account_regdate: "2024-01-15T00:00:00Z",
  status: "approved",
  full_name: "Somchai Jaidee",
};

const clientB: HFMPerformanceData = {
  ...clientA,
  client_id: 10024,
  account_id: 99001234,
  full_name: "Malee Srisuk",
};

async function clearTables() {
  await db.execute(sql`DELETE FROM client_request_snapshot_rows`);
  await db.execute(sql`DELETE FROM client_request_snapshots`);
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

test("insertMany stores wallet IDs and deduplicates", async () => {
  await insertMany(db, "2026-04-26", [clientA, clientA]);
  expect(await countByDate(db, "2026-04-26")).toBe(1);
});

test("insertMany is idempotent for same date and client_id", async () => {
  await insertMany(db, "2026-04-26", [clientA]);
  await insertMany(db, "2026-04-26", [clientA]);
  expect(await countByDate(db, "2026-04-26")).toBe(1);
});

test("countByDate returns 0 when no rows", async () => {
  expect(await countByDate(db, "2026-04-26")).toBe(0);
});

test("countByDate returns correct count", async () => {
  await insertMany(db, "2026-04-26", [clientA, clientB]);
  expect(await countByDate(db, "2026-04-26")).toBe(2);
});

test("purgeOlderThan removes rows older than retention window", async () => {
  await insertMany(db, "2026-01-01", [clientA]);
  await insertMany(db, "2026-04-26", [clientB]);
  await purgeOlderThan(db, 90, "2026-04-26");
  expect(await countByDate(db, "2026-01-01")).toBe(0);
  expect(await countByDate(db, "2026-04-26")).toBe(1);
});
