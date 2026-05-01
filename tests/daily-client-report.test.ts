import { expect, test, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { insertMany, getByDate, diffCounts, getAddedClients, getMissingClients } from "../src/repositories/snapshot.repository";
import { seedFromEnv } from "../src/repositories/recipient.repository";
import {
  insertRequestSnapshot,
  getLatestRequestSnapshotBefore,
  findMissingWalletIds,
  findNewWalletIds,
} from "../src/repositories/request-snapshot.repository";
import {
  buildDayReportMessage,
  buildComparisonReportMessage,
  generateReportForUser,
  runDailyClientReport,
  type ReportPeriod,
} from "../src/jobs/daily-client-report";
import { getLastWeekRange, getLastMonthRange } from "../src/utils/date";
import type { HFMPerformanceData, HFMClientRow, HFMClientsResult } from "../src/types/hfm.types";

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

describe("SQL-based diff", () => {
  test("diffCounts, getAddedClients, getMissingClients work correctly", () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const clientA: HFMPerformanceData = {
      client_id: 10023, account_id: 78451293, activity_status: "active",
      trades: 0, volume: 0, account_type: "Standard", balance: 0,
      account_currency: "USD", equity: 0, archived: null, subaffiliate: 0,
      account_regdate: "2024-01-15T00:00:00Z", status: "approved", full_name: "Alice",
    };
    const clientB: HFMPerformanceData = {
      ...clientA, client_id: 10024, account_id: 99001234, full_name: "Bob",
    };
    const clientC: HFMPerformanceData = {
      ...clientA, client_id: 10031, account_id: 88123456, full_name: "Charlie",
    };

    insertMany(db, "2026-04-25", [clientA, clientC]);
    insertMany(db, "2026-04-26", [clientA, clientB]);

    const counts = diffCounts(db, "2026-04-26", "2026-04-25");
    expect(counts.added).toBe(1);
    expect(counts.missing).toBe(1);

    const added = getAddedClients(db, "2026-04-26", "2026-04-25", 10);
    expect(added).toHaveLength(1);
    expect(added[0]!.full_name).toBe("Bob");

    const missing = getMissingClients(db, "2026-04-26", "2026-04-25", 10);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.full_name).toBe("Charlie");
  });

  test("diffCounts returns zeros for identical snapshots", () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const client: HFMPerformanceData = {
      client_id: 10023, account_id: 78451293, activity_status: "active",
      trades: 0, volume: 0, account_type: "Standard", balance: 0,
      account_currency: "USD", equity: 0, archived: null, subaffiliate: 0,
      account_regdate: "2024-01-15T00:00:00Z", status: "approved", full_name: "Alice",
    };

    insertMany(db, "2026-04-25", [client]);
    insertMany(db, "2026-04-26", [client]);

    const counts = diffCounts(db, "2026-04-26", "2026-04-25");
    expect(counts.added).toBe(0);
    expect(counts.missing).toBe(0);
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

describe("request-snapshot repository", () => {
  test("insertRequestSnapshot and getLatestRequestSnapshotBefore work", () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const rows = makeClientRows([100, 200, 300]);
    insertRequestSnapshot(db, "2026-04-26", rows);

    const latest = getLatestRequestSnapshotBefore(db, "2026-04-27");
    expect(latest).not.toBeNull();
    expect(latest!.length).toBe(3);

    const missing = findMissingWalletIds(latest!, []);
    expect(missing).toEqual([100, 200, 300]);

    insertRequestSnapshot(db, "2026-04-27", makeClientRows([100, 200, 400]));
    const latest2 = getLatestRequestSnapshotBefore(db, "2026-04-28")!;

    const missing2 = findMissingWalletIds(latest!, latest2);
    expect(missing2).toEqual([300]);

    const newIds = findNewWalletIds(latest!, latest2);
    expect(newIds).toEqual([400]);
  });

  test("getLatestRequestSnapshotBefore returns null when none exists", () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const result = getLatestRequestSnapshotBefore(db, "2026-04-26");
    expect(result).toBeNull();
  });
});

