import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { closeTestDb, createTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import { runDormantWalletAlert } from "../src/jobs/dormant-wallet-alert";
import type { HFMClientRow } from "../src/types/hfm.types";

const row = (o: Partial<HFMClientRow>) =>
  ({ id: 1, wallet: 0, name: null, last_trade: null, first_funding: null, ...o }) as HFMClientRow;

const DAY0 = new Date("2026-10-27T02:00:00Z");

const ROWS = [
  row({ id: 11, wallet: 1001, name: "Old", last_trade: "2026-10-01 00:00:00" }),
  row({ id: 12, wallet: 1002, name: "Recent", last_trade: "2026-10-20 00:00:00" }),
  row({ id: 13, wallet: 1003, name: "FundedOnly", first_funding: "2026-09-30 00:00:00" }),
  row({ id: 14, wallet: 1004, name: "Nothing" }),
];

describe("runDormantWalletAlert", () => {
  let db: DrizzleDb;
  let client: postgres.Sql;
  let sent: string[];

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db as unknown as DrizzleDb;
    client = created.client;
    sent = [];
  });

  afterEach(async () => {
    await closeTestDb(client);
  });

  const run = (rows: HFMClientRow[], now: Date, extra: object = {}) =>
    runDormantWalletAlert({
      db,
      now: () => now,
      fetchClientsFn: async () => ({ ok: true, data: rows }),
      getUidsFn: async () => ["Utest"],
      pushToAllFn: async (_uids, text) => {
        sent.push(text);
      },
      ...extra,
    });

  test("alerts the dormant and the funded-never-traded wallets once", async () => {
    await run(ROWS, DAY0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("WL-1001 Old");
    expect(sent[0]).toContain("WL-1003 FundedOnly - เติมเงิน");
    expect(sent[0]).not.toContain("WL-1002");
    expect(sent[0]).not.toContain("WL-1004");

    await run(ROWS, new Date("2026-10-28T02:00:00Z"));
    expect(sent.length).toBe(1); // no repeat the next day
  });

  test("a wallet that trades again is alerted again after another 21 days", async () => {
    await run(ROWS, DAY0);
    const traded = ROWS.map((r) =>
      r.wallet === 1001 ? { ...r, last_trade: "2026-10-28 00:00:00" } : r,
    );
    await run(traded, new Date("2026-11-19T02:00:00Z"));
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain("WL-1001");
    expect(sent[1]).not.toContain("WL-1003"); // still in the same dormant spell
  });

  test("a failed push marks nothing, so the next run retries", async () => {
    await expect(
      run(ROWS, DAY0, {
        pushToAllFn: async () => {
          throw new Error("LINE down");
        },
      }),
    ).rejects.toThrow("LINE down");
    await run(ROWS, new Date("2026-10-28T02:00:00Z"));
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("WL-1001");
  });

  test("with no recipients nothing is marked", async () => {
    await run(ROWS, DAY0, { getUidsFn: async () => [] });
    expect(sent).toEqual([]);
    await run(ROWS, new Date("2026-10-28T02:00:00Z"));
    expect(sent.length).toBe(1);
  });

  test("throws when HFM fails every attempt, so the cron step logs it", async () => {
    await expect(
      run([], DAY0, { fetchClientsFn: async () => ({ ok: false, reason: "timeout" }) }),
    ).rejects.toThrow("timeout");
  });
});
