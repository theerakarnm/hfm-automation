import { test, expect, describe, afterEach } from "bun:test";
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
import { isGroupAllowed, isChatAllowed } from "../src/utils/whitelist";
import type { ChatContext } from "../src/utils/chat-context";

describe("isGroupAllowed", () => {
  const origIds = process.env.LINE_GROUP_WHITELIST_IDS;
  const origFlag = process.env.LINE_GROUP_WHITELIST_ENABLED;

  afterEach(() => {
    if (origIds === undefined) delete process.env.LINE_GROUP_WHITELIST_IDS;
    else process.env.LINE_GROUP_WHITELIST_IDS = origIds;
    if (origFlag === undefined) delete process.env.LINE_GROUP_WHITELIST_ENABLED;
    else process.env.LINE_GROUP_WHITELIST_ENABLED = origFlag;
  });

  test("allows every group when the list is unset", () => {
    delete process.env.LINE_GROUP_WHITELIST_IDS;
    expect(isGroupAllowed("Canygroup")).toBe(true);
  });

  test("allows every group when the list is blank", () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "   ";
    expect(isGroupAllowed("Canygroup")).toBe(true);
  });

  test("allows a listed group and rejects an unlisted one", () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1, Cgroup2";
    expect(isGroupAllowed("Cgroup1")).toBe(true);
    expect(isGroupAllowed("Cgroup2")).toBe(true);
    expect(isGroupAllowed("Cstranger")).toBe(false);
  });

  test("flag=false bypasses the group list", () => {
    process.env.LINE_GROUP_WHITELIST_ENABLED = "false";
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    expect(isGroupAllowed("Cstranger")).toBe(true);
  });
});

describe("isChatAllowed", () => {
  const origUids = process.env.LINE_WHITELIST_UIDS;
  const origIds = process.env.LINE_GROUP_WHITELIST_IDS;

  afterEach(() => {
    if (origUids === undefined) delete process.env.LINE_WHITELIST_UIDS;
    else process.env.LINE_WHITELIST_UIDS = origUids;
    if (origIds === undefined) delete process.env.LINE_GROUP_WHITELIST_IDS;
    else process.env.LINE_GROUP_WHITELIST_IDS = origIds;
  });

  test("a one-on-one chat is checked against the UID whitelist", () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed";
    const allowed: ChatContext = { chatType: "user", chatId: "Uallowed", userId: "Uallowed" };
    const denied: ChatContext = { chatType: "user", chatId: "Ustranger", userId: "Ustranger" };
    expect(isChatAllowed(allowed)).toBe(true);
    expect(isChatAllowed(denied)).toBe(false);
  });

  test("a group member is NOT checked against the UID whitelist", () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed";
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const ctx: ChatContext = { chatType: "group", chatId: "Cgroup1", userId: "Ustranger" };
    expect(isChatAllowed(ctx)).toBe(true);
  });

  test("an unlisted group is rejected whoever typed", () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed";
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const ctx: ChatContext = { chatType: "group", chatId: "Cother", userId: "Uallowed" };
    expect(isChatAllowed(ctx)).toBe(false);
  });

  test("a multi-person chat uses the same group list", () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Rroom1";
    const ok: ChatContext = { chatType: "room", chatId: "Rroom1", userId: null };
    const no: ChatContext = { chatType: "room", chatId: "Rroom2", userId: null };
    expect(isChatAllowed(ok)).toBe(true);
    expect(isChatAllowed(no)).toBe(false);
  });
});
