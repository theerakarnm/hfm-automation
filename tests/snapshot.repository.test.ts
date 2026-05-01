import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { countByDate, insertMany, purgeOlderThan } from "../src/repositories/snapshot.repository";
import type { HFMPerformanceData } from "../src/types/hfm.types";

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

test("insertMany stores wallet IDs and deduplicates", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-04-26", [clientA, clientA]);
  expect(countByDate(db, "2026-04-26")).toBe(1);
});

test("insertMany is idempotent for same date and client_id", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-04-26", [clientA]);
  insertMany(db, "2026-04-26", [clientA]);
  expect(countByDate(db, "2026-04-26")).toBe(1);
});

test("countByDate returns 0 when no rows", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  expect(countByDate(db, "2026-04-26")).toBe(0);
});

test("countByDate returns correct count", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-04-26", [clientA, clientB]);
  expect(countByDate(db, "2026-04-26")).toBe(2);
});

test("purgeOlderThan removes rows older than retention window", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-01-01", [clientA]);
  insertMany(db, "2026-04-26", [clientB]);
  purgeOlderThan(db, 90, "2026-04-26");
  expect(countByDate(db, "2026-01-01")).toBe(0);
  expect(countByDate(db, "2026-04-26")).toBe(1);
});
