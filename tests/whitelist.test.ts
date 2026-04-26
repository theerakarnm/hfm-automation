import { test, expect, describe } from "bun:test";
import { isWhitelisted } from "../src/utils/whitelist";

describe("isWhitelisted", () => {
  test("returns true when LINE_WHITELIST_UIDS is empty (allow all)", () => {
    const original = process.env.LINE_WHITELIST_UIDS;
    delete process.env.LINE_WHITELIST_UIDS;
    expect(isWhitelisted("Uanyone")).toBe(true);
    process.env.LINE_WHITELIST_UIDS = original;
  });

  test("returns true when LINE_WHITELIST_UIDS is blank string", () => {
    const original = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_UIDS = "   ";
    expect(isWhitelisted("Uanyone")).toBe(true);
    process.env.LINE_WHITELIST_UIDS = original;
  });

  test("returns true for a UID in the whitelist", () => {
    const original = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_UIDS = "Uabc123,Udef456";
    expect(isWhitelisted("Uabc123")).toBe(true);
    expect(isWhitelisted("Udef456")).toBe(true);
    process.env.LINE_WHITELIST_UIDS = original;
  });

  test("returns false for a UID not in the whitelist", () => {
    const original = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_UIDS = "Uabc123,Udef456";
    expect(isWhitelisted("Ustranger")).toBe(false);
    process.env.LINE_WHITELIST_UIDS = original;
  });

  test("handles whitespace around UIDs", () => {
    const original = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_UIDS = " Uabc123 , Udef456 ";
    expect(isWhitelisted("Uabc123")).toBe(true);
    expect(isWhitelisted("Udef456")).toBe(true);
    expect(isWhitelisted("Uxyz")).toBe(false);
    process.env.LINE_WHITELIST_UIDS = original;
  });

  test("single UID works", () => {
    const original = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_UIDS = "Uonly";
    expect(isWhitelisted("Uonly")).toBe(true);
    expect(isWhitelisted("Uother")).toBe(false);
    process.env.LINE_WHITELIST_UIDS = original;
  });
});
