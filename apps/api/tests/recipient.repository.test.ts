import { expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  addRecipient,
  removeRecipient,
  getActiveUids,
} from "../src/repositories/recipient.repository";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import type { DrizzleDb } from "../src/db/connection";
import type { TenantInput } from "../src/types/tenant.types";
import { createTestDb, closeTestDb } from "./db-helpers";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");

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
  db = t.db; client = t.client;
  tenantA = await insertTenantRow(db, INPUT("A"));
  tenantB = await insertTenantRow(db, INPUT("B"));
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM notify_recipients`);
});

afterAll(async () => {
  await closeTestDb(client);
});

test("getActiveUids returns only this tenant's recipients", async () => {
  await addRecipient(db, tenantA, "Urec1", "boss A");
  await addRecipient(db, tenantA, "Urec2", null);
  await addRecipient(db, tenantB, "Urec3", "boss B");
  expect(await getActiveUids(db, tenantA)).toEqual(["Urec1", "Urec2"]);
  expect(await getActiveUids(db, tenantB)).toEqual(["Urec3"]);
});

test("removeRecipient only removes for that tenant", async () => {
  await addRecipient(db, tenantA, "Udup", "a");
  await addRecipient(db, tenantB, "Udup", "b");
  await removeRecipient(db, tenantB, "Udup");
  expect(await getActiveUids(db, tenantA)).toContain("Udup");
  expect(await getActiveUids(db, tenantB)).not.toContain("Udup");
});

test("getActiveUids skips rows deactivated directly in SQL", async () => {
  await addRecipient(db, tenantA, "Uoff", "a");
  await db.execute(
    sql`UPDATE notify_recipients SET active = 0 WHERE line_uid = 'Uoff'`,
  );
  expect(await getActiveUids(db, tenantA)).not.toContain("Uoff");
});

test("addRecipient ignores same-tenant duplicates, allows same uid per tenant", async () => {
  await addRecipient(db, tenantA, "Usame", "a");
  await addRecipient(db, tenantA, "Usame", "a2");
  await addRecipient(db, tenantB, "Usame", "b");
  const rows = await db.execute(
    sql`SELECT tenant_id, line_uid FROM notify_recipients WHERE line_uid = 'Usame' ORDER BY tenant_id`,
  );
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.tenant_id)).toEqual([tenantA, tenantB]);
});
