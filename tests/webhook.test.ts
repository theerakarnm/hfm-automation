import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";

const ORIGINAL_FETCH = globalThis.fetch;

const SECRET = "test_channel_secret";

function computeSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function createWebhookApp() {
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";

  const webhookMod = require("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return app;
}

describe("webhook", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("invalid signature returns 400", async () => {
    const { app } = await importWebhook();
    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": "invalid_signature",
        },
        body: '{"destination":"U123","events":[]}',
      })
    );
    const response = await res;
    expect(response.status).toBe(400);
  });

  test("valid signature with empty events returns 200", async () => {
    const { app } = await importWebhook();
    const body = '{"destination":"U123","events":[]}';
    const sig = computeSig(body, SECRET);
    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sig,
        },
        body,
      })
    );
    const response = await res;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  test("non-message event returns 200 with no push", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "follow",
          source: { type: "user", userId: "Uabc123" },
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    let pushCalled = false;
    globalThis.fetch = (async () => {
      pushCalled = true;
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;

    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sig,
        },
        body,
      })
    );
    const response = await res;
    expect(response.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(pushCalled).toBe(false);
  });

  test("valid text message event returns 200 immediately", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "WL-98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ clients: [], totals: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sig,
        },
        body,
      })
    );
    const response = await res;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });
});

async function importWebhook() {
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";

  const webhookMod = await import("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return { app };
}
