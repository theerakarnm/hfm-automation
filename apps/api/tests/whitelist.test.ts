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

describe("LINE_WHITELIST_ENABLED feature flag", () => {
  test("flag=false bypasses whitelist and allows any UID", () => {
    const origFlag = process.env.LINE_WHITELIST_ENABLED;
    const origUids = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_ENABLED = "false";
    process.env.LINE_WHITELIST_UIDS = "Uallowed1,Uallowed2";
    expect(isWhitelisted("Ustranger")).toBe(true);
    process.env.LINE_WHITELIST_ENABLED = origFlag;
    process.env.LINE_WHITELIST_UIDS = origUids;
  });

  test("flag=0 bypasses whitelist", () => {
    const origFlag = process.env.LINE_WHITELIST_ENABLED;
    const origUids = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_ENABLED = "0";
    process.env.LINE_WHITELIST_UIDS = "Uallowed1";
    expect(isWhitelisted("Ustranger")).toBe(true);
    process.env.LINE_WHITELIST_ENABLED = origFlag;
    process.env.LINE_WHITELIST_UIDS = origUids;
  });

  test("flag=off bypasses whitelist", () => {
    const origFlag = process.env.LINE_WHITELIST_ENABLED;
    const origUids = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_ENABLED = "off";
    process.env.LINE_WHITELIST_UIDS = "Uallowed1";
    expect(isWhitelisted("Ustranger")).toBe(true);
    process.env.LINE_WHITELIST_ENABLED = origFlag;
    process.env.LINE_WHITELIST_UIDS = origUids;
  });

  test("flag=no bypasses whitelist", () => {
    const origFlag = process.env.LINE_WHITELIST_ENABLED;
    const origUids = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_ENABLED = "no";
    process.env.LINE_WHITELIST_UIDS = "Uallowed1";
    expect(isWhitelisted("Ustranger")).toBe(true);
    process.env.LINE_WHITELIST_ENABLED = origFlag;
    process.env.LINE_WHITELIST_UIDS = origUids;
  });

  test("flag=true still enforces whitelist", () => {
    const origFlag = process.env.LINE_WHITELIST_ENABLED;
    const origUids = process.env.LINE_WHITELIST_UIDS;
    process.env.LINE_WHITELIST_ENABLED = "true";
    process.env.LINE_WHITELIST_UIDS = "Uallowed1,Uallowed2";
    expect(isWhitelisted("Uallowed1")).toBe(true);
    expect(isWhitelisted("Ustranger")).toBe(false);
    process.env.LINE_WHITELIST_ENABLED = origFlag;
    process.env.LINE_WHITELIST_UIDS = origUids;
  });

  test("flag unset still enforces whitelist", () => {
    const origFlag = process.env.LINE_WHITELIST_ENABLED;
    const origUids = process.env.LINE_WHITELIST_UIDS;
    delete process.env.LINE_WHITELIST_ENABLED;
    process.env.LINE_WHITELIST_UIDS = "Uallowed1";
    expect(isWhitelisted("Uallowed1")).toBe(true);
    expect(isWhitelisted("Ustranger")).toBe(false);
    process.env.LINE_WHITELIST_ENABLED = origFlag;
    process.env.LINE_WHITELIST_UIDS = origUids;
  });
});