describe("generateReportForUser", () => {
  afterEach(() => {
    delete process.env.TARGET_WALLET;
  });

  test("day report returns not-found when no yesterday snapshot", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const messages = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("was not found");
  });

  test("day report returns comparison when yesterday snapshot exists", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const { normalizeClientRow } = await import("../src/services/hfm.service");
    const normalized = mockClientRows.map(normalizeClientRow);
    insertMany(db, "2026-04-25", normalized);

    const messages = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("Daily Wallet Report");
    expect(messages[0]!).toContain("2 Wallets");
  });

  test("day report returns 2 messages when previous request snapshot exists", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const { normalizeClientRow } = await import("../src/services/hfm.service");
    const normalized = mockClientRows.map(normalizeClientRow);
    insertMany(db, "2026-04-25", normalized);

    await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "day",
    });

    const messages = await generateReportForUser({
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
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const messages = await generateReportForUser({
      now: new Date("2026-04-29T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "week",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("was not found");
  });

  test("week report returns comparison when baseline exists", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const { normalizeClientRow } = await import("../src/services/hfm.service");
    const normalized = mockClientRows.map(normalizeClientRow);
    const now = new Date("2026-04-29T22:00:00.000Z");
    const lastWeek = getLastWeekRange(now);
    insertMany(db, lastWeek.to, normalized);

    const messages = await generateReportForUser({
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
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const messages = await generateReportForUser({
      now: new Date("2026-04-29T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "month",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("was not found");
  });

  test("month report returns comparison when baseline exists", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const { normalizeClientRow } = await import("../src/services/hfm.service");
    const normalized = mockClientRows.map(normalizeClientRow);
    const now = new Date("2026-04-29T22:00:00.000Z");
    const lastMonth = getLastMonthRange(now);
    insertMany(db, lastMonth.to, normalized);

    const messages = await generateReportForUser({
      now,
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      reportPeriod: "month",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toContain("Month-over-month Wallet Report");
  });
});

describe("runDailyClientReport", () => {
  afterEach(() => {
    delete process.env.TARGET_WALLET;
  });

  test("first run stores snapshot and skips notification when no yesterday", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    let pushedMessage = "";
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushedMessage).toBe("");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });

  test("second day sends comparison report", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    let pushedMessage = "";
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };

    const { normalizeClientRow } = await import("../src/services/hfm.service");
    const normalized = mockClientRows.map(normalizeClientRow);

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(getByDate(db, "2026-04-26")).toHaveLength(2);

    const day2Clients: HFMClientRow[] = [
      mockClientRows[0]!,
      {
        ...mockClientRows[1]!,
        wallet: 99999,
        name: "Brand New Client",
      },
    ];

    await runDailyClientReport({
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(day2Clients),
      pushToAllFn: mockPushAll,
    });

    expect(pushedMessage).toContain("Daily Wallet Report");
    expect(pushedMessage).toContain("Missing Wallets since Yesterday");
  });

  test("idempotent - second run for same date skips", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: async () => {},
    });

    let pushCount = 0;
    const mockPushAll = async () => { pushCount++; };

    await runDailyClientReport({
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushCount).toBe(1);

    await runDailyClientReport({
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    expect(pushCount).toBe(1);
  });

  test("throws when HFM fetch fails", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchFail = async () => ({ ok: false as const, reason: "server_error" as const });
    const mockPushAll = async () => {};

    await expect(
      runDailyClientReport({
        now: new Date("2026-04-25T22:00:00.000Z"),
        db,
        fetchClientsFn: mockFetchFail,
        pushToAllFn: mockPushAll,
      })
    ).rejects.toThrow("HFM fetchClients failed: server_error");
  });

  test("warns but does not throw when no active recipients", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    let pushCalled = false;
    const mockPushAll = async () => { pushCalled = true; };

    const originalNotifyUids = process.env.LINE_NOTIFY_UIDS;
    process.env.LINE_NOTIFY_UIDS = "";

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchClients(mockClientRows),
      pushToAllFn: mockPushAll,
    });

    process.env.LINE_NOTIFY_UIDS = originalNotifyUids;

    expect(pushCalled).toBe(false);
    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });
});
