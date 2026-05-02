import { expect, test, describe, afterEach } from "bun:test";
import { pushToAll } from "../src/services/line.service";

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
