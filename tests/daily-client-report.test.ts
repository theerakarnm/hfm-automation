import { expect, test, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSqlite } from "../src/services/sqlite.service";
import { insertMany, getByDate } from "../src/repositories/snapshot.repository";
import { seedFromEnv, getActiveUids } from "../src/repositories/recipient.repository";
import { compareSnapshots, buildDailyClientReportMessage, runDailyClientReport } from "../src/jobs/daily-client-report";
import type { SnapshotClient } from "../src/repositories/snapshot.repository";
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
  deposits: 0,
  withdrawals: 0,
  commission: 0,
};

describe("compareSnapshots", () => {
  test("detects added and missing clients", () => {
    const today = [snapshotClient("78451293_10023"), snapshotClient("99001234_10024")];
    const yesterday = [snapshotClient("78451293_10023"), snapshotClient("88123456_10031")];
    const diff = compareSnapshots(today, yesterday);
    expect(diff.added.map((c) => c.composite_key)).toEqual(["99001234_10024"]);
    expect(diff.missing.map((c) => c.composite_key)).toEqual(["88123456_10031"]);
  });

  test("returns empty when identical", () => {
    const rows = [snapshotClient("78451293_10023")];
    const diff = compareSnapshots(rows, rows);
    expect(diff.added).toHaveLength(0);
    expect(diff.missing).toHaveLength(0);
  });
});

describe("buildDailyClientReportMessage", () => {
  test("handles first run", () => {
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      today: [snapshotClient("78451293_10023")],
      yesterday: [],
      totals: mockTotals,
    });
    expect(message).toContain("🔔 First run — baseline snapshot saved.");
    expect(message).toContain("📊 Total Clients Today: 1");
  });

  test("handles no changes with selected format", () => {
    const rows = [snapshotClient("78451293_10023")];
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      today: rows,
      yesterday: rows,
      totals: mockTotals,
    });
    expect(message).toBe("📅 Daily Client Report — 26/04/2026\n✅ No changes detected.\n📊 Total Clients Today: 1");
  });

  test("handles added clients", () => {
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      today: [
        snapshotClient("78451293_10023", "Somchai Jaidee"),
        snapshotClient("99001234_10024", "Malee Srisuk"),
      ],
      yesterday: [snapshotClient("78451293_10023", "Somchai Jaidee")],
      totals: { ...mockTotals, clients: 2 },
    });
    expect(message).toContain("✅ New Clients (1)");
    expect(message).toContain("Malee Srisuk");
    expect(message).toContain("❌ Missing Clients (0)");
    expect(message).toContain("📊 Total Clients Today: 2");
  });

  test("handles missing clients", () => {
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      today: [snapshotClient("78451293_10023", "Somchai Jaidee")],
      yesterday: [
        snapshotClient("78451293_10023", "Somchai Jaidee"),
        snapshotClient("99001234_10024", "Malee Srisuk"),
      ],
      totals: mockTotals,
    });
    expect(message).toContain("✅ New Clients (0)");
    expect(message).toContain("❌ Missing Clients (1)");
    expect(message).toContain("Malee Srisuk");
  });

  test("handles both added and missing", () => {
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      today: [
        snapshotClient("99001234_10024", "Malee Srisuk"),
        snapshotClient("88123456_10031", "Preecha Wongsuk"),
      ],
      yesterday: [
        snapshotClient("99001234_10024", "Malee Srisuk"),
        snapshotClient("78451293_10023", "Somchai Jaidee"),
      ],
      totals: { ...mockTotals, clients: 45 },
    });
    expect(message).toContain("✅ New Clients (1)");
    expect(message).toContain("Preecha Wongsuk");
    expect(message).toContain("❌ Missing Clients (1)");
    expect(message).toContain("Somchai Jaidee");
    expect(message).toContain("📊 Total Clients Today: 45");
  });

  test("build message truncates long reports under LINE limit", () => {
    const yesterday = [snapshotClient("0001_1")];
    const today = Array.from({ length: 500 }, (_, i) =>
      snapshotClient(`9000_${i}`, `Client Name ${i}`)
    );
    const message = buildDailyClientReportMessage({
      date: "2026-04-26",
      today,
      yesterday,
      totals: { ...mockTotals, clients: 500 },
    });
    expect(message.length).toBeLessThanOrEqual(5000);
    expect(message).toContain("Check full report.");
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
        deposits: 12450.8,
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
        deposits: 500,
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
      deposits: 12950.8,
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

    expect(pushedMessage).toContain("🔔 First run — baseline snapshot saved.");
    expect(pushedMessage).toContain("📊 Total Clients Today: 2");

    const rows = getByDate(db, "2026-04-26");
    expect(rows).toHaveLength(2);
  });

  test("idempotent — second run for same date skips insert", async () => {
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
    expect(pushedMessage).toContain("🔔 First run — baseline snapshot saved.");
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

    expect(messages[1]).toContain("✅ No changes detected.");
    expect(messages[1]).toContain("📊 Total Clients Today: 2");
  });

  test("purges old snapshots after insert", async () => {
    const db = new Database(":memory:", { strict: true });
    initSqlite(db);
    seedFromEnv(db, "Utest001");

    const mockFetchAll = async () => ({ ok: true as const, data: mockClientsResponse });
    const mockPushAll = async () => {};

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
    const mockPushAll = async () => {};

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
