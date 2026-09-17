import { test, expect, describe } from "bun:test";
import { getChatContext } from "../src/utils/chat-context";
import type { WebhookEvent } from "../src/types/line.types";

function event(source: WebhookEvent["source"]): WebhookEvent {
  return {
    type: "message",
    mode: "active",
    timestamp: 1716000000000,
    source,
    replyToken: "token123",
    message: { type: "text", id: "1", text: "98241376" },
  };
}

describe("getChatContext", () => {
  test("user chat uses the user id as the chat id", () => {
    const ctx = getChatContext(event({ type: "user", userId: "Uabc123" }));
    expect(ctx).toEqual({ chatType: "user", chatId: "Uabc123", userId: "Uabc123" });
  });

  test("group chat uses the group id as the chat id", () => {
    const ctx = getChatContext(
      event({ type: "group", groupId: "Cgroup1", userId: "Umember1" }),
    );
    expect(ctx).toEqual({ chatType: "group", chatId: "Cgroup1", userId: "Umember1" });
  });

  test("group chat without a user id still resolves", () => {
    const ctx = getChatContext(event({ type: "group", groupId: "Cgroup1" }));
    expect(ctx).toEqual({ chatType: "group", chatId: "Cgroup1", userId: null });
  });

  test("multi-person chat uses the room id as the chat id", () => {
    const ctx = getChatContext(
      event({ type: "room", roomId: "Rroom1", userId: "Umember1" }),
    );
    expect(ctx).toEqual({ chatType: "room", chatId: "Rroom1", userId: "Umember1" });
  });

  test("user chat without a user id returns null", () => {
    expect(getChatContext(event({ type: "user" }))).toBeNull();
  });

  test("group chat without a group id returns null", () => {
    expect(getChatContext(event({ type: "group", userId: "Umember1" }))).toBeNull();
  });

  test("missing source returns null", () => {
    const broken = { type: "message", mode: "active", timestamp: 1 } as unknown as WebhookEvent;
    expect(getChatContext(broken)).toBeNull();
  });
});
