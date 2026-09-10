import { test, expect, describe, afterEach } from "bun:test";
import {
  buildTradingCard,
  buildPaginationCard,
  getFlexSummaryVersion,
  resetFlexVersionWarning,
} from "../src/builders/flex-message.builder";
import type { HFMPerformanceData } from "../src/types/hfm.types";
import { logger } from "../src/utils/logger";

const mockData: HFMPerformanceData = {
  client_id: 45219,
  account_id: 78451293,
  activity_status: "active",
  trades: 24,
  volume: 3.42,
  account_type: "Standard",
  balance: 12450.8,
  account_currency: "USD",
  equity: 12998.35,
  archived: false,
  subaffiliate: 0,
  account_regdate: "2024-01-15T00:00:00Z",
  status: "approved",
};

const matchAllConditions = {
  underTargetWallet: true,
  depositThresholdMet: true,
  matchAll: true,
};

const notMatchConditions = {
  underTargetWallet: false,
  depositThresholdMet: false,
  matchAll: false,
};

function extractTexts(card: object): string[] {
  const texts: string[] = [];
  function walk(node: unknown) {
    if (node == null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      texts.push(obj.text);
    }
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (typeof val === "object" && val !== null) walk(val);
    }
  }
  walk(card);
  return texts;
}

function findBadgeByLabel(
  card: Record<string, unknown>,
  label: string
): Record<string, unknown> | undefined {
  const body = card.body as Record<string, unknown>;
  const contents = body.contents as Record<string, unknown>[];
  for (const row of contents) {
    const inner = (row as Record<string, unknown>).contents as
      | Record<string, unknown>[]
      | undefined;
    if (!inner) continue;
    const badge = inner.find(
      (t) => (t as Record<string, unknown>).text === label
    );
    if (badge) return badge as Record<string, unknown>;
  }
  return undefined;
}

