import { expect, test, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { insertMany, getByDate, diffCounts, getAddedClients, getMissingClients } from "../src/repositories/snapshot.repository";
import { seedFromEnv } from "../src/repositories/recipient.repository";
import { buildWeeklyReportMessage, buildComparisonReportMessage, generateReportForUser, runDailyClientReport, type ReportPeriod } from "../src/jobs/daily-client-report";
import { getThisWeekRange, getLastWeekRange, getThisMonthRange, getLastMonthRange } from "../src/utils/date";
import type { HFMPerformanceData, HFMClientsPerformanceResponse } from "../src/types/hfm.types";

describe("buildWeeklyReportMessage", () => {
  test("formats weekly summary with missing wallets", () => {
    const dates = ["2026-04-26", "2026-04-27"];
    const dateCounts = new Map<string, number>([
      ["2026-04-26", 1125],
      ["2026-04-27", 1120],
    ]);
    const message = buildWeeklyReportMessage({
      dates,
      dateCounts,
      targetWalletLabel: "30506525",
      missingWalletIds: [6503256, 6520562],
      newWalletCount: 3,
    });
    expect(message).toBe(
      "26/04/26 : Total Wallet under 30506525 : 1125 Wallets\n" +
      "27/04/26 : Total Wallet under 30506525 : 1120 Wallets\n" +
      "2 Missing Wallet today\n" +
      "-6503256\n" +
      "-6520562\n" +
      "3 New Wallets today"
    );
  });

  test("formats zero missing wallets", () => {
    const dates = ["2026-04-26"];
    const dateCounts = new Map<string, number>([["2026-04-26", 500]]);
    const message = buildWeeklyReportMessage({
      dates,
      dateCounts,
      targetWalletLabel: "30506525",
      missingWalletIds: [],
      newWalletCount: 0,
    });
    expect(message).toBe(
      "26/04/26 : Total Wallet under 30506525 : 500 Wallets\n" +
      "0 Missing Wallet today\n" +
      "0 New Wallets today"
    );
  });

  test("formats single date report", () => {
    const dates = ["2026-04-26"];
    const dateCounts = new Map<string, number>([["2026-04-26", 42]]);
    const message = buildWeeklyReportMessage({
      dates,
      dateCounts,
      targetWalletLabel: "N/A",
      missingWalletIds: [12345],
      newWalletCount: 0,
    });
    expect(message).toBe(
      "26/04/26 : Total Wallet under N/A : 42 Wallets\n" +
      "1 Missing Wallet today\n" +
      "-12345\n" +
      "0 New Wallets today"
    );
  });

  test("handles dates with zero count", () => {
    const dates = ["2026-04-25", "2026-04-26"];
    const dateCounts = new Map<string, number>([["2026-04-26", 100]]);
    const message = buildWeeklyReportMessage({
      dates,
      dateCounts,
      targetWalletLabel: "30506525",
      missingWalletIds: [],
      newWalletCount: 0,
    });
    expect(message).toBe(
      "25/04/26 : Total Wallet under 30506525 : 0 Wallets\n" +
      "26/04/26 : Total Wallet under 30506525 : 100 Wallets\n" +
      "0 Missing Wallet today\n" +
      "0 New Wallets today"
    );
  });
});

describe("buildComparisonReportMessage", () => {
  test("formats week comparison with change", () => {
    const msg = buildComparisonReportMessage({
      title: "Week-over-week Wallet Report",
      prevLabel: "Last week",
      prevFrom: "2026-04-20",
      prevTo: "2026-04-26",
      prevCount: 100,
      currLabel: "This week",
      currFrom: "2026-04-27",
      currTo: "2026-04-30",
      currCount: 120,
      targetWalletLabel: "30506525",
      missingIds: [12345],
      newIds: [99999, 88888],
    });
    expect(msg).toContain("Week-over-week Wallet Report");
    expect(msg).toContain("Last week (20/04/26 - 26/04/26): 100 Wallets");
    expect(msg).toContain("This week (27/04/26 - 30/04/26): 120 Wallets");
    expect(msg).toContain("Change: +20 Wallets (+20.00%)");
    expect(msg).toContain("1 Missing Wallets since Last week");
    expect(msg).toContain("-12345");
    expect(msg).toContain("2 New Wallets in This week");
  });

  test("shows zero change", () => {
    const msg = buildComparisonReportMessage({
      title: "Month-over-month Wallet Report",
      prevLabel: "Last month",
      prevFrom: "2026-03-01",
      prevTo: "2026-03-31",
      prevCount: 50,
      currLabel: "This month",
      currFrom: "2026-04-01",
      currTo: "2026-04-30",
      currCount: 50,
      targetWalletLabel: "30506525",
      missingIds: [],
      newIds: [],
    });
    expect(msg).toContain("Change: 0 Wallets (0.00%)");
    expect(msg).toContain("0 Missing Wallets since Last month");
    expect(msg).toContain("0 New Wallets in This month");
  });

  test("handles negative change", () => {
    const msg = buildComparisonReportMessage({
      title: "Week-over-week Wallet Report",
      prevLabel: "Last week",
      prevFrom: "2026-04-20",
      prevTo: "2026-04-26",
      prevCount: 100,
      currLabel: "This week",
      currFrom: "2026-04-27",
      currTo: "2026-04-30",
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

  test("diffCounts returns zeros when yesterday is empty", () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const client: HFMPerformanceData = {
      client_id: 10023, account_id: 78451293, activity_status: "active",
      trades: 0, volume: 0, account_type: "Standard", balance: 0,
      account_currency: "USD", equity: 0, archived: null, subaffiliate: 0,
      account_regdate: "2024-01-15T00:00:00Z", status: "approved", full_name: "Alice",
    };

    insertMany(db, "2026-04-26", [client]);

    const counts = diffCounts(db, "2026-04-26", "2026-04-25");
    expect(counts.added).toBe(1);
    expect(counts.missing).toBe(0);
  });
});

const mockClientsResponse: HFMClientsPerformanceResponse = {
  clients: [
    {
      client_id: 10023,
      account_id: 78451293,
      activity_status: "active",
      trades: 24,
      volume: 3.42,
      account_type: "Standard",
      balance: 12450.8,
      account_currency: "USD",
      equity: 12998.35,
      archived: null,
      subaffiliate: 30506525,
      account_regdate: "2024-01-15T00:00:00Z",
      status: "approved",
      full_name: "Somchai Jaidee",
    },
    {
      client_id: 10024,
      account_id: 99001234,
      activity_status: "active",
      trades: 0,
      volume: 0,
      account_type: "Standard",
      balance: 500,
      account_currency: "USD",
      equity: 500,
      archived: null,
      subaffiliate: 30506525,
      account_regdate: "2024-03-20T00:00:00Z",
      status: "approved",
      full_name: "Malee Srisuk",
    },
  ],
  totals: {
    clients: 2,
    accounts: 2,
    volume: 3.42,
    balance: 12950.8,
    withdrawals: 0,
    commission: 34.2,
  },
};

function makeRangeResponse(clients: HFMPerformanceData[]): HFMClientsPerformanceResponse {
  return {
    clients,
    totals: {
      clients: clients.length,
      accounts: clients.length,
      volume: 0,
      balance: 0,
      withdrawals: 0,
      commission: 0,
    },
  };
}

describe("runDailyClientReport", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.TARGET_WALLET;
  });

  test("first run stores snapshot and sends daily report", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    let pushedMessage = "";
    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    expect(pushedMessage).toContain("Total Wallet under 30506525 : 2 Wallets");
    expect(pushedMessage).toContain("0 Missing Wallet today");
    expect(pushedMessage).toContain("0 New Wallets today");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });

  test("idempotent — second run for same date skips", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });
    let pushCount = 0;
    const mockPushAll = async () => { pushCount++; };

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    expect(pushCount).toBe(1);
    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });

  test("retries notification when snapshot exists but previous push failed", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    let fetchCount = 0;
    const mockFetchAll = async () => {
      fetchCount++;
      return { ok: true as const, data: mockClientsResponse };
    };
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    await expect(
      runDailyClientReport({
        now: new Date("2026-04-25T22:00:00.000Z"),
        db,
        fetchAllClientsFn: mockFetchAll,
        pushToAllFn: async () => {
          throw new Error("LINE unavailable");
        },
        fetchByRangeFn: mockFetchByRange,
      })
    ).rejects.toThrow("LINE unavailable");

    expect(getByDate(db, "2026-04-26")).toHaveLength(2);

    let pushedMessage = "";
    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: async (_uids: string[], text: string) => { pushedMessage = text; },
      fetchByRangeFn: mockFetchByRange,
    });

    expect(fetchCount).toBe(1);
    expect(pushedMessage).toContain("Total Wallet under 30506525");
  });

  test("second day shows missing wallet IDs in daily format", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const day1Clients: HFMClientsPerformanceResponse = {
      clients: [
        { ...mockClientsResponse.clients[0]! },
        { ...mockClientsResponse.clients[1]!, full_name: "To Be Removed" },
      ],
      totals: mockClientsResponse.totals,
    };

    const day2Clients: HFMClientsPerformanceResponse = {
      clients: [
        { ...mockClientsResponse.clients[0]!, full_name: "Still Here" },
        {
          client_id: 99999,
          account_id: 11111,
          activity_status: "active",
          trades: 0,
          volume: 0,
          account_type: "Standard",
          balance: 300,
          account_currency: "USD",
          equity: 300,
          archived: null,
          subaffiliate: 30506525,
          account_regdate: "2026-04-26T00:00:00Z",
          status: "approved",
          full_name: "Brand New Client",
        },
      ],
      totals: mockClientsResponse.totals,
    };

    const messages: string[] = [];
    const mockPushAll = async (_uids: string[], text: string) => { messages.push(text); };
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: async () => ({ ok: true as const, data: day1Clients }),
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    await runDailyClientReport({
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchAllClientsFn: async () => ({ ok: true as const, data: day2Clients }),
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    expect(messages[1]).toContain("Total Wallet under 30506525");
    expect(messages[1]).toContain("1 Missing Wallet today");
    expect(messages[1]).toContain("-10024");
    expect(messages[1]).toContain("1 New Wallets today");
  });

  test("purges old snapshots after insert", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async () => { };
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    await runDailyClientReport({
      now: new Date("2026-01-01T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    const oldRows = getByDate(db, "2026-01-02");
    expect(oldRows).toHaveLength(0);

    const todayRows = getByDate(db, "2026-04-26");
    expect(todayRows).toHaveLength(2);
  });

  test("throws when HFM fetch fails", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: false as const, reason: "server_error" as const });
    const mockPushAll = async () => { };

    await expect(
      runDailyClientReport({
        now: new Date("2026-04-25T22:00:00.000Z"),
        db,
        fetchAllClientsFn: mockFetchAll,
        pushToAllFn: mockPushAll,
      })
    ).rejects.toThrow("HFM fetchAllClients failed: server_error");
  });

  test("warns but does not throw when no active recipients", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    let pushCalled = false;
    const mockPushAll = async () => { pushCalled = true; };
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    const originalNotifyUids = process.env.LINE_NOTIFY_UIDS;
    process.env.LINE_NOTIFY_UIDS = "";

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
      fetchByRangeFn: mockFetchByRange,
    });

    process.env.LINE_NOTIFY_UIDS = originalNotifyUids;

    expect(pushCalled).toBe(false);
    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });
});

