import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The runtime no longer creates tables: initDb is gone and nothing runs DDL at
// boot. drizzle/ is now the only thing that can build a tenant database, so a
// table that falls out of the generated migration set is silent data loss.
const MIGRATIONS_DIR = "drizzle";

const REQUIRED_TABLES = [
  "client_snapshots",
  "notify_recipients",
  "daily_report_notifications",
  "line_users",
  "line_groups",
  "report_range_snapshots",
  "client_request_snapshots",
  "client_request_snapshot_rows",
];

const REQUIRED_INDEXES = ["idx_snapshot_date", "idx_req_snapshot_date"];

function allMigrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf-8"))
    .join("\n");
}

test("every schema.ts table has a CREATE TABLE in drizzle/", () => {
  const sqlText = allMigrationSql();
  for (const table of REQUIRED_TABLES) {
    expect(sqlText).toMatch(
      new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${table}"`),
    );
  }
});

test("both lookup indexes are in drizzle/", () => {
  const sqlText = allMigrationSql();
  for (const index of REQUIRED_INDEXES) {
    expect(sqlText).toContain(`"${index}"`);
  }
});

test("the drizzle journal exists", () => {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: unknown[] };
  expect(journal.entries.length).toBeGreaterThan(0);
});