describe("buildTradingCard", () => {
  test("all fields populated in output JSON", () => {
    const card = buildTradingCard(mockData, matchAllConditions, {
      showVolume: true,
    });
    const texts = extractTexts(card);

    expect(texts.some((t) => t.includes("45219"))).toBe(true);
    expect(texts.some((t) => t.includes("78451293"))).toBe(true);
    expect(texts.some((t) => t.includes("Active"))).toBe(true);
    expect(texts.some((t) => t.includes("24"))).toBe(true);
    expect(texts.some((t) => t.includes("3.42 lots"))).toBe(true);
    expect(texts.some((t) => t.includes("Standard"))).toBe(true);
    expect(texts.some((t) => t.includes("$12,450.80"))).toBe(true);
    expect(texts.some((t) => t.includes("$12,998.35"))).toBe(true);
    expect(texts.some((t) => t === "USD")).toBe(true);
    expect(texts.some((t) => t === "15 Jan 2024")).toBe(true);
    expect(texts.some((t) => t.includes("Approved"))).toBe(true);
    expect(texts.some((t) => t === "0")).toBe(true);
    expect(texts.some((t) => t.includes("Match All"))).toBe(true);
  });

  test("active status shows green badge", () => {
    const card = buildTradingCard(mockData, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2713 Active");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#1DB954");
  });

  test("inactive status shows grey badge", () => {
    const inactiveData = { ...mockData, activity_status: "inactive" };
    const card = buildTradingCard(inactiveData, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "inactive");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#9E9E9E");
  });

  test("USD currency formatting", () => {
    const card = buildTradingCard(mockData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "$12,998.35")).toBe(true);
  });

  test("volume formatting with lots suffix", () => {
    const card = buildTradingCard(mockData, matchAllConditions, {
      showVolume: true,
    });
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "3.42 lots")).toBe(true);
  });

  test("volume metric hidden by default", () => {
    const card = buildTradingCard(mockData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "Volume")).toBe(false);
    expect(texts.some((t) => t.includes("lots"))).toBe(false);
    expect(texts.some((t) => t === "Trades")).toBe(true);
    expect(texts.some((t) => t === "24")).toBe(true);
  });

  test("volume metric shown when showVolume option is set", () => {
    const card = buildTradingCard(mockData, matchAllConditions, {
      showVolume: true,
    });
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "Volume")).toBe(true);
    expect(texts.some((t) => t === "3.42 lots")).toBe(true);
  });

  test("THB currency formatting", () => {
    const thbData: HFMPerformanceData = {
      ...mockData,
      balance: 450000,
      equity: 450500,
      account_currency: "THB",
    };
    const card = buildTradingCard(thbData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "THB\u00A0450,000.00")).toBe(true);
    expect(texts.some((t) => t === "THB\u00A0450,500.00")).toBe(true);
    expect(texts.some((t) => t === "THB")).toBe(true);
  });

  test("USC currency shows raw value with USC label", () => {
    const uscData: HFMPerformanceData = {
      ...mockData,
      balance: 1245080,
      equity: 1299835,
      account_currency: "USC",
    };
    const card = buildTradingCard(uscData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "1,245,080.00 USC")).toBe(true);
    expect(texts.some((t) => t === "1,299,835.00 USC")).toBe(true);
    expect(texts.some((t) => t === "USC")).toBe(true);
  });

  test("unknown currency falls back to USD", () => {
    const unknownData: HFMPerformanceData = {
      ...mockData,
      account_currency: "EUR",
    };
    const card = buildTradingCard(unknownData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "EUR")).toBe(true);
  });

  test("bubble has size mega", () => {
    const card = buildTradingCard(mockData, matchAllConditions) as Record<string, unknown>;
    expect(card.size).toBe("mega");
  });

  test("bubble type is bubble", () => {
    const card = buildTradingCard(mockData, matchAllConditions) as Record<string, unknown>;
    expect(card.type).toBe("bubble");
  });

  test("match all shows green badge", () => {
    const card = buildTradingCard(mockData, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2713 Match All");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#1DB954");
  });

  test("not match shows red badge", () => {
    const card = buildTradingCard(mockData, notMatchConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2717 Not Match");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#DC2626");
  });

  test("not match shows failing conditions detail", () => {
    const card = buildTradingCard(mockData, notMatchConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t.includes("Wallet does not match target"))).toBe(true);
    expect(texts.some((t) => t.includes("Deposit below threshold"))).toBe(true);
  });

  test("only wallet condition fails shows only wallet message", () => {
    const walletOnlyFail = {
      underTargetWallet: false,
      depositThresholdMet: true,
      matchAll: false,
    };
    const card = buildTradingCard(mockData, walletOnlyFail);
    const texts = extractTexts(card);
    expect(texts.some((t) => t.includes("Wallet does not match target"))).toBe(true);
    expect(texts.some((t) => t.includes("Deposit below threshold"))).toBe(false);
  });

  test("only deposit condition fails shows only deposit message", () => {
    const depositOnlyFail = {
      underTargetWallet: true,
      depositThresholdMet: false,
      matchAll: false,
    };
    const card = buildTradingCard(mockData, depositOnlyFail);
    const texts = extractTexts(card);
    expect(texts.some((t) => t.includes("Wallet does not match target"))).toBe(false);
    expect(texts.some((t) => t.includes("Deposit below threshold"))).toBe(true);
  });

  test("match all does not show failing conditions", () => {
    const card = buildTradingCard(mockData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t.includes("Wallet does not match target"))).toBe(false);
    expect(texts.some((t) => t.includes("Deposit below threshold"))).toBe(false);
  });

  test("account status approved shows green badge", () => {
    const card = buildTradingCard(mockData, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2713 Approved");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#1DB954");
  });

  test("account status non-approved shows grey badge", () => {
    const pendingData = { ...mockData, status: "pending" };
    const card = buildTradingCard(pendingData, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "pending");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#9E9E9E");
  });

  test("subaffiliate displayed as raw number", () => {
    const subData = { ...mockData, subaffiliate: 12345 };
    const card = buildTradingCard(subData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "12345")).toBe(true);
  });

  test("registration date formatted as DD MMM YYYY", () => {
    const card = buildTradingCard(mockData, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "15 Jan 2024")).toBe(true);
  });

  test("shows Wallet ID from data.client_id and Trading Account ID from data.account_id", () => {
    const card = buildTradingCard(mockData, matchAllConditions);
    const texts = extractTexts(card);

    expect(texts.some((t) => t === "Wallet ID")).toBe(true);
    expect(texts.some((t) => t === "45219")).toBe(true);
    expect(texts.some((t) => t === "Trading Account ID")).toBe(true);
    expect(texts.some((t) => t === "78451293")).toBe(true);
  });

  test("different client_id and account_id values display correctly", () => {
    const diffData: HFMPerformanceData = {
      ...mockData,
      client_id: 99999,
      account_id: 11111111,
    };
    const card = buildTradingCard(diffData, matchAllConditions);
    const texts = extractTexts(card);

    expect(texts.some((t) => t === "99999")).toBe(true);
    expect(texts.some((t) => t === "11111111")).toBe(true);
  });
});

