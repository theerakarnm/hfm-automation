import { expect, test, beforeEach, afterEach } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { recordLineUserRequest, listLineUsers } from "../src/repositories/line-user.repository";
import type { DrizzleDb } from "../src/db/connection";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

let client: postgres.Sql;
let db: DrizzleDb;

async function clearTables() {
  await db.execute(sql`DELETE FROM line_users`);
}

beforeEach(async () => {
  client = postgres(TEST_DATABASE_URL, { max: 1 });
  db = drizzle(client);
  await clearTables();
});

afterEach(async () => {
  await client.end();
});

test("recordLineUserRequest inserts new user", async () => {
  await recordLineUserRequest(db, "Uabc123", "message");

  const users = await listLineUsers(db);
  expect(users).toHaveLength(1);
  expect(users[0]!.line_uid).toBe("Uabc123");
  expect(users[0]!.request_count).toBe(1);
  expect(users[0]!.last_event_type).toBe("message");
});

test("recordLineUserRequest increments count on duplicate", async () => {
  await recordLineUserRequest(db, "Uabc123", "message");
  await recordLineUserRequest(db, "Uabc123", "follow");
  await recordLineUserRequest(db, "Uabc123", "message");

  const users = await listLineUsers(db);
  expect(users).toHaveLength(1);
  expect(users[0]!.request_count).toBe(3);
  expect(users[0]!.last_event_type).toBe("message");
});

test("recordLineUserRequest tracks multiple users", async () => {
  await recordLineUserRequest(db, "Uabc123", "message");
  await recordLineUserRequest(db, "Udef456", "follow");
  await recordLineUserRequest(db, "Uabc123", "message");

  const users = await listLineUsers(db);
  expect(users).toHaveLength(2);
  expect(users.map((u) => u.line_uid).sort()).toEqual(["Uabc123", "Udef456"]);
});

test("listLineUsers returns empty array when no users", async () => {
  const users = await listLineUsers(db);
  expect(users).toEqual([]);
});
