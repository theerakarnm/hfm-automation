import { expect, test, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { insertMany, getByDate, diffCounts, getAddedClients, getMissingClients } from "../src/repositories/snapshot.repository";
import { seedFromEnv } from "../src/repositories/recipient.repository";
import { buildDailyClientReportMessage, runDailyClientReport } from "../src/jobs/daily-client-report";
import type { SnapshotClient, DiffCounts } from "../src/repositories/snapshot.repository";
import type { HFMPerformanceData, HFMClientsPerformanceResponse } from "../src/types/hfm.types";

function snapshotClient(
  compositeKey: string,
  fullName = "Test Client"
): SnapshotClient {
  const [accountIdStr, clientIdStr] = compositeKey.split("_");
  return {
    composite_key: compositeKey,
    account_id: Number(accountIdStr),
    client_id: Number(clientIdStr),
    full_name: fullName,
    raw: {} as HFMPerformanceData,
  };
}

const mockTotals: HFMClientsPerformanceResponse["totals"] = {
  clients: 1,
  accounts: 1,
  volume: 0,
  balance: 0,
  withdrawals: 0,
  commission: 0,
};

describe("buildDailyClientReportMessage", () => {
  test("handles no changes with selected format", () => {
    const counts: DiffCounts = { added: 0, missing: 0 };
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      totals: mockTotals,
      counts,
      addedClients: [],
      missingClients: [],
    });
    expect(message).toBe("\uD83D\uDCC5 Daily Client Report \u2014 26/04/2026\n\u2705 No changes detected.\n\uD83D\uDCCA Total Clients Today: 1");
  });

  test("handles added clients", () => {
    const counts: DiffCounts = { added: 1, missing: 0 };
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      totals: { ...mockTotals, clients: 2 },
      counts,
      addedClients: [snapshotClient("99001234_10024", "Malee Srisuk")],
      missingClients: [],
    });
    expect(message).toContain("\u2705 New Clients (1)");
    expect(message).toContain("Malee Srisuk");
    expect(message).toContain("\u274C Missing Clients (0)");
    expect(message).toContain("\uD83D\uDCCA Total Clients Today: 2");
  });

  test("handles missing clients", () => {
    const counts: DiffCounts = { added: 0, missing: 1 };
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      totals: mockTotals,
      counts,
      addedClients: [],
      missingClients: [snapshotClient("99001234_10024", "Malee Srisuk")],
    });
    expect(message).toContain("\u2705 New Clients (0)");
    expect(message).toContain("\u274C Missing Clients (1)");
    expect(message).toContain("Malee Srisuk");
  });

  test("handles both added and missing", () => {
    const counts: DiffCounts = { added: 1, missing: 1 };
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      totals: { ...mockTotals, clients: 45 },
      counts,
      addedClients: [snapshotClient("88123456_10031", "Preecha Wongsuk")],
      missingClients: [snapshotClient("78451293_10023", "Somchai Jaidee")],
    });
    expect(message).toContain("\u2705 New Clients (1)");
    expect(message).toContain("Preecha Wongsuk");
    expect(message).toContain("\u274C Missing Clients (1)");
    expect(message).toContain("Somchai Jaidee");
    expect(message).toContain("\uD83D\uDCCA Total Clients Today: 45");
  });

  test("truncates long reports under LINE limit", () => {
    const manyClients = Array.from({ length: 500 }, (_, i) =>
      snapshotClient(`9000_${i}`, `Client Name ${i}`)
    );
    const counts: DiffCounts = { added: 499, missing: 0 };
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      totals: { ...mockTotals, clients: 500 },
      counts,
      addedClients: manyClients.slice(1),
      missingClients: [],
    });
    expect(message.length).toBeLessThanOrEqual(5000);
    expect(message).toContain("Check full report.");
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

describe("runDailyClientReport", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
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
        subaffiliate: 0,
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
        subaffiliate: 0,
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

  test("first run stores baseline and sends first-run message", async () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    let pushedMessage = "";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as RequestInit)?.body as string);
      if (body.messages) {
        pushedMessage = body.messages[0].text;
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async (_uids: string[], text: string) => { pushedMessage = text; };

    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchAllClientsFn: mockFetchAll,
      pushToAllFn: mockPushAll,
    });

    expect(pushedMessage).toContain("\uD83D\uDD14 First run \u2014 baseline snapshot saved.");
    expect(pushedMessage).toContain("\uD83D\uDCCA Total Clients Today: 2");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });

  test("idempotent \u2014 second run for same date skips insert", async () => {
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
      pushToAllFn: async (_uids: string[], text: string) => {
        pushedMessage = text;
      },
    });

    expect(fetchCount).toBe(1);
    expect(pushedMessage).toContain("\uD83D\uDD14 First run \u2014 baseline snapshot saved.");
  });

  test("second day sends no-change message when clients unchanged", async () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const messages: string[] = [];
    const mockPushAll = async (_uids: string[], text: string) => { messages.push(text); };

    const day1 = new Date("2026-04-25T22:00:00.000Z");
    await runDailyClientReport({ now: day1, db, fetchAllClientsFn: mockFetchAll, pushToAllFn: mockPushAll });

    const day2 = new Date("2026-04-26T22:00:00.000Z");
    await runDailyClientReport({ now: day2, db, fetchAllClientsFn: mockFetchAll, pushToAllFn: mockPushAll });

    expect(messages[1]).toContain("\u2705 No changes detected.");
    expect(messages[1]).toContain("\uD83D\uDCCA Total Clients Today: 2");
  });

  test("second day detects added and missing clients via SQL diff", async () => {
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
          subaffiliate: 0,
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

    expect(messages[1]).toContain("\u2705 New Clients (1)");
    expect(messages[1]).toContain("Brand New Client");
    expect(messages[1]).toContain("\u274C Missing Clients (1)");
    expect(messages[1]).toContain("To Be Removed");
  });

  test("purges old snapshots after insert", async () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async () => { };

    const oldDate = new Date("2026-01-01T22:00:00.000Z");
    await runDailyClientReport({ now: oldDate, db, fetchAllClientsFn: mockFetchAll, pushToAllFn: mockPushAll });

    const today = new Date("2026-04-25T22:00:00.000Z");
    await runDailyClientReport({ now: today, db, fetchAllClientsFn: mockFetchAll, pushToAllFn: mockPushAll });

    const oldRows = getByDate(db, "2026-01-02");
    expect(oldRows).toHaveLength(0);

    const todayRows = getByDate(db, "2026-04-26");
    expect(todayRows).toHaveLength(2);
  });

  test("throws when HFM fetch fails", async () => {
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
