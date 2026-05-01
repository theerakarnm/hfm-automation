import { expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite, resetDatabaseForTests } from "../src/services/sqlite.service";

afterEach(() => {
  resetDatabaseForTests();
});

test("initSqlite creates tables and indexes", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const tableNames = tables.map((t) => t.name);
  expect(tableNames).toContain("client_snapshots");
  expect(tableNames).toContain("notify_recipients");
  expect(tableNames).toContain("daily_report_notifications");
  expect(tableNames).toContain("line_users");

  const indexes = db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const indexNames = indexes.map((i) => i.name);
  expect(indexNames).toContain("idx_snapshot_date");
});

test("client_snapshots has UNIQUE constraint on snapshot_date and client_id", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);

  db.prepare(
    "INSERT INTO client_snapshots (snapshot_date, client_id) VALUES ($d, $c)"
  ).run({ d: "2026-04-26", c: 456 });

  expect(() => {
    db.prepare(
      "INSERT INTO client_snapshots (snapshot_date, client_id) VALUES ($d, $c)"
    ).run({ d: "2026-04-26", c: 456 });
  }).toThrow();
});

test("initSqlite is idempotent — calling twice does not error", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  expect(() => initSqlite(db)).not.toThrow();
});
