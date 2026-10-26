import { describe, expect, test } from "bun:test";
import { buildIdleMessage, buildMatchMessage } from "../src/jobs/scan-messages";
import type { IdleWallet, ScanAccount } from "../src/services/scan-rules";

const account = (id: number, o: Partial<ScanAccount> = {}): ScanAccount => ({
  accountId: id,
  walletId: 1000 + id,
  partnerId: 1,
  currency: "USD",
  deposits: 45,
  lastTrade: null,
  firstFunding: null,
  ...o,
});

describe("buildMatchMessage", () => {
  test("lists each account with its wallet and deposits", () => {
    const text = buildMatchMessage(
      [account(7), account(8, { currency: "USC", deposits: 4500 })],
      30,
    );
    expect(text).toContain("Match ใหม่ 2 บัญชี");
    expect(text).toContain("เกิน 30 USD");
    expect(text).toContain("T7 (wallet 1007) ฝากสะสม 45.00 USD");
    expect(text).toContain("T8 (wallet 1008) ฝากสะสม 45.00 USC");
  });

  test("caps the list at 30 lines and says how many are left", () => {
    const many = Array.from({ length: 35 }, (_, i) => account(i + 1));
    const text = buildMatchMessage(many, 30);
    expect(text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(30);
    expect(text).toContain("และอีก 5 บัญชี");
  });
});

describe("buildIdleMessage", () => {
  const wallets: IdleWallet[] = [
    { walletId: 11, lastActivityAt: "2026-09-01 10:00:00", basis: "last_trade", idleDays: 55 },
    { walletId: 12, lastActivityAt: "2026-09-20 08:00:00", basis: "first_funding", idleDays: 36 },
  ];

  test("states the day limit and tells traded from never-traded wallets apart", () => {
    const text = buildIdleMessage(wallets, 21);
    expect(text).toContain("2 wallet ไม่เทรดเกิน 21 วัน");
    expect(text).toContain("• 11 - เทรดล่าสุด 2026-09-01 (55 วัน)");
    expect(text).toContain("• 12 - เติมเงินครั้งแรก 2026-09-20 ยังไม่เคยเทรด (36 วัน)");
  });

  test("caps the list at 30 lines", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ ...wallets[0]!, walletId: i + 1 }));
    const text = buildIdleMessage(many, 21);
    expect(text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(30);
    expect(text).toContain("และอีก 1 wallet");
  });
});
