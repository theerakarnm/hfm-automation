import { expect, test, describe, afterEach } from "bun:test";
import {
  pushToAll,
  pushText,
  replyOrPushText,
  replyOrPushFlex,
  fetchBotInfo,
} from "../src/services/line.service";
import type { TenantConfig } from "../src/types/tenant.types";

const ORIGINAL_FETCH = globalThis.fetch;

function makeCtx(over: Partial<TenantConfig> = {}): TenantConfig {
  return {
    id: 1,
    webhookId: "wh-1",
    label: "tenant",
    active: true,
    lineChannelAccessToken: "tok",
    lineChannelSecret: "secret",
    lineBotUserId: null,
    lineBasicId: null,
    lineDisplayName: null,
    hfmApiKey: "hfm",
    hfmApiBaseUrl: "https://api.hfaffiliates.com",
    targetWallet: 0,
    whitelistEnabled: true,
    whitelistUids: [],
    lastTestedAt: null,
    lastTestResult: null,
    ...over,
  };
}

const ctx = makeCtx();
const ctxA = makeCtx({ id: 1, lineChannelAccessToken: "tokA" });
const ctxB = makeCtx({ id: 2, lineChannelAccessToken: "tokB" });

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

    await pushToAll(ctx, ["U001", "U002", "U003"], "hello");
    expect(calls).toEqual(["U001", "U002", "U003"]);
  });

  test("sends correct text message to each UID", async () => {
    const messages: Array<{ to: string; text: string }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      messages.push({ to: body.to, text: body.messages[0].text });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushToAll(ctx, ["U001"], "test message");
    expect(messages).toEqual([{ to: "U001", text: "test message" }]);
  });

  test("handles empty UID list", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushToAll(ctx, [], "hello");
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

    await expect(pushToAll(ctx, ["U001", "U002", "U003"], "hello")).rejects.toThrow();
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

    await replyOrPushText(ctx, "token123", "U001", "hello");
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

    await replyOrPushFlex(ctx, "expired", "U001", "alt text", { type: "bubble" });

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

    await expect(replyOrPushText(ctx, "expired", "U001", "hello")).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("two tenants push with their own tokens", async () => {
    const seen: Array<{ auth: string; to: string }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({
        auth: String((init!.headers as Record<string, string>).Authorization),
        to: JSON.parse(String(init!.body)).to,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushText(ctxA, "U123", "hi");
    await pushText(ctxB, "U123", "hi");
    expect(seen.map((s) => s.auth)).toEqual(["Bearer tokA", "Bearer tokB"]);
  });
});

describe("fetchBotInfo", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("fetchBotInfo returns identity or null", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        userId: "U827", basicId: "@abc", displayName: "Test",
      }), { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await fetchBotInfo("tok")).toEqual({
      userId: "U827", basicId: "@abc", displayName: "Test",
    });

    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof globalThis.fetch;
    expect(await fetchBotInfo("bad")).toBeNull();
  });
});