describe("buildPaginationCard", () => {
  test("middle page shows both Next and Previous buttons", () => {
    const card = buildPaginationCard(
      { kind: "wallet", id: 98241376 },
      2,
      3,
      12
    ) as any;

    expect(card.type).toBe("bubble");
    expect(card.size).toBe("mega");
    expect(card.header.contents[0].text).toBe("Page Navigation");

    const texts = extractTexts(card);
    expect(texts.some((t) => t === "Page 2 of 3")).toBe(true);
    expect(texts.some((t) => t === "Total 12 Accounts")).toBe(true);

    const bodyBox = card.body.contents.find((c: any) => c.type === "box");
    expect(bodyBox).toBeDefined();
    expect(bodyBox.contents).toHaveLength(2);
    expect(bodyBox.contents[0].action.label).toBe("Next Page ➔");
    expect(bodyBox.contents[0].action.data).toBe("action=page&kind=wallet&id=98241376&page=3");
    expect(bodyBox.contents[1].action.label).toBe("🠔 Previous Page");
    expect(bodyBox.contents[1].action.data).toBe("action=page&kind=wallet&id=98241376&page=1");
  });

  test("postback data preserves the volume opt-in", () => {
    const withVol = buildPaginationCard(
      { kind: "wallet", id: 98241376, showVolume: true },
      1,
      2,
      7
    ) as any;

    const bodyBox = withVol.body.contents.find((c: any) => c.type === "box");
    expect(bodyBox.contents[0].action.data).toBe(
      "action=page&kind=wallet&id=98241376&page=2&vol=1"
    );
  });

  test("postback data omits the volume flag by default", () => {
    const withoutVol = buildPaginationCard(
      { kind: "wallet", id: 98241376 },
      1,
      2,
      7
    ) as any;

    const bodyBox = withoutVol.body.contents.find((c: any) => c.type === "box");
    expect(bodyBox.contents[0].action.data).toBe(
      "action=page&kind=wallet&id=98241376&page=2"
    );
  });

  test("first page only shows Next button", () => {
    const card = buildPaginationCard(
      { kind: "wallet", id: 98241376 },
      1,
      2,
      7
    ) as any;

    const bodyBox = card.body.contents.find((c: any) => c.type === "box");
    expect(bodyBox).toBeDefined();
    expect(bodyBox.contents).toHaveLength(1);
    expect(bodyBox.contents[0].action.label).toBe("Next Page ➔");
  });

  test("last page only shows Previous button", () => {
    const card = buildPaginationCard(
      { kind: "wallet", id: 98241376 },
      2,
      2,
      7
    ) as any;

    const bodyBox = card.body.contents.find((c: any) => c.type === "box");
    expect(bodyBox).toBeDefined();
    expect(bodyBox.contents).toHaveLength(1);
    expect(bodyBox.contents[0].action.label).toBe("🠔 Previous Page");
  });
});


describe("flex-v1 output is frozen", () => {
  const snapshotData: HFMPerformanceData = {
    ...mockData,
    last_trade: "2024-03-02T09:15:00Z",
  };

  test("default (flag unset) matches the locked v1 JSON", () => {
    delete process.env.FLEX_SUMMARY_VERSION;
    const card = buildTradingCard(snapshotData, matchAllConditions, {
      showVolume: true,
    });
    expect(JSON.stringify(card, null, 2)).toMatchSnapshot();
  });

  test("default (flag unset), volume hidden, not-match conditions", () => {
    delete process.env.FLEX_SUMMARY_VERSION;
    const card = buildTradingCard(snapshotData, notMatchConditions);
    expect(JSON.stringify(card, null, 2)).toMatchSnapshot();
  });
});


describe("getFlexSummaryVersion", () => {
  const original = process.env.FLEX_SUMMARY_VERSION;

  afterEach(() => {
    if (original === undefined) delete process.env.FLEX_SUMMARY_VERSION;
    else process.env.FLEX_SUMMARY_VERSION = original;
    resetFlexVersionWarning();
  });

  test("unset defaults to flex-v1", () => {
    delete process.env.FLEX_SUMMARY_VERSION;
    expect(getFlexSummaryVersion()).toBe("flex-v1");
  });

  test("empty string defaults to flex-v1", () => {
    process.env.FLEX_SUMMARY_VERSION = "";
    expect(getFlexSummaryVersion()).toBe("flex-v1");
  });

  test("flex-v1 is honoured", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v1";
    expect(getFlexSummaryVersion()).toBe("flex-v1");
  });

  test("flex-v2 is honoured", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v2";
    expect(getFlexSummaryVersion()).toBe("flex-v2");
  });

  test("unrecognized value falls back to flex-v1 and warns once", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v9";
    const warned: string[] = [];
    const originalWarn = logger.warn.bind(logger);
    // @ts-expect-error - test double for the pino warn signature
    logger.warn = (_obj: unknown, msg: string) => warned.push(msg);
    try {
      expect(getFlexSummaryVersion()).toBe("flex-v1");
      expect(getFlexSummaryVersion()).toBe("flex-v1");
    } finally {
      logger.warn = originalWarn;
    }
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("flex-v9");
  });
});

