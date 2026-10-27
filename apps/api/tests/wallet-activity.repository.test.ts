import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { closeTestDb, createTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import {
  findDormantWallets,
  markWalletsAlerted,
  syncWalletActivity,
} from "../src/repositories/wallet-activity.repository";

const RUN = "2026-10-27T02:00:00.000Z";
const CUTOFF = "2026-10-06T02:00:00.000Z"; // RUN - 21 days

describe("wallet-activity.repository", () => {
  let db: DrizzleDb;
  let client: postgres.Sql;

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db as unknown as DrizzleDb;
    client = created.client;
  });

  afterEach(async () => {
    await closeTestDb(client);
  });

  const ids = async (seenSince = RUN) =>
    (await findDormantWallets(db, { cutoff: CUTOFF, seenSince })).map((w) => w.walletId);

  test("finds wallets whose last trade or funding is older than the cutoff", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: "old trade", lastTradeAt: "2026-10-01T00:00:00.000Z", firstFundedAt: null },
      { walletId: 2, name: "recent trade", lastTradeAt: "2026-10-20T00:00:00.000Z", firstFundedAt: null },
      { walletId: 3, name: "funded, never traded", lastTradeAt: null, firstFundedAt: "2026-09-30T00:00:00.000Z" },
      { walletId: 4, name: "never funded", lastTradeAt: null, firstFundedAt: null },
      { walletId: 5, name: "old funding, recent trade", lastTradeAt: "2026-10-25T00:00:00.000Z", firstFundedAt: "2026-01-01T00:00:00.000Z" },
    ], RUN);

    expect(await ids()).toEqual([3, 1]); // oldest anchor first
  });

  test("last_trade_at never moves backwards and first_funded_at never moves forwards", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: "a", lastTradeAt: "2026-10-20T00:00:00.000Z", firstFundedAt: "2026-01-01T00:00:00.000Z" },
    ], RUN);
    await syncWalletActivity(db, [
      { walletId: 1, name: "b", lastTradeAt: null, firstFundedAt: "2026-05-01T00:00:00.000Z" },
    ], RUN);

    expect(await ids()).toEqual([]); // still active from the 10-20 trade
  });

  test("an alerted wallet is not due again until it trades and goes dormant again", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: null, lastTradeAt: "2026-10-01T00:00:00.000Z", firstFundedAt: null },
    ], RUN);
    await markWalletsAlerted(db, [1], RUN);
    expect(await ids()).toEqual([]);

    const later = "2026-11-20T02:00:00.000Z";
    await syncWalletActivity(db, [
      { walletId: 1, name: null, lastTradeAt: "2026-10-28T00:00:00.000Z", firstFundedAt: null },
    ], later);
    const due = await findDormantWallets(db, {
      cutoff: "2026-10-30T02:00:00.000Z", // later - 21 days
      seenSince: later,
    });
    expect(due.map((w) => w.walletId)).toEqual([1]);
  });

  test("a wallet missing from the current sync is not checked", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: null, lastTradeAt: "2026-10-01T00:00:00.000Z", firstFundedAt: null },
    ], "2026-10-26T02:00:00.000Z");

    expect(await ids()).toEqual([]);
  });
});
