import { test, expect, describe } from "bun:test";
import { buildTradingCard } from "../src/builders/flex-message.builder";
import type { HFMPerformanceData } from "../src/types/hfm.types";

const mockData: HFMPerformanceData = {
  client_id: 45219,
  account_id: 78451293,
  activity_status: "active",
  trades: 24,
  volume: 3.42,
  account_type: "Standard",
  deposits: 12450.8,
  account_currency: "USD",
  equity: 12998.35,
  archived: false,
  subaffiliate: 0,
  account_regdate: "2024-01-15T00:00:00Z",
  status: "approved",
};

const WALLET_ID = "WL-98241376";

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
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);

    expect(texts.some((t) => t.includes("WL-98241376"))).toBe(true);
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
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2713 Active");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#1DB954");
  });

  test("inactive status shows grey badge", () => {
    const inactiveData = { ...mockData, activity_status: "inactive" };
    const card = buildTradingCard(inactiveData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "inactive");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#9E9E9E");
  });

  test("USD currency formatting", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "$12,998.35")).toBe(true);
  });

  test("volume formatting with lots suffix", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "3.42 lots")).toBe(true);
  });

  test("THB currency formatting", () => {
    const thbData: HFMPerformanceData = {
      ...mockData,
      deposits: 450000,
      equity: 450500,
      account_currency: "THB",
    };
    const card = buildTradingCard(thbData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "THB\u00A0450,000.00")).toBe(true);
    expect(texts.some((t) => t === "THB\u00A0450,500.00")).toBe(true);
    expect(texts.some((t) => t === "THB")).toBe(true);
  });

  test("USC currency divides by 100 and shows USD label", () => {
    const uscData: HFMPerformanceData = {
      ...mockData,
      deposits: 1245080,
      equity: 1299835,
      account_currency: "USC",
    };
    const card = buildTradingCard(uscData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "$12,998.35")).toBe(true);
    expect(texts.some((t) => t === "USD")).toBe(true);
  });

  test("unknown currency falls back to USD", () => {
    const unknownData: HFMPerformanceData = {
      ...mockData,
      account_currency: "EUR",
    };
    const card = buildTradingCard(unknownData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "EUR")).toBe(true);
  });

  test("bubble has size mega", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    expect(card.size).toBe("mega");
  });

  test("bubble type is bubble", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    expect(card.type).toBe("bubble");
  });

  test("match all shows green badge", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2713 Match All");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#1DB954");
  });

  test("not match shows red badge", () => {
    const card = buildTradingCard(mockData, WALLET_ID, notMatchConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2717 Not Match");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#DC2626");
  });

  test("account status approved shows green badge", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "\u2713 Approved");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#1DB954");
  });

  test("account status non-approved shows grey badge", () => {
    const pendingData = { ...mockData, status: "pending" };
    const card = buildTradingCard(pendingData, WALLET_ID, matchAllConditions) as Record<string, unknown>;
    const badge = findBadgeByLabel(card, "pending");
    expect(badge).toBeDefined();
    expect(badge!.color).toBe("#9E9E9E");
  });

  test("subaffiliate displayed as raw number", () => {
    const subData = { ...mockData, subaffiliate: 12345 };
    const card = buildTradingCard(subData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "12345")).toBe(true);
  });

  test("registration date formatted as DD MMM YYYY", () => {
    const card = buildTradingCard(mockData, WALLET_ID, matchAllConditions);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "15 Jan 2024")).toBe(true);
  });
});
