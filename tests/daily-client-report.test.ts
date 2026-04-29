import { expect, test, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { insertMany, getByDate, diffCounts, getAddedClients, getMissingClients } from "../src/repositories/snapshot.repository";
import { seedFromEnv } from "../src/repositories/recipient.repository";
import { buildWeeklyReportMessage, generateReportForUser, runDailyClientReport } from "../src/jobs/daily-client-report";
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
    });
    expect(message).toBe(
      "26/04/26 : Total Wallet under 30506525 : 1125 Wallets\n" +
      "27/04/26 : Total Wallet under 30506525 : 1120 Wallets\n" +
      "2 Missing Wallet today\n" +
      "-6503256\n" +
      "-6520562"
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
    });
    expect(message).toBe(
      "26/04/26 : Total Wallet under 30506525 : 500 Wallets\n" +
      "0 Missing Wallet today"
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
    });
    expect(message).toBe(
      "26/04/26 : Total Wallet under N/A : 42 Wallets\n" +
      "1 Missing Wallet today\n" +
      "-12345"
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
    });
    expect(message).toBe(
      "25/04/26 : Total Wallet under 30506525 : 0 Wallets\n" +
      "26/04/26 : Total Wallet under 30506525 : 100 Wallets\n" +
      "0 Missing Wallet today"
    );
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

describe("runDailyClientReport", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.TARGET_WALLET;
  });

  test("first run stores snapshot and sends weekly report", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    let pushedMessage = "";
    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
    });

    expect(pushedMessage).toContain("Total Wallet under 30506525 : 2 Wallets");
    expect(pushedMessage).toContain("0 Missing Wallet today");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });

  test("idempotent — second run for same date skips", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    let pushCount = 0;
    const mockPushAll = async () => { pushCount++; };

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
    });

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
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

    await expect(
      runDailyClientReport({
        now: new Date("2026-04-25T22:00:00.000Z"),
        db,
        fetchAllClientsFn: mockFetchAll,
        pushToAllFn: async () => {
          throw new Error("LINE unavailable");
        },
      })
    ).rejects.toThrow("LINE unavailable");

    expect(getByDate(db, "2026-04-26")).toHaveLength(2);

    let pushedMessage = "";
    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: async (_uids: string[], text: string) => { pushedMessage = text; },
    });

    expect(fetchCount).toBe(1);
    expect(pushedMessage).toContain("Total Wallet under 30506525");
  });

  test("second day shows missing wallet IDs in weekly format", async () => {
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

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: async () => ({ ok: true as const, data: day1Clients }),
      pushToAllFn: mockPushAll,
    });

    await runDailyClientReport({
      now: new Date("2026-04-26T22:00:00.000Z"),
      db,
      fetchAllClientsFn: async () => ({ ok: true as const, data: day2Clients }),
      pushToAllFn: mockPushAll,
    });

    expect(messages[1]).toContain("Total Wallet under 30506525");
    expect(messages[1]).toContain("1 Missing Wallet today");
    expect(messages[1]).toContain("-10024");
  });

  test("purges old snapshots after insert", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async () => { };

    await runDailyClientReport({
      now: new Date("2026-01-01T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
    });

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
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

    const originalNotifyUids = process.env.LINE_NOTIFY_UIDS;
    process.env.LINE_NOTIFY_UIDS = "";

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
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

  test("generates report without marking notification sent", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
    });

    expect(message).toContain("Total Wallet under 30506525 : 2 Wallets");
    expect(message).toContain("0 Missing Wallet today");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);

    const sent = db
      .query("SELECT COUNT(*) as count FROM daily_report_notifications WHERE snapshot_date = $date")
      .get({ date: "2026-04-26" }) as { count: number };
    expect(sent.count).toBe(0);
  });

  test("generates report from existing snapshot without refetching", async () => {
    process.env.TARGET_WALLET = "30506525";
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);

    let fetchCount = 0;
    const mockFetchAll = async () => {
      fetchCount++;
      return { ok: true as const, data: mockClientsResponse };
    };

    await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
    });

    const message = await generateReportForUser({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
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
  });
});
