import { afterEach, describe, expect, test } from "bun:test";
import {
  buildArchivedWalletCard,
  getArchivedNoticeFormat,
} from "../src/builders/flex-message.builder";

function texts(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") out.push(obj.text);
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) v.forEach((x) => texts(x, out));
    else if (typeof v === "object" && v !== null) texts(v, out);
  }
  return out;
}

afterEach(() => {
  delete process.env.ARCHIVED_NOTICE_FORMAT;
  delete process.env.TARGET_WALLET;
});

describe("getArchivedNoticeFormat", () => {
  test.each([
    [undefined, "text"],
    ["", "text"],
    ["flex", "flex"],
    [" FLEX ", "flex"],
    ["banana", "text"],
  ] as const)("%p is %p", (raw, expected) => {
    if (raw === undefined) delete process.env.ARCHIVED_NOTICE_FORMAT;
    else process.env.ARCHIVED_NOTICE_FORMAT = raw;
    expect(getArchivedNoticeFormat()).toBe(expected);
  });
});

describe("buildArchivedWalletCard", () => {
  test("shows the wallet, the partner and why it does not match", () => {
    process.env.TARGET_WALLET = "55946812";
    const t = texts(buildArchivedWalletCard("64392729", 30428234));
    expect(t).toContain("64392729");
    expect(t).toContain("30428234");
    expect(t.some((x) => x.includes("Not Match"))).toBe(true);
    expect(t.some((x) => x.includes("No active Trading Account"))).toBe(true);
    expect(t.some((x) => x.includes("TARGET_WALLET does not match"))).toBe(true);
  });

  test("does not blame TARGET_WALLET when the partner is the target", () => {
    process.env.TARGET_WALLET = "55946812";
    const t = texts(buildArchivedWalletCard("1", 55946812));
    expect(t.some((x) => x.includes("TARGET_WALLET does not match"))).toBe(false);
    expect(t.some((x) => x.includes("No active Trading Account"))).toBe(true);
  });

  test("accepts a WL- prefixed partner id", () => {
    process.env.TARGET_WALLET = "55946812";
    const t = texts(buildArchivedWalletCard("1", "WL-55946812" as unknown as number));
    expect(t.some((x) => x.includes("TARGET_WALLET does not match"))).toBe(false);
  });
});