describe("generateReportForUser", () => {
  afterEach(() => {
    delete process.env.TARGET_WALLET;
  });

  test("generates day report without marking notification sent", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      fetchByRangeFn: mockFetchByRange,
    });

    expect(message).toContain("Total Wallet under 30506525 : 2 Wallets");
    expect(message).toContain("0 Missing Wallet today");
    expect(message).toContain("0 New Wallets today");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);

    const sent = db
      .query("SELECT COUNT(*) as count FROM daily_report_notifications WHERE snapshot_date = $date")
      .get({ date: "2026-04-26" }) as { count: number };
    expect(sent.count).toBe(0);
  });

  test("generates day report from existing snapshot without refetching", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    let fetchCount = 0;
    const mockFetchAll = async () => {
      fetchCount++;
      return { ok: true as const, data: mockClientsResponse };
    };
    const mockFetchByRange = async () => ({ ok: true as const, data: makeRangeResponse(mockClientsResponse.clients) });

    await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      fetchByRangeFn: mockFetchByRange,
    });

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      fetchByRangeFn: mockFetchByRange,
    });

    expect(fetchCount).toBe(1);
    expect(message).toContain("Total Wallet under 30506525 : 2 Wallets");
  });

  test("shows missing wallet IDs when yesterday snapshot exists", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const twoClients: HFMPerformanceData[] = [
      {
        client_id: 10023, account_id: 78451293, activity_status: "active",
        trades: 24, volume: 3.42, account_type: "Standard", balance: 12450.8,
        account_currency: "USD", equity: 12998.35, archived: null,
        subaffiliate: 30506525, account_regdate: "2024-01-15T00:00:00Z",
        status: "approved", full_name: "Client A",
      },
      {
        client_id: 10024, account_id: 99001234, activity_status: "active",
        trades: 0, volume: 0, account_type: "Standard", balance: 500,
        account_currency: "USD", equity: 500, archived: null,
        subaffiliate: 30506525, account_regdate: "2024-03-20T00:00:00Z",
        status: "approved", full_name: "Client B",
      },
    ];

    insertMany(db, "2026-04-25", twoClients);
    insertMany(db, "2026-04-26", [twoClients[0]!]);

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
    });

    expect(message).toContain("1 Missing Wallet today");
    expect(message).toContain("-10024");
    expect(message).toContain("0 New Wallets today");
  });
});

