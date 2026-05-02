import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { parseNotifyUids, seedFromEnv, getActiveUids } from "../src/repositories/recipient.repository";

test("parseNotifyUids trims and dedupes comma separated env", () => {
  expect(parseNotifyUids(" Uabc123, Udef456, Uabc123, ")).toEqual(["Uabc123", "Udef456"]);
});

test("parseNotifyUids handles empty string", () => {
  expect(parseNotifyUids("")).toEqual([]);
});

test("parseNotifyUids handles single UID", () => {
  expect(parseNotifyUids("Uabc123")).toEqual(["Uabc123"]);
});

test("seedFromEnv inserts recipients and getActiveUids returns them", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  seedFromEnv(db, "Uabc123,Udef456");
  expect(getActiveUids(db)).toEqual(["Uabc123", "Udef456"]);
});

test("seedFromEnv inserts recipients without overwriting active flag", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  seedFromEnv(db, "Uabc123,Udef456");
  db.query("UPDATE notify_recipients SET active = 0 WHERE line_uid = $line_uid").run({ line_uid: "Uabc123" });
  seedFromEnv(db, "Uabc123,Udef456");
  expect(getActiveUids(db)).toEqual(["Udef456"]);
});

test("seedFromEnv is idempotent — duplicate seeds do not create extra rows", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  seedFromEnv(db, "Uabc123,Udef456");
  seedFromEnv(db, "Uabc123,Udef456");
  const rows = db.query("SELECT COUNT(*) as count FROM notify_recipients").get() as { count: number };
  expect(rows.count).toBe(2);
});
