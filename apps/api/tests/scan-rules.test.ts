import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  idleWallets,
  joinScanAccounts,
  matchedAccounts,
  parseHfmTime,
  type ScanAccount,
} from "../src/services/scan-rules";
import type { HFMClientRow, HFMPerformanceData } from "../src/types/hfm.types";

const TARGET = 55946812;
const NOW = Date.parse("2026-10-26T00:00:00Z");

const acc = (o: Partial<ScanAccount> = {}): ScanAccount => ({
  accountId: 1,
  walletId: 10,
  partnerId: TARGET,
  currency: "USD",
  deposits: 50,
  lastTrade: null,
  firstFunding: null,
  ...o,
});

beforeEach(() => {
  process.env.DEPOSIT_THRESHOLD_USD = "30";
  process.env.DEPOSIT_THRESHOLD_USC = "3000";
});
afterEach(() => {
  delete process.env.DEPOSIT_THRESHOLD_USD;
  delete process.env.DEPOSIT_THRESHOLD_USC;
});

describe("parseHfmTime", () => {
  test("reads the HFM timestamp as UTC", () => {
    expect(parseHfmTime("2026-09-07 19:12:55")).toBe(Date.parse("2026-09-07T19:12:55Z"));
  });
  test.each([null, undefined, "", "not a date"])("%p is null", (v) => {
    expect(parseHfmTime(v as string | null | undefined)).toBeNull();
  });
});

describe("matchedAccounts", () => {
  test("keeps USD and USC above the threshold under the target partner", () => {
    const list = [
      acc({ accountId: 1, deposits: 30 }),
      acc({ accountId: 2, deposits: 30.01 }),
      acc({ accountId: 3, currency: "USC", deposits: 3000 }),
      acc({ accountId: 4, currency: "USC", deposits: 3001 }),
      acc({ accountId: 5, currency: "THB", deposits: 99999 }),
      acc({ accountId: 6, partnerId: 999, deposits: 99999 }),
      acc({ accountId: 7, partnerId: null, deposits: 99999 }),
    ];
    expect(matchedAccounts(list, TARGET).map((a) => a.accountId)).toEqual([2, 4]);
  });
});

describe("idleWallets", () => {
  const days = 21;

  test("exactly 21 days is not idle, one second more is", () => {
    const edge = acc({ lastTrade: "2026-10-05 00:00:00" });
    const over = acc({ walletId: 11, lastTrade: "2026-10-04 23:59:59" });
    const out = idleWallets([edge, over], TARGET, NOW, days);
    expect(out.map((w) => w.walletId)).toEqual([11]);
    expect(out[0]!.idleDays).toBe(21);
    expect(out[0]!.basis).toBe("last_trade");
  });

  test("a wallet uses the latest trade of any of its accounts", () => {
    const old = acc({ accountId: 1, lastTrade: "2026-08-01 00:00:00" });
    const recent = acc({ accountId: 2, lastTrade: "2026-10-20 00:00:00" });
    expect(idleWallets([old, recent], TARGET, NOW, days)).toEqual([]);
  });

  test("a funded wallet that never traded counts from the first funding", () => {
    const a = acc({ lastTrade: null, firstFunding: "2026-09-01 08:00:00" });
    const out = idleWallets([a], TARGET, NOW, days);
    expect(out).toHaveLength(1);
    expect(out[0]!.basis).toBe("first_funding");
    expect(out[0]!.lastActivityAt).toBe("2026-09-01 08:00:00");
  });

  test("a wallet with neither a trade nor a funding is skipped", () => {
    expect(idleWallets([acc()], TARGET, NOW, days)).toEqual([]);
  });

  test("other partners are skipped and the longest idle comes first", () => {
    const list = [
      acc({ walletId: 1, lastTrade: "2026-09-20 00:00:00" }),
      acc({ walletId: 2, lastTrade: "2026-08-01 00:00:00" }),
      acc({ walletId: 3, partnerId: 999, lastTrade: "2026-01-01 00:00:00" }),
    ];
    expect(idleWallets(list, TARGET, NOW, days).map((w) => w.walletId)).toEqual([2, 1]);
  });
});

describe("joinScanAccounts", () => {
  const perf = (o: Partial<HFMPerformanceData>): HFMPerformanceData => ({
    client_id: 10,
    account_id: 1,
    activity_status: "active",
    trades: 0,
    volume: 0,
    account_type: "Standard",
    balance: 0,
    account_currency: "USD",
    equity: 0,
    archived: false,
    subaffiliate: TARGET,
    account_regdate: "2026-01-01T00:00:00Z",
    status: "approved",
    deposits: 50,
    ...o,
  });
  const client = (o: Partial<HFMClientRow>): HFMClientRow => ({
    id: 1,
    wallet: 10,
    type: null,
    last_trade: "2026-09-01 10:00:00",
    volume: null,
    balance: 0,
    commission: 0,
    account_currency: "USD",
    country: null,
    rebates_paid: null,
    rebates_unpaid: null,
    rebates_rejected: null,
    first_trade: null,
    first_funding: "2026-08-01 10:00:00",
    registration: null,
    server: null,
    platform: null,
    conversion_device: null,
    deposits: 50,
    withdrawals: 0,
    name: null,
    email: null,
    equity: 0,
    margin: null,
    free_margin: null,
    ...o,
  });

  test("joins on the account id and takes deposits from the performance row", () => {
    const [a] = joinScanAccounts([perf({})], [client({})]);
    expect(a).toEqual({
      accountId: 1,
      walletId: 10,
      partnerId: TARGET,
      currency: "USD",
      deposits: 50,
      lastTrade: "2026-09-01 10:00:00",
      firstFunding: "2026-08-01 10:00:00",
    });
  });

  test("drops archived accounts and keeps accounts missing from /api/clients/", () => {
    const out = joinScanAccounts(
      [perf({ account_id: 1, archived: true }), perf({ account_id: 2 })],
      [client({ id: 1 })],
    );
    expect(out.map((a) => a.accountId)).toEqual([2]);
    expect(out[0]!.lastTrade).toBeNull();
  });

  test("reads a WL- prefixed subaffiliate", () => {
    const [a] = joinScanAccounts(
      [perf({ subaffiliate: "WL-55946812" as unknown as number })],
      [],
    );
    expect(a!.partnerId).toBe(TARGET);
  });
});
