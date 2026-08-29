import { expect, test, describe, afterEach } from "bun:test";
import { pushToAll, replyOrPushText, replyOrPushFlex } from "../src/services/line.service";

const ORIGINAL_FETCH = globalThis.fetch;

describe("pushToAll", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("sends to each UID sequentially", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body.to);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushToAll(["U001", "U002", "U003"], "hello");
    expect(calls).toEqual(["U001", "U002", "U003"]);
  });

  test("sends correct text message to each UID", async () => {
    const messages: Array<{ to: string; text: string }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      messages.push({ to: body.to, text: body.messages[0].text });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushToAll(["U001"], "test message");
    expect(messages).toEqual([{ to: "U001", text: "test message" }]);
  });

  test("handles empty UID list", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushToAll([], "hello");
    expect(called).toBe(false);
  });

  test("throws on LINE push failure and stops sending", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body.to);
      if (body.to === "U002") {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await expect(pushToAll(["U001", "U002", "U003"], "hello")).rejects.toThrow();
    expect(calls).toEqual(["U001", "U002"]);
  });
});

describe("replyOrPush", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("uses the reply token and does not push when the reply succeeds", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await replyOrPushText("token123", "U001", "hello");
    expect(urls).toEqual(["https://api.line.me/v2/bot/message/reply"]);
  });

  test("falls back to a push carrying the same message when the reply fails", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string });
      if (url.endsWith("/message/reply")) {
        return new Response("Invalid reply token", { status: 400 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await replyOrPushFlex("expired", "U001", "alt text", { type: "bubble" });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.line.me/v2/bot/message/reply",
      "https://api.line.me/v2/bot/message/push",
    ]);
    const pushed = JSON.parse(calls[1]!.body);
    expect(pushed.to).toBe("U001");
    expect(pushed.messages[0]).toEqual({
      type: "flex",
      altText: "alt text",
      contents: { type: "bubble" },
    });
  });

  test("throws when both the reply and the push fail", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof globalThis.fetch;

    await expect(replyOrPushText("expired", "U001", "hello")).rejects.toThrow();
  });
});
