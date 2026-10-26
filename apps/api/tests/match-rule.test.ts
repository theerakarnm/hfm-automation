import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkConditions,
  depositsExceedThreshold,
  getIdleAlertDays,
  getMatchRule,
} from "../src/services/hfm.service";
import type { HFMPerformanceData } from "../src/types/hfm.types";

const base: HFMPerformanceData = {
  client_id: 45219,
  account_id: 78451293,
  activity_status: "active",
  trades: 1,
  volume: 1,
  account_type: "Standard",
  balance: 5,
  account_currency: "USD",
  equity: 5,
  archived: false,
  subaffiliate: 55946812,
  account_regdate: "2026-01-01T00:00:00Z",
  status: "approved",
  deposits: 31,
};

const KEYS = [
  "TARGET_WALLET",
  "MATCH_RULE",
  "IDLE_ALERT_DAYS",
  "DEPOSIT_THRESHOLD_USD",
  "DEPOSIT_THRESHOLD_USC",
];

beforeEach(() => {
  process.env.TARGET_WALLET = "55946812";
  process.env.MATCH_RULE = "deposits";
  process.env.DEPOSIT_THRESHOLD_USD = "30";
  process.env.DEPOSIT_THRESHOLD_USC = "3000";
});

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("getMatchRule", () => {
  test("defaults to balance", () => {
    delete process.env.MATCH_RULE;
    expect(getMatchRule()).toBe("balance");
  });
  test("reads deposits case-insensitively", () => {
    process.env.MATCH_RULE = " Deposits ";
    expect(getMatchRule()).toBe("deposits");
  });
  test("any other value falls back to balance", () => {
    process.env.MATCH_RULE = "banana";
    expect(getMatchRule()).toBe("balance");
  });
});

describe("getIdleAlertDays", () => {
  test.each([
    ["21", 21],
    [" 7 ", 7],
    ["", 0],
    ["0", 0],
    ["-3", 0],
    ["abc", 0],
    ["7.5", 0],
  ])("%p becomes %p", (raw, expected) => {
    process.env.IDLE_ALERT_DAYS = raw;
    expect(getIdleAlertDays()).toBe(expected);
  });
  test("unset means off", () => {
    delete process.env.IDLE_ALERT_DAYS;
    expect(getIdleAlertDays()).toBe(0);
  });
});

describe("depositsExceedThreshold", () => {
  test.each([
    [30, "USD", false],
    [30.01, "USD", true],
    [3000, "USC", false],
    [3001, "USC", true],
    [100000, "THB", false],
    [100000, "EUR", false],
  ])("deposits %p %s is %p", (deposits, currency, expected) => {
    expect(depositsExceedThreshold(deposits, currency)).toBe(expected);
  });
  test("string and missing deposits are handled", () => {
    expect(depositsExceedThreshold("45.5", "USD")).toBe(true);
    expect(depositsExceedThreshold(undefined, "USD")).toBe(false);
    expect(depositsExceedThreshold(null, "USD")).toBe(false);
  });
});

describe("checkConditions with MATCH_RULE=deposits", () => {
  test("under target wallet and deposits above 30 is a full match", () => {
    const r = checkConditions(base);
    expect(r.matchAll).toBe(true);
    expect(r.partialMatch).toBe(false);
  });
  test("deposits above 30 under another wallet is a partial match", () => {
    const r = checkConditions({ ...base, subaffiliate: 123 });
    expect(r.underTargetWallet).toBe(false);
    expect(r.depositThresholdMet).toBe(true);
    expect(r.matchAll).toBe(false);
    expect(r.partialMatch).toBe(true);
  });
  test("exactly 30 is not a match", () => {
    const r = checkConditions({ ...base, deposits: 30 });
    expect(r.depositThresholdMet).toBe(false);
    expect(r.matchAll).toBe(false);
    expect(r.partialMatch).toBe(false);
  });
  test("balance is ignored", () => {
    const r = checkConditions({ ...base, balance: 100000, deposits: 1 });
    expect(r.matchAll).toBe(false);
  });
  test("a WL- prefixed subaffiliate still matches", () => {
    const r = checkConditions({ ...base, subaffiliate: "WL-55946812" as unknown as number });
    expect(r.matchAll).toBe(true);
  });
});

describe("checkConditions with the default balance rule", () => {
  test("keeps the old behaviour and never reports a partial match", () => {
    delete process.env.MATCH_RULE;
    process.env.DEPOSIT_THRESHOLD_USD = "200";
    const r = checkConditions({ ...base, subaffiliate: 123, balance: 250 });
    expect(r.depositThresholdMet).toBe(true);
    expect(r.matchAll).toBe(false);
    expect(r.partialMatch).toBe(false);
  });
});
