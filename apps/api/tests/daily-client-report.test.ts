import { expect, test, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { insertMany, countByDate } from "../src/repositories/snapshot.repository";
import { addRecipient } from "../src/repositories/recipient.repository";
import { markDailyReportSent, isDailyReportSent } from "../src/repositories/daily-notification.repository";
import {
  insertRequestSnapshot,
  getLatestRequestSnapshotBefore,
  findMissingWalletIds,
  findNewWalletIds,
} from "../src/repositories/request-snapshot.repository";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import {
  buildDayReportMessage,
  buildComparisonReportMessage,
  generateReportForUser,
  runDailyClientReport,
} from "../src/jobs/daily-client-report";
import { getLastWeekRange, getLastMonthRange, getIctDateString } from "../src/utils/date";
import type { HFMClientRow, HFMClientsResult } from "../src/types/hfm.types";
import type { TenantConfig } from "../src/types/tenant.types";
import type { TenantInput } from "../src/types/tenant.types";
import type { DrizzleDb } from "../src/db/connection";
import { createTestDb, closeTestDb } from "./db-helpers";
import type postgres from "postgres";

// Bun auto-loads apps/api/.env into process.env. With those per-OA values
// present, the bootstrap seed inside initDb would try to run before this
// file sets its own CONFIG_ENCRYPTION_KEY and throw. Clear them before any
// schema or db work happens in this file.
function clearPerOaEnv() {
  for (const key of [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_SECRET",
    "HFM_API_KEY",
    "TARGET_WALLET",
    "LINE_WHITELIST_UIDS",
    "LINE_NOTIFY_UIDS",
  ]) {
    delete process.env[key];
  }
}

clearPerOaEnv();
process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const TENANT_INPUT = (label: string, targetWallet: number): TenantInput => ({
  label,
  active: true,
  lineChannelAccessToken: `tok_${label}`,
  lineChannelSecret: `sec_${label}`,
  hfmApiKey: `hfm_${label}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet,
  whitelistEnabled: true,
});

function makeCtx(id: number, label: string, targetWallet: number): TenantConfig {
  return {
    id,
    webhookId: `webhook-${label.toLowerCase()}`,
    label,
    active: true,
    lineChannelAccessToken: `tok_${label}`,
    lineChannelSecret: `sec_${label}`,
    lineBotUserId: null,
    lineBasicId: null,
    lineDisplayName: null,
    hfmApiKey: `hfm_${label}`,
    hfmApiBaseUrl: "https://api.hfaffiliates.com",
    targetWallet,
    whitelistEnabled: true,
    whitelistUids: [],
    lastTestedAt: null,
    lastTestResult: null,
  };
}

let db: DrizzleDb;
let client: postgres.Sql;
let idA: number;
let idB: number;
let ctxA: TenantConfig;
let ctxB: TenantConfig;

async function clearTables() {
  await db.execute(sql`DELETE FROM client_request_snapshot_rows`);
  await db.execute(sql`DELETE FROM client_request_snapshots`);
  await db.execute(sql`DELETE FROM daily_report_notifications`);
  await db.execute(sql`DELETE FROM notify_recipients`);
  await db.execute(sql`DELETE FROM client_snapshots`);
}

beforeAll(async () => {
  clearPerOaEnv();
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  idA = await insertTenantRow(db, TENANT_INPUT("A", 111));
  idB = await insertTenantRow(db, TENANT_INPUT("B", 222));
  ctxA = makeCtx(idA, "A", 111);
  ctxB = makeCtx(idB, "B", 222);
});

beforeEach(async () => {
  await clearTables();
});

afterAll(async () => {
  await closeTestDb(client);
});

describe("buildDayReportMessage", () => {
  test("formats daily report with missing wallets", () => {
    const message = buildDayReportMessage({
      baselineLabel: "Yesterday",
      baselineDate: "2026-04-25",
      baselineCount: 100,
      currentCount: 95,
      targetWalletLabel: "30506525",
      missingIds: [6503256, 6520562],
      newIds: [99999, 99998, 99997],
    });
    expect(message).toContain("Daily Wallet Report");
    expect(message).toContain("Yesterday (25/04/26): 100 Wallets");
    expect(message).toContain("Current: 95 Wallets");
    expect(message).toContain("Change: -5 Wallets");
    expect(message).toContain("2 Missing Wallets since Yesterday");
    expect(message).toContain("-6503256");
    expect(message).toContain("-6520562");
    expect(message).toContain("3 New Wallets");
  });

  test("formats zero missing wallets", () => {
    const message = buildDayReportMessage({
      baselineLabel: "Yesterday",
      baselineDate: "2026-04-25",
      baselineCount: 500,
      currentCount: 500,
      targetWalletLabel: "30506525",
      missingIds: [],
      newIds: [],
    });
    expect(message).toContain("Change: 0 Wallets (0.00%)");
    expect(message).toContain("0 Missing Wallets since Yesterday");
    expect(message).toContain("0 New Wallets");
  });

  test("handles positive change with percentage", () => {
    const message = buildDayReportMessage({
      baselineLabel: "Yesterday",
      baselineDate: "2026-04-25",
      baselineCount: 100,
      currentCount: 120,
      targetWalletLabel: "30506525",
      missingIds: [],
      newIds: Array.from({ length: 20 }, (_, i) => 1000 + i),
    });
    expect(message).toContain("Change: +20 Wallets (+20.00%)");
    expect(message).toContain("20 New Wallets");
  });
});

describe("buildComparisonReportMessage", () => {
  test("formats week comparison with change", () => {
    const msg = buildComparisonReportMessage({
      title: "Week-over-week Wallet Report",
      prevLabel: "End of last week",
      prevDate: "2026-04-26",
      prevCount: 100,
      currLabel: "Current",
      currCount: 120,
      targetWalletLabel: "30506525",
      missingIds: [12345],
      newIds: [99999, 88888],
    });
    expect(msg).toContain("Week-over-week Wallet Report");
    expect(msg).toContain("End of last week (26/04/26): 100 Wallets");
    expect(msg).toContain("Current: 120 Wallets");
    expect(msg).toContain("Change: +20 Wallets (+20.00%)");
    expect(msg).toContain("1 Missing Wallets since End of last week");
    expect(msg).toContain("-12345");
    expect(msg).toContain("2 New Wallets");
  });

  test("shows zero change", () => {
    const msg = buildComparisonReportMessage({
      title: "Month-over-month Wallet Report",
      prevLabel: "End of last month",
      prevDate: "2026-03-31",
      prevCount: 50,
      currLabel: "Current",
      currCount: 50,
      targetWalletLabel: "30506525",
      missingIds: [],
      newIds: [],
    });
    expect(msg).toContain("Change: 0 Wallets (0.00%)");
    expect(msg).toContain("0 Missing Wallets since End of last month");
    expect(msg).toContain("0 New Wallets");
  });

  test("handles negative change", () => {
    const msg = buildComparisonReportMessage({
      title: "Week-over-week Wallet Report",
      prevLabel: "End of last week",
      prevDate: "2026-04-26",
      prevCount: 100,
      currLabel: "Current",
      currCount: 90,
      targetWalletLabel: "30506525",
      missingIds: [],
      newIds: [],
    });
    expect(msg).toContain("Change: -10 Wallets (-10.00%)");
  });
});

describe("snapshot storage", () => {
  test("insertMany stores wallets and dedupes by client_id", async () => {
    await insertMany(db, idA, [
      { snapshotDate: "2026-04-25", clientId: 10023, name: "Alice", email: "alice@test.com" },
      { snapshotDate: "2026-04-25", clientId: 10031, name: "Charlie", email: null },
    ]);
    await insertMany(db, idA, [
      { snapshotDate: "2026-04-26", clientId: 10023, name: "Alice", email: "alice@test.com" },
      { snapshotDate: "2026-04-26", clientId: 10024, name: "Bob", email: null },
    ]);
    // Same wallet under tenant B must not leak into A's counts.
    await insertMany(db, idB, [
      { snapshotDate: "2026-04-26", clientId: 10023, name: "Alice", email: null },
    ]);

    expect(await countByDate(db, idA, "2026-04-25")).toBe(2);
    expect(await countByDate(db, idA, "2026-04-26")).toBe(2);
    expect(await countByDate(db, idB, "2026-04-26")).toBe(1);
  });
});

const mockClientRows: HFMClientRow[] = [
  {
    id: 78451293,
    wallet: 10023,
    type: "Standard",
    last_trade: "2026-04-25 10:00:00",
    volume: "3.42",
    balance: 12450.8,
    commission: 34.2,
    account_currency: "USD",
    country: "Thailand",
    rebates_paid: 0,
    rebates_unpaid: 0,
    rebates_rejected: 0,
    first_trade: "2024-01-15 10:00:00",
    first_funding: "2024-01-15 10:00:00",
    registration: "2024-01-15T00:00:00Z",
    server: 5,
    platform: "MT4",
    conversion_device: "Mobile Browser",
    deposits: 12450.8,
    withdrawals: 0,
    name: "Somchai Jaidee",
    email: "somchai@test.com",
    equity: 12998.35,
    margin: 100,
    free_margin: 12898.35,
  },
  {
    id: 99001234,
    wallet: 10024,
    type: "Standard",
    last_trade: null,
    volume: "0",
    balance: 500,
    commission: 0,
    account_currency: "USD",
    country: "Thailand",
    rebates_paid: 0,
    rebates_unpaid: 0,
    rebates_rejected: 0,
    first_trade: null,
    first_funding: "2024-03-20 10:00:00",
    registration: "2024-03-20T00:00:00Z",
    server: 5,
    platform: "MT4",
    conversion_device: "Mobile Browser",
    deposits: 500,
    withdrawals: 0,
    name: "Malee Srisuk",
    email: "malee@test.com",
    equity: 500,
    margin: 0,
    free_margin: 500,
  },
];

function mockFetchClients(rows: HFMClientRow[]): () => Promise<HFMClientsResult> {
  return async () => ({ ok: true as const, data: rows });
}

function makeClientRows(wallets: number[]): HFMClientRow[] {
  return wallets.map((w, i) => ({
    id: 1000 + i,
    wallet: w,
    type: "Standard",
    last_trade: null,
    volume: "0",
    balance: 0,
    commission: 0,
    account_currency: "USD",
    country: "Thailand",
    rebates_paid: 0,
    rebates_unpaid: 0,
    rebates_rejected: 0,
    first_trade: null,
    first_funding: null,
    registration: "2024-01-15T00:00:00Z",
    server: 5,
    platform: "MT4",
    conversion_device: "Mobile Browser",
    deposits: 0,
    withdrawals: 0,
    name: `Client ${w}`,
    email: `client${w}@test.com`,
    equity: 0,
    margin: 0,
    free_margin: 0,
  }));
}

function snapshotInput(date: string, clientId: number) {
  return { snapshotDate: date, clientId, name: `Client ${clientId}`, email: null };
}

describe("request-snapshot repository", () => {
  test("insertRequestSnapshot and getLatestRequestSnapshotBefore work", async () => {
    const rows = makeClientRows([100, 200, 300]);
    await insertRequestSnapshot(db, idA, "2026-04-26", rows);

    const latest = await getLatestRequestSnapshotBefore(db, idA, "2026-04-27");
    expect(latest).not.toBeNull();
    expect(latest!.rows.length).toBe(3);
    expect(latest!.snapshotDate).toBe("2026-04-26");

    // Tenant B sees none of tenant A's request snapshots.
    expect(await getLatestRequestSnapshotBefore(db, idB, "2026-04-27")).toBeNull();

    const missing = findMissingWalletIds(latest!.rows, []);
    expect(missing).toEqual([100, 200, 300]);

    await insertRequestSnapshot(db, idA, "2026-04-27", makeClientRows([100, 200, 400]));
    const latest2 = (await getLatestRequestSnapshotBefore(db, idA, "2026-04-28"))!;

    const missing2 = findMissingWalletIds(latest!.rows, latest2.rows);
    expect(missing2).toEqual([300]);

    const newIds = findNewWalletIds(latest!.rows, latest2.rows);
    expect(newIds).toEqual([400]);
  });

  test("getLatestRequestSnapshotBefore returns null when none exists", async () => {
    const result = await getLatestRequestSnapshotBefore(db, idA, "2026-04-26");
    expect(result).toBeNull();
  });
});

describe("generateReportForUser", () => {
  test("day report returns not-found when no yesterday snapshot", async () => {
    const messages = await generateReportForUser(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("was not found");
  });

  test("day report returns comparison when yesterday snapshot exists", async () => {
    await insertMany(db, idA, [
      snapshotInput("2026-04-25", 10023),
      snapshotInput("2026-04-25", 10024),
    ]);

    const messages = await generateReportForUser(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("Daily Wallet Report");
    expect(messages[0]!).toContain("Wallet under 111");
    expect(messages[0]!).toContain("2 Wallets");
  });

  test("day report returns 2 messages when previous request snapshot exists", async () => {
    await insertMany(db, idA, [
      snapshotInput("2026-04-25", 10023),
      snapshotInput("2026-04-25", 10024),
    ]);

    await generateReportForUser(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    const messages = await generateReportForUser(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]!).toContain("Daily Wallet Report");
    expect(messages[1]!).toContain("Since Last Request");
  });

  test("week report returns not-found when no baseline snapshot", async () => {
    const messages = await generateReportForUser(ctxA, {
      now: new Date("2026-04-29T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "week",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("was not found");
  });

  test("week report returns comparison when baseline exists", async () => {
    const now = new Date("2026-04-29T22:00:00.000Z");
    const lastWeek = getLastWeekRange(now);
    await insertMany(db, idA, [
      snapshotInput(lastWeek.to, 10023),
      snapshotInput(lastWeek.to, 10024),
    ]);

    const messages = await generateReportForUser(ctxA, {
      now,
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "week",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("Week-over-week Wallet Report");
    expect(messages[0]!).toContain("2 Wallets");
  });

  test("month report returns not-found when no baseline snapshot", async () => {
    const messages = await generateReportForUser(ctxA, {
      now: new Date("2026-04-29T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "month",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("was not found");
  });

  test("month report returns comparison when baseline exists", async () => {
    const now = new Date("2026-04-29T22:00:00.000Z");
    const lastMonth = getLastMonthRange(now);
    await insertMany(db, idA, [
      snapshotInput(lastMonth.to, 10023),
      snapshotInput(lastMonth.to, 10024),
    ]);

    const messages = await generateReportForUser(ctxA, {
      now,
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "month",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("Month-over-month Wallet Report");
  });
});

describe("cross-tenant isolation", () => {
  test("two tenants with different wallets produce different reports on the same date", async () => {
    // ctxA.targetWallet = 111, ctxB.targetWallet = 222
    // the stubbed fetch returns a different client set per tenant
    await insertMany(db, idA, [
      snapshotInput("2026-09-05", 111001),
      snapshotInput("2026-09-05", 111002),
    ]);
    await insertMany(db, idB, [
      snapshotInput("2026-09-05", 222001),
      snapshotInput("2026-09-05", 222002),
      snapshotInput("2026-09-05", 222003),
    ]);

    const now = new Date("2026-09-06T10:00:00.000Z");
    const a = await generateReportForUser(ctxA, {
      now,
      db,
      fetchClientsFn: mockFetchClients(makeClientRows([111001, 111002])),
      reportPeriod: "day",
    });
    const b = await generateReportForUser(ctxB, {
      now,
      db,
      fetchClientsFn: mockFetchClients(makeClientRows([222001, 222002, 222003])),
      reportPeriod: "day",
    });

    expect(a.join(" ")).toContain("111");
    expect(a.join(" ")).not.toContain("222");
    expect(b.join(" ")).toContain("222");
  });

  test("daily_report_notifications for A does not suppress B", async () => {
    await markDailyReportSent(db, idA, "2026-09-05");
    expect(await isDailyReportSent(db, idB, "2026-09-05")).toBe(false);
    expect(await isDailyReportSent(db, idA, "2026-09-05")).toBe(true);
  });

  test("runDailyClientReport pushes each tenant only its own report to its own recipients", async () => {
    await addRecipient(db, idA, "UrecA", null);
    await addRecipient(db, idB, "UrecB", null);

    await insertMany(db, idA, [snapshotInput("2026-09-05", 111001)]);
    await insertMany(db, idB, [snapshotInput("2026-09-05", 222001)]);

    const now = new Date("2026-09-06T10:00:00.000Z");
    const pushes: { tenant: string; uids: string[]; text: string }[] = [];
    const pushFor = (tenant: string) => async (uids: string[], text: string) => {
      pushes.push({ tenant, uids, text });
    };

    await runDailyClientReport(ctxA, {
      now,
      db,
      fetchClientsFn: mockFetchClients(makeClientRows([111001, 111009])),
      pushToAllFn: pushFor("A"),
    });
    await runDailyClientReport(ctxB, {
      now,
      db,
      fetchClientsFn: mockFetchClients(makeClientRows([222001])),
      pushToAllFn: pushFor("B"),
    });

    expect(pushes).toHaveLength(2);
    expect(pushes[0]!.tenant).toBe("A");
    expect(pushes[0]!.uids).toEqual(["UrecA"]);
    expect(pushes[0]!.text).toContain("111");
    expect(pushes[0]!.text).not.toContain("222");
    expect(pushes[1]!.tenant).toBe("B");
    expect(pushes[1]!.uids).toEqual(["UrecB"]);
    expect(pushes[1]!.text).toContain("222");
  });
});

describe("runDailyClientReport", () => {
  test("first run stores snapshot and skips notification when no yesterday", async () => {
    await addRecipient(db, idA, "Utest001", null);

    let pushedMessage = "";
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushedMessage).toBe("");
    expect(await countByDate(db, idA, "2026-04-26")).toBe(2);
  });

  test("second day sends comparison report", async () => {
    await addRecipient(db, idA, "Utest001", null);

    let pushedMessage = "";
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(await countByDate(db, idA, "2026-04-26")).toBe(2);

    const day2Clients: HFMClientRow[] = [
      mockClientRows[0]!,
      {
        ...mockClientRows[1]!,
        wallet: 99999,
        name: "Brand New Client",
      },
    ];

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(day2Clients),
      pushToAllFn: mockPushAll,
    });

    expect(pushedMessage).toContain("Daily Wallet Report");
    expect(pushedMessage).toContain("Missing Wallets since Yesterday");
  });

  test("idempotent - second run for same date skips", async () => {
    await addRecipient(db, idA, "Utest001", null);

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: async () => {},
    });

    let pushCount = 0;
    const mockPushAll = async () => { pushCount++; };

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushCount).toBe(1);

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushCount).toBe(1);
  });

  test("does not throw when HFM fetch fails after retries", async () => {
    await addRecipient(db, idA, "Utest001", null);

    let calls = 0;
    const mockFetchFail = async () => {
      calls++;
      return { ok: false as const, reason: "server_error" as const };
    };
    const mockPushAll = async () => {};

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchFail,
      pushToAllFn: mockPushAll,
    });

    expect(calls).toBe(3);
    const today = getIctDateString(new Date("2026-04-25T22:00:00.000Z"));
    expect(await countByDate(db, idA, today)).toBe(0);
  }, 30_000);

  test("warns but does not throw when no active recipients", async () => {
    let pushCalled = false;
    const mockPushAll = async () => { pushCalled = true; };

    await runDailyClientReport(ctxA, {
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushCalled).toBe(false);
    expect(await countByDate(db, idA, "2026-04-26")).toBe(2);
  });
});
