import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { recordLineUserRequest, listLineUsers } from "../src/repositories/line-user.repository";

test("recordLineUserRequest inserts new user", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);

  recordLineUserRequest(db, "Uabc123", "message");

  const users = listLineUsers(db);
  expect(users).toHaveLength(1);
  expect(users[0]!.line_uid).toBe("Uabc123");
  expect(users[0]!.request_count).toBe(1);
  expect(users[0]!.last_event_type).toBe("message");
});

test("recordLineUserRequest increments count on duplicate", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);

  recordLineUserRequest(db, "Uabc123", "message");
  recordLineUserRequest(db, "Uabc123", "follow");
  recordLineUserRequest(db, "Uabc123", "message");

  const users = listLineUsers(db);
  expect(users).toHaveLength(1);
  expect(users[0]!.request_count).toBe(3);
  expect(users[0]!.last_event_type).toBe("message");
});

test("recordLineUserRequest tracks multiple users", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);

  recordLineUserRequest(db, "Uabc123", "message");
  recordLineUserRequest(db, "Udef456", "follow");
  recordLineUserRequest(db, "Uabc123", "message");

  const users = listLineUsers(db);
  expect(users).toHaveLength(2);
  expect(users.map((u) => u.line_uid).sort()).toEqual(["Uabc123", "Udef456"]);
});

test("listLineUsers returns empty array when no users", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);

  const users = listLineUsers(db);
  expect(users).toEqual([]);
});
