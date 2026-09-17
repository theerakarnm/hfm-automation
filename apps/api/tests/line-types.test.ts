import { test, expect, describe } from "bun:test";
import {
  isTextMessageEvent,
  isPostbackEvent,
  isJoinEvent,
  isLeaveEvent,
} from "../src/types/line.types";
import type { WebhookEvent } from "../src/types/line.types";

const base = { mode: "active", timestamp: 1716000000000 };

describe("isTextMessageEvent", () => {
  test("accepts a one-on-one text message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "user", userId: "Uabc123" },
      replyToken: "t1",
      message: { type: "text", id: "1", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(true);
  });

  test("accepts a group text message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
      replyToken: "t2",
      message: { type: "text", id: "2", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(true);
  });

  test("accepts a room text message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "room", roomId: "Rroom1" },
      replyToken: "t3",
      message: { type: "text", id: "3", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(true);
  });

  test("rejects a sticker message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "group", groupId: "Cgroup1" },
      replyToken: "t4",
      message: { type: "sticker", id: "4" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(false);
  });

  test("rejects an event with no reply token (standby mode)", () => {
    const e = {
      ...base,
      mode: "standby",
      type: "message",
      source: { type: "group", groupId: "Cgroup1" },
      message: { type: "text", id: "5", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(false);
  });
});

describe("isPostbackEvent", () => {
  test("accepts a group postback", () => {
    const e = {
      ...base,
      type: "postback",
      source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
      replyToken: "t6",
      postback: { data: "action=page&kind=wallet&id=1&page=2" },
    } as WebhookEvent;
    expect(isPostbackEvent(e)).toBe(true);
  });
});

describe("isJoinEvent and isLeaveEvent", () => {
  test("accepts a join event with a reply token", () => {
    const e = {
      ...base,
      type: "join",
      source: { type: "group", groupId: "Cgroup1" },
      replyToken: "t7",
    } as WebhookEvent;
    expect(isJoinEvent(e)).toBe(true);
    expect(isLeaveEvent(e)).toBe(false);
  });

  test("rejects a join event with no reply token", () => {
    const e = {
      ...base,
      type: "join",
      source: { type: "group", groupId: "Cgroup1" },
    } as WebhookEvent;
    expect(isJoinEvent(e)).toBe(false);
  });

  test("accepts a leave event, which never carries a reply token", () => {
    const e = {
      ...base,
      type: "leave",
      source: { type: "group", groupId: "Cgroup1" },
    } as WebhookEvent;
    expect(isLeaveEvent(e)).toBe(true);
    expect(isTextMessageEvent(e)).toBe(false);
  });
});