describe("report period selection", () => {
  const baseClient: HFMPerformanceData = {
    client_id: 10023, account_id: 78451293, activity_status: "active",
    trades: 0, volume: 0, account_type: "Standard", balance: 500,
    account_currency: "USD", equity: 500, archived: null,
    subaffiliate: 30506525, account_regdate: "2024-01-15T00:00:00Z",
    status: "approved", full_name: "Test Client",
  };

  afterEach(() => {
    delete process.env.TARGET_WALLET;
  });

  test("day period returns only today snapshot", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    insertMany(db, "2026-04-20", [baseClient]);
    insertMany(db, "2026-04-25", [baseClient]);
    insertMany(db, "2026-04-26", [baseClient]);

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      reportPeriod: "day",
    });

    expect(message).not.toContain("20/04/26");
    expect(message).not.toContain("25/04/26");
    expect(message).toContain("26/04/26");
  });

  test("week period returns comparison report", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const now = new Date("2026-04-29T22:00:00.000Z");
    const lastWeek = getLastWeekRange(now);
    const thisWeek = getThisWeekRange(now);

    const prevClients: HFMPerformanceData[] = [
      { ...baseClient, client_id: 10023 },
      { ...baseClient, client_id: 10024 },
    ];
    const currClients: HFMPerformanceData[] = [
      { ...baseClient, client_id: 10023 },
      { ...baseClient, client_id: 10025 },
    ];

    const rangeCalls: Array<{ from: string; to: string }> = [];
    const mockFetchByRange = async (fromDate: string, toDate: string) => {
      rangeCalls.push({ from: fromDate, to: toDate });
      if (fromDate === lastWeek.from && toDate === lastWeek.to) {
        return { ok: true as const, data: makeRangeResponse(prevClients) };
      }
      return { ok: true as const, data: makeRangeResponse(currClients) };
    };

    const message = await generateReportForUser({
      now,
      db,
      reportPeriod: "week",
      fetchByRangeFn: mockFetchByRange,
    });

    expect(message).toContain("Week-over-week Wallet Report");
    expect(message).toContain("Last week");
    expect(message).toContain("This week");
    expect(message).toContain("2 Wallets");
    expect(rangeCalls).toHaveLength(2);
  });

  test("month period returns comparison report", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const now = new Date("2026-04-29T22:00:00.000Z");
    const lastMonth = getLastMonthRange(now);
    const thisMonth = getThisMonthRange(now);

    const prevClients: HFMPerformanceData[] = [
      { ...baseClient, client_id: 10023 },
    ];
    const currClients: HFMPerformanceData[] = [
      { ...baseClient, client_id: 10023 },
      { ...baseClient, client_id: 10024 },
      { ...baseClient, client_id: 10025 },
    ];

    const mockFetchByRange = async (fromDate: string, toDate: string) => {
      if (fromDate === lastMonth.from && toDate === lastMonth.to) {
        return { ok: true as const, data: makeRangeResponse(prevClients) };
      }
      return { ok: true as const, data: makeRangeResponse(currClients) };
    };

    const message = await generateReportForUser({
      now,
      db,
      reportPeriod: "month",
      fetchByRangeFn: mockFetchByRange,
    });

    expect(message).toContain("Month-over-month Wallet Report");
    expect(message).toContain("Last month");
    expect(message).toContain("This month");
    expect(message).toContain("1 Wallets");
    expect(message).toContain("3 Wallets");
    expect(message).toContain("Change: +2 Wallets");
  });

  test("default period is day when reportPeriod is omitted", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    insertMany(db, "2026-04-20", [baseClient]);
    insertMany(db, "2026-04-26", [baseClient]);

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
    });

    expect(message).not.toContain("20/04/26");
    expect(message).toContain("26/04/26");
  });

  test("week report uses cache on second call", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const now = new Date("2026-04-29T22:00:00.000Z");
    let rangeCallCount = 0;
    const mockFetchByRange = async () => {
      rangeCallCount++;
      return { ok: true as const, data: makeRangeResponse([baseClient]) };
    };

    await generateReportForUser({
      now,
      db,
      reportPeriod: "week",
      fetchByRangeFn: mockFetchByRange,
    });

    expect(rangeCallCount).toBe(2);

    const msg2 = await generateReportForUser({
      now,
      db,
      reportPeriod: "week",
      fetchByRangeFn: mockFetchByRange,
    });

    expect(rangeCallCount).toBe(2);
    expect(msg2).toContain("Week-over-week Wallet Report");
  });

  test("month report uses cache on second call", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const now = new Date("2026-04-29T22:00:00.000Z");
    let rangeCallCount = 0;
    const mockFetchByRange = async () => {
      rangeCallCount++;
      return { ok: true as const, data: makeRangeResponse([baseClient]) };
    };

    await generateReportForUser({
      now,
      db,
      reportPeriod: "month",
      fetchByRangeFn: mockFetchByRange,
    });

    expect(rangeCallCount).toBe(2);

    const msg2 = await generateReportForUser({
      now,
      db,
      reportPeriod: "month",
      fetchByRangeFn: mockFetchByRange,
    });

    expect(rangeCallCount).toBe(2);
    expect(msg2).toContain("Month-over-month Wallet Report");
  });
});
