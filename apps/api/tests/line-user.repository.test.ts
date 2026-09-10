import { expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { recordLineUserRequest, listLineUsers } from "../src/repositories/line-user.repository";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import type { DrizzleDb } from "../src/db/connection";
import type { TenantInput } from "../src/types/tenant.types";
import { createTestDb, closeTestDb } from "./db-helpers";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString("base64");

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

let db: DrizzleDb;
let client: postgres.Sql;
let tenantA: number;
let tenantB: number;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  tenantA = await insertTenantRow(db, INPUT("A"));
  tenantB = await insertTenantRow(db, INPUT("B"));
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM line_users`);
});

afterAll(async () => {
  await closeTestDb(client);
});

test("recordLineUserRequest inserts new user", async () => {
  await recordLineUserRequest(db, tenantA, "Uabc123", "message");

  const users = await listLineUsers(db, tenantA);
  expect(users).toHaveLength(1);
  expect(users[0]!.line_uid).toBe("Uabc123");
  expect(users[0]!.request_count).toBe(1);
  expect(users[0]!.last_event_type).toBe("message");
});

test("recordLineUserRequest increments count on duplicate", async () => {
  await recordLineUserRequest(db, tenantA, "Uabc123", "message");
  await recordLineUserRequest(db, tenantA, "Uabc123", "follow");
  await recordLineUserRequest(db, tenantA, "Uabc123", "message");

  const users = await listLineUsers(db, tenantA);
  expect(users).toHaveLength(1);
  expect(users[0]!.request_count).toBe(3);
  expect(users[0]!.last_event_type).toBe("message");
});

test("recordLineUserRequest tracks multiple users", async () => {
  await recordLineUserRequest(db, tenantA, "Uabc123", "message");
  await recordLineUserRequest(db, tenantA, "Udef456", "follow");
  await recordLineUserRequest(db, tenantA, "Uabc123", "message");

  const users = await listLineUsers(db, tenantA);
  expect(users).toHaveLength(2);
  expect(users.map((u) => u.line_uid).sort()).toEqual(["Uabc123", "Udef456"]);
});

test("same line uid in two tenants counts separately", async () => {
  await recordLineUserRequest(db, tenantA, "Ushared", "message");
  await recordLineUserRequest(db, tenantB, "Ushared", "message");
  await recordLineUserRequest(db, tenantA, "Ushared", "follow");

  const forA = await listLineUsers(db, tenantA);
  const forB = await listLineUsers(db, tenantB);
  expect(forA).toHaveLength(1);
  expect(forA[0]!.request_count).toBe(2);
  expect(forB).toHaveLength(1);
  expect(forB[0]!.request_count).toBe(1);
});

test("listLineUsers returns empty array when no users", async () => {
  expect(await listLineUsers(db, tenantB)).toEqual([]);
});
