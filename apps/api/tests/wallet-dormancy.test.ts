import { describe, expect, test } from "bun:test";
import {
  aggregateWallets,
  buildDormantAlertMessages,
  parseHfmTimestamp,
} from "../src/services/wallet-dormancy.service";
import type { HFMClientRow } from "../src/types/hfm.types";

function row(overrides: Partial<HFMClientRow>): HFMClientRow {
  return {
    id: 1,
    wallet: 1001,
    name: null,
    last_trade: null,
    first_funding: null,
    ...overrides,
  } as HFMClientRow;
}

describe("parseHfmTimestamp", () => {
  test("reads the space separated HFM format as UTC", () => {
    expect(parseHfmTimestamp("2026-04-25 10:00:00")).toBe("2026-04-25T10:00:00.000Z");
  });

  test("reads ISO strings", () => {
    expect(parseHfmTimestamp("2026-07-19T10:00:00Z")).toBe("2026-07-19T10:00:00.000Z");
  });

  test("returns null for null, empty and garbage", () => {
    expect(parseHfmTimestamp(null)).toBeNull();
    expect(parseHfmTimestamp("")).toBeNull();
    expect(parseHfmTimestamp("not a date")).toBeNull();
  });
});

describe("aggregateWallets", () => {
  test("keeps the latest trade and the earliest funding across a wallet's accounts", () => {
    const wallets = aggregateWallets([
      row({ id: 1, wallet: 1001, name: " Somchai ", last_trade: "2026-09-01 10:00:00", first_funding: "2026-01-10 08:00:00" }),
      row({ id: 2, wallet: 1001, last_trade: "2026-10-01 10:00:00", first_funding: "2026-02-10 08:00:00" }),
      row({ id: 3, wallet: 1001, last_trade: null, first_funding: null }),
    ]);
    expect(wallets).toEqual([
      {
        walletId: 1001,
        name: "Somchai",
        lastTradeAt: "2026-10-01T10:00:00.000Z",
        firstFundedAt: "2026-01-10T08:00:00.000Z",
      },
    ]);
  });

  test("a wallet with no trade on any account keeps lastTradeAt null", () => {
    const [w] = aggregateWallets([row({ wallet: 2002, first_funding: "2026-09-30 00:00:00" })]);
    expect(w?.lastTradeAt).toBeNull();
    expect(w?.firstFundedAt).toBe("2026-09-30T00:00:00.000Z");
  });

  test("skips rows without a wallet", () => {
    expect(aggregateWallets([row({ wallet: 0 })])).toEqual([]);
  });
});

describe("buildDormantAlertMessages", () => {
  const now = new Date("2026-10-27T02:00:00Z");

  test("lists traded and never-traded wallets with ICT dates and day counts", () => {
    const [text, ...rest] = buildDormantAlertMessages(
      [
        { walletId: 1001, name: "Somchai", lastTradeAt: "2026-10-01 03:00:00", firstFundedAt: "2026-01-10 08:00:00" },
        { walletId: 1003, name: null, lastTradeAt: null, firstFundedAt: "2026-09-30 00:00:00" },
      ],
      now,
    );
    expect(rest).toEqual([]);
    expect(text).toBe(
      [
        "⏰ วอเล็ทที่ไม่มีการเทรดเกิน 21 วัน (2 วอเล็ท)",
        "• WL-1001 Somchai - เทรดล่าสุด 01/10/26 (25 วัน)",
        "• WL-1003 - เติมเงิน 30/09/26 ยังไม่เคยเทรด (27 วัน)",
      ].join("\n"),
    );
  });

  test("splits a long list into numbered messages under the LINE text limit", () => {
    const wallets = Array.from({ length: 200 }, (_, i) => ({
      walletId: 10_000_000 + i,
      name: "ชื่อลูกค้าที่ยาวพอสมควรเพื่อทดสอบการแบ่งข้อความ",
      lastTradeAt: "2026-09-01 00:00:00",
      firstFundedAt: null,
    }));
    const texts = buildDormantAlertMessages(wallets, now);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4500);
    expect(texts[0]).toContain(`(200 วอเล็ท) ส่วนที่ 1/${texts.length}`);
    expect(texts.join("\n").match(/• WL-/g)?.length).toBe(200);
  });
});
