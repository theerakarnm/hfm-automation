import { test, expect, describe } from "bun:test";
import { isBotMentioned, stripBotMention } from "../src/utils/mention";
import type { Mentionee, TextMessageEvent } from "../src/types/line.types";

function textEvent(text: string, mentionees?: Mentionee[]): TextMessageEvent {
  return {
    type: "message",
    mode: "active",
    timestamp: 1716000000000,
    source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
    replyToken: "token123",
    message: {
      type: "text",
      id: "1",
      text,
      ...(mentionees ? { mention: { mentionees } } : {}),
    },
  };
}

describe("isBotMentioned", () => {
  test("false when there is no mention at all", () => {
    expect(isBotMentioned(textEvent("สวัสดีครับ"))).toBe(false);
  });

  test("true when a mentionee is the bot", () => {
    const e = textEvent("@hfm_bot hello", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(isBotMentioned(e)).toBe(true);
  });

  test("false when only another member is mentioned", () => {
    const e = textEvent("@somchai hello", [
      { index: 0, length: 8, type: "user", userId: "Uother", isSelf: false },
    ]);
    expect(isBotMentioned(e)).toBe(false);
  });

  test("false for an @all mention, which has no isSelf", () => {
    const e = textEvent("@all hello", [{ index: 0, length: 4, type: "all" }]);
    expect(isBotMentioned(e)).toBe(false);
  });
});

describe("stripBotMention", () => {
  test("returns the trimmed text when there is no mention", () => {
    expect(stripBotMention(textEvent("  98241376  "))).toBe("98241376");
  });

  test("removes a leading bot mention", () => {
    const e = textEvent("@hfm_bot 98241376", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(stripBotMention(e)).toBe("98241376");
  });

  test("removes a trailing bot mention", () => {
    const e = textEvent("98241376 @hfm_bot", [
      { index: 9, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(stripBotMention(e)).toBe("98241376");
  });

  test("keeps mentions of other members", () => {
    const e = textEvent("@hfm_bot @somchai 98241376", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
      { index: 9, length: 8, type: "user", userId: "Uother", isSelf: false },
    ]);
    expect(stripBotMention(e)).toBe("@somchai 98241376");
  });

  test("removes two bot mentions without shifting the offsets", () => {
    const e = textEvent("@hfm_bot 98241376 @hfm_bot", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
      { index: 18, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(stripBotMention(e)).toBe("98241376");
  });
});
