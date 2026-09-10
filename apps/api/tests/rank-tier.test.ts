import { test, expect, describe } from "bun:test";
import { getRankTier } from "../src/builders/flex-message.builder";

describe("getRankTier", () => {
  const cases: Array<[number, string]> = [
    [0, "\u{1F949} Bronze"],
    [0.22, "\u{1F949} Bronze"],
    [99.99, "\u{1F949} Bronze"],
    [100, "\u{1F948} Silver"],
    [499.99, "\u{1F948} Silver"],
    [500, "\u{1F947} Gold"],
    [999.99, "\u{1F947} Gold"],
    [1000, "\u{1F48E} Platinum"],
    [3999.99, "\u{1F48E} Platinum"],
    [4000, "\u{1F451} Diamond"],
    [125000, "\u{1F451} Diamond"],
  ];

  for (const [lots, expected] of cases) {
    test(`${lots} lots -> ${expected}`, () => {
      expect(getRankTier(lots)).toBe(expected);
    });
  }

  test("negative or non-finite lots fall back to Bronze", () => {
    expect(getRankTier(-1)).toBe("\u{1F949} Bronze");
    expect(getRankTier(Number.NaN)).toBe("\u{1F949} Bronze");
  });
});
