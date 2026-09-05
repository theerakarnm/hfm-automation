import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { insertMany, countByDate } from "../src/repositories/snapshot.repository";
import { recordLineUserRequest, listLineUsers } from "../src/repositories/line-user.repository";
import { markDailyReportSent, isDailyReportSent } from "../src/repositories/daily-notification.repository";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;

const INPUT = (wallet: number) => ({
  label: `OA ${wallet}`,
  active: true,
  lineChannelAccessToken: `tok_${wallet}`,
  lineChannelSecret: `sec_${wallet}`,
  hfmApiKey: `key_${wallet}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: wallet,
  whitelistEnabled: true,
});

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  db = t.db;
  client = t.client;
});

afterAll(async () => {
  await closeTestDb(client);
  delete process.env.DATABASE_URL;
});

describe("tenant_id migration", () => {
  test("two tenants can store the same snapshot_date and client_id", async () => {
    const a = await insertTenantRow(db, INPUT(111));
    const b = await insertTenantRow(db, INPUT(222));
    await insertMany(db, a, [
      { snapshotDate: "2026-09-05", clientId: 98241376, name: "x", email: null },
    ]);
    await insertMany(db, b, [
      { snapshotDate: "2026-09-05", clientId: 98241376, name: "x", email: null },
    ]);
    expect(await countByDate(db, a, "2026-09-05")).toBe(1);
    expect(await countByDate(db, b, "2026-09-05")).toBe(1);
  });

  test("two tenants can hold the same line uid without overwriting", async () => {
    const rows = await db.select().from((await import("../src/db/schema")).tenants);
    const a = rows[0]!.id;
    const b = rows[1]!.id;
    await recordLineUserRequest(db, a, "Usame", "message");
    await recordLineUserRequest(db, b, "Usame", "message");
    await recordLineUserRequest(db, a, "Usame", "message");
    const forA = (await listLineUsers(db, a)).find((u) => u.line_uid === "Usame");
    const forB = (await listLineUsers(db, b)).find((u) => u.line_uid === "Usame");
    expect(forA!.request_count).toBe(2);
    expect(forB!.request_count).toBe(1);
  });

  test("daily report sent for A does not suppress B", async () => {
    const rows = await db.select().from((await import("../src/db/schema")).tenants);
    const a = rows[0]!.id;
    const b = rows[1]!.id;
    await markDailyReportSent(db, a, "2026-09-05");
    expect(await isDailyReportSent(db, a, "2026-09-05")).toBe(true);
    expect(await isDailyReportSent(db, b, "2026-09-05")).toBe(false);
  });

  test("old single-tenant unique constraints are gone", async () => {
    const res = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'u' AND conname IN (
        'client_snapshots_snapshot_date_client_id_unique',
        'client_snapshots_snapshot_date_client_id_key',
        'notify_recipients_line_uid_unique',
        'notify_recipients_line_uid_key',
        'report_range_snapshots_period_from_date_to_date_unique',
        'report_range_snapshots_period_from_date_to_date_key'
      )
    `);
    // Drizzle's postgres-js execute resolves to a RowList (an array), so the
    // result is read by length, not through a `.rows` property.
    expect((res as unknown as unknown[]).length).toBe(0);
  });
});