describe("flex-v2 trading card", () => {
  const originalVersion = process.env.FLEX_SUMMARY_VERSION;

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.FLEX_SUMMARY_VERSION;
    else process.env.FLEX_SUMMARY_VERSION = originalVersion;
  });

  const v2Card = (
    data: HFMPerformanceData,
    monthly?: { lots: number; hasTrade: boolean }
  ): Record<string, unknown> => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v2";
    return buildTradingCard(data, matchAllConditions, {
      showVolume: true,
      monthly,
    }) as Record<string, unknown>;
  };

  test("keeps every v1 field except cumulative Volume", () => {
    const texts = extractTexts(v2Card(mockData, { lots: 2.5, hasTrade: true }));
    expect(texts).toContain("Wallet ID");
    expect(texts).toContain("Trading Account ID");
    expect(texts).toContain("Registration Date");
    expect(texts).toContain("Account Status");
    expect(texts).toContain("Subaffiliate");
    expect(texts).toContain("Registration");
    expect(texts).toContain("Condition");
    expect(texts).toContain("Trades");
    expect(texts).toContain("Last Trade");
    expect(texts).toContain("Balance");
    expect(texts).toContain("Equity");
    expect(texts).toContain("Account Type");
    expect(texts).toContain("Account Currency");
    expect(texts).toContain("For assistance, please contact support.");
    expect(texts).not.toContain("Volume");
    expect(texts.some((t) => t === "3.42 lots")).toBe(false);
  });

  test("active month shows green check and passing lots", () => {
    const card = v2Card(mockData, { lots: 2.5, hasTrade: true });
    const texts = extractTexts(card);
    expect(texts).toContain("This Month");
    expect(texts).toContain("Monthly Lots");
    expect(findBadgeByLabel(card, "\u2713 Active")!.color).toBe("#1DB954");
    const lots = findBadgeByLabel(card, "\u2713 2.50 / 2 lots");
    expect(lots).toBeDefined();
    expect(lots!.color).toBe("#1DB954");
  });

  test("inactive month shows red cross and failing lots", () => {
    const card = v2Card(mockData, { lots: 0, hasTrade: false });
    expect(findBadgeByLabel(card, "\u2717 Inactive")!.color).toBe("#DC2626");
    const lots = findBadgeByLabel(card, "\u2717 0.00 / 2 lots");
    expect(lots).toBeDefined();
    expect(lots!.color).toBe("#DC2626");
  });

  test("exactly 2 lots passes", () => {
    const card = v2Card(mockData, { lots: 2, hasTrade: true });
    expect(findBadgeByLabel(card, "\u2713 2.00 / 2 lots")).toBeDefined();
  });

  test("missing monthly data renders N/A rows", () => {
    const card = v2Card(mockData, undefined);
    const texts = extractTexts(card);
    expect(texts).toContain("This Month");
    expect(texts.filter((t) => t === "N/A").length).toBeGreaterThanOrEqual(2);
  });

  test("rank row shows the label only, with no cumulative lot number", () => {
    const card = v2Card({ ...mockData, volume: 1200 }, { lots: 1, hasTrade: true });
    const texts = extractTexts(card);
    expect(texts).toContain("Rank");
    expect(texts).toContain("\u{1F48E} Platinum");
    expect(texts.some((t) => t.includes("1200"))).toBe(false);
  });

  test("v2 JSON stays inside LINE Flex limits", () => {
    const card = v2Card(mockData, { lots: 2.5, hasTrade: true });
    const json = JSON.stringify(card);
    expect(card.type).toBe("bubble");
    expect(json.length).toBeLessThan(10_000);
    for (const t of extractTexts(card)) {
      expect(t.length).toBeLessThanOrEqual(2000);
    }
  });

  test("flag set to flex-v1 still renders the v1 card", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v1";
    const texts = extractTexts(
      buildTradingCard(mockData, matchAllConditions, { showVolume: true })
    );
    expect(texts).toContain("Volume");
    expect(texts).not.toContain("Rank");
  });
});
