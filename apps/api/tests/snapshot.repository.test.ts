import { expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import postgres from "postgres";
import { sql, and, eq } from "drizzle-orm";
import {
  countByDate,
  insertMany,
  purgeOlderThan,
  getLatestSnapshotDateBefore,
} from "../src/repositories/snapshot.repository";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { clientSnapshots } from "../src/db/schema";
import type { DrizzleDb } from "../src/db/connection";
import type { TenantInput } from "../src/types/tenant.types";
import { createTestDb, closeTestDb } from "./db-helpers";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");

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

const rowA = { snapshotDate: "2026-04-26", clientId: 10023, name: "Somchai Jaidee", email: null as string | null };
const rowB = { snapshotDate: "2026-04-26", clientId: 10024, name: "Malee Srisuk", email: null as string | null };

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  tenantA = await insertTenantRow(db, INPUT("A"));
  tenantB = await insertTenantRow(db, INPUT("B"));
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM client_snapshots`);
});

afterAll(async () => {
  await closeTestDb(client);
});

test("insertMany stores wallet IDs and deduplicates", async () => {
  await insertMany(db, tenantA, [rowA, rowA]);
  expect(await countByDate(db, tenantA, "2026-04-26")).toBe(1);
});

test("insertMany persists customer name and email", async () => {
  const withEmail = { ...rowA, email: "somchai@example.com" };
  await insertMany(db, tenantA, [withEmail]);

  const rows = await db
    .select({ name: clientSnapshots.name, email: clientSnapshots.email })
    .from(clientSnapshots)
    .where(
      and(
        eq(clientSnapshots.tenantId, tenantA),
        eq(clientSnapshots.snapshotDate, "2026-04-26"),
        eq(clientSnapshots.clientId, withEmail.clientId),
      ),
    );

  expect(rows[0]).toEqual({ name: "Somchai Jaidee", email: "somchai@example.com" });
});

test("insertMany stores null email when HFM provides none", async () => {
  await insertMany(db, tenantA, [rowA]);

  const rows = await db
    .select({ name: clientSnapshots.name, email: clientSnapshots.email })
    .from(clientSnapshots)
    .where(
      and(
        eq(clientSnapshots.tenantId, tenantA),
        eq(clientSnapshots.snapshotDate, "2026-04-26"),
        eq(clientSnapshots.clientId, rowA.clientId),
      ),
    );

  expect(rows[0]).toEqual({ name: "Somchai Jaidee", email: null });
});

test("insertMany is idempotent for same date and client_id", async () => {
  await insertMany(db, tenantA, [rowA]);
  await insertMany(db, tenantA, [rowA]);
  expect(await countByDate(db, tenantA, "2026-04-26")).toBe(1);
});

test("same snapshot_date and client_id coexist across tenants", async () => {
  await insertMany(db, tenantA, [rowA]);
  await insertMany(db, tenantB, [rowA]);
  expect(await countByDate(db, tenantA, "2026-04-26")).toBe(1);
  expect(await countByDate(db, tenantB, "2026-04-26")).toBe(1);
});

test("countByDate returns 0 when no rows", async () => {
  expect(await countByDate(db, tenantA, "2026-04-26")).toBe(0);
});

test("countByDate returns correct count", async () => {
  await insertMany(db, tenantA, [rowA, rowB]);
  expect(await countByDate(db, tenantA, "2026-04-26")).toBe(2);
});

test("getLatestSnapshotDateBefore is scoped to the tenant", async () => {
  await insertMany(db, tenantA, [{ ...rowA, snapshotDate: "2026-01-05" }]);
  await insertMany(db, tenantB, [{ ...rowB, snapshotDate: "2026-02-10" }]);
  expect(await getLatestSnapshotDateBefore(db, tenantA, "2026-04-26")).toBe("2026-01-05");
  expect(await getLatestSnapshotDateBefore(db, tenantB, "2026-04-26")).toBe("2026-02-10");
  expect(await getLatestSnapshotDateBefore(db, tenantB, "2026-02-01")).toBe(null);
});

test("purgeOlderThan removes rows older than retention window", async () => {
  await insertMany(db, tenantA, [{ ...rowA, snapshotDate: "2026-01-01" }]);
  await insertMany(db, tenantA, [{ ...rowB, snapshotDate: "2026-04-26" }]);
  await purgeOlderThan(db, tenantA, 90, "2026-04-26");
  expect(await countByDate(db, tenantA, "2026-01-01")).toBe(0);
  expect(await countByDate(db, tenantA, "2026-04-26")).toBe(1);
});

test("purgeOlderThan only purges the given tenant", async () => {
  await insertMany(db, tenantA, [{ ...rowA, snapshotDate: "2026-01-01" }]);
  await insertMany(db, tenantB, [{ ...rowB, snapshotDate: "2026-01-01" }]);
  await purgeOlderThan(db, tenantA, 90, "2026-04-26");
  expect(await countByDate(db, tenantA, "2026-01-01")).toBe(0);
  expect(await countByDate(db, tenantB, "2026-01-01")).toBe(1);
});
