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
};

const WALLET_ID = "WL-98241376";

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

describe("buildTradingCard", () => {
  test("all 9 fields populated in output JSON", () => {
    const card = buildTradingCard(mockData, WALLET_ID);
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
  });

  test("active status shows green badge", () => {
    const card = buildTradingCard(mockData, WALLET_ID) as Record<string, unknown>;
    const body = (card as Record<string, unknown>).body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    const statusRow = contents.find(
      (row) => {
        const inner = (row as Record<string, unknown>).contents as Record<string, unknown>[] | undefined;
        if (!inner) return false;
        return inner.some(
          (t) => (t as Record<string, unknown>).text === "\u2713 Active"
        );
      }
    );
    expect(statusRow).toBeDefined();
    const inner = (statusRow as Record<string, unknown>).contents as Record<string, unknown>[];
    const badge = inner.find((t) => (t as Record<string, unknown>).text === "\u2713 Active") as Record<string, unknown>;
    expect(badge.color).toBe("#1DB954");
  });

  test("inactive status shows grey badge", () => {
    const inactiveData = { ...mockData, activity_status: "inactive" };
    const card = buildTradingCard(inactiveData, WALLET_ID) as Record<string, unknown>;
    const body = card.body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    const statusRow = contents.find(
      (row) => {
        const inner = (row as Record<string, unknown>).contents as Record<string, unknown>[] | undefined;
        if (!inner) return false;
        return inner.some(
          (t) => (t as Record<string, unknown>).text === "inactive"
        );
      }
    );
    expect(statusRow).toBeDefined();
    const inner = (statusRow as Record<string, unknown>).contents as Record<string, unknown>[];
    const badge = inner.find((t) => (t as Record<string, unknown>).text === "inactive") as Record<string, unknown>;
    expect(badge.color).toBe("#9E9E9E");
  });

  test("USD currency formatting", () => {
    const card = buildTradingCard(mockData, WALLET_ID);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "$12,998.35")).toBe(true);
  });

  test("volume formatting with lots suffix", () => {
    const card = buildTradingCard(mockData, WALLET_ID);
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
    const card = buildTradingCard(thbData, WALLET_ID);
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
    const card = buildTradingCard(uscData, WALLET_ID);
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
    const card = buildTradingCard(unknownData, WALLET_ID);
    const texts = extractTexts(card);
    expect(texts.some((t) => t === "$12,450.80")).toBe(true);
    expect(texts.some((t) => t === "EUR")).toBe(true);
  });

  test("bubble has size kilo", () => {
    const card = buildTradingCard(mockData, WALLET_ID) as Record<string, unknown>;
    expect(card.size).toBe("kilo");
  });

  test("bubble type is bubble", () => {
    const card = buildTradingCard(mockData, WALLET_ID) as Record<string, unknown>;
    expect(card.type).toBe("bubble");
  });
});
