import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb, resetDbForTests } from "../src/db/connection";
import {
  getLastTradeMap,
  resetLastTradeCache,
} from "../src/services/last-trade.service";
import type { HFMClientRow } from "../src/types/hfm.types";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const ORIGINAL_FETCH = globalThis.fetch;

const SECRET = "test_channel_secret";

function computeSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for webhook background work");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setupTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
  `);
  await initDb(db);
  await client.end();
  resetDbForTests();
}

describe("webhook", () => {
  beforeEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.LINE_CHANNEL_SECRET = SECRET;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
    process.env.HFM_API_KEY = "test_hfm_key";
    process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
    await setupTestDb();
    resetLastTradeCache();
  });

  afterEach(() => {
    resetLastTradeCache();
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.LINE_WHITELIST_UIDS;
    delete process.env.LINE_WHITELIST_ENABLED;
    delete process.env.DATABASE_URL;
    delete process.env.TARGET_WALLET;
    delete process.env.LAST_TRADE_DEADLINE_MS;
    resetDbForTests();
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

  test("non-whitelisted user receives rejection message", async () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed1,Uallowed2";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "WL-98241376" },
          source: { type: "user", userId: "Ustranger" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response("{}", { status: 200 });
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

    await waitFor(() => fetchCalls.length >= 1);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const pushBody = JSON.parse(fetchCalls[0]?.body ?? "{}");
    expect(pushBody.replyToken).toBe("token123");
    expect(pushBody.messages[0].type).toBe("text");
    expect(pushBody.messages[0].text).toContain("\u0E44\u0E21\u0E48\u0E21\u0E35\u0E2A\u0E34\u0E17\u0E18\u0E34\u0E4C");

    delete process.env.LINE_WHITELIST_UIDS;
  });

  test("valid text message event shows loading before fetching HFM", async () => {
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

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
      }

      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 45219,
                account_id: 78451293,
                activity_status: "active",
                trades: 24,
                volume: 3.42,
                account_type: "Standard",
                balance: 12450.8,
                account_currency: "USD",
                equity: 12998.35,
                archived: false,
                subaffiliate: 0,
                account_regdate: "2024-01-15T00:00:00Z",
                status: "approved",
              },
            ],
            totals: {},
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getLastTradeMap({
      fetchClientsFn: async () => ({
        ok: true,
        data: [{ id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow],
      }),
    });

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

    await waitFor(() => fetchCalls.length >= 3);
    expect(fetchCalls[0]?.url).toBe(
      "https://api.line.me/v2/bot/chat/loading/start"
    );
    expect(JSON.parse(fetchCalls[0]?.body ?? "{}")).toEqual({
      chatId: "Uabc123",
      loadingSeconds: 20,
    });
    expect(fetchCalls[1]?.url).toContain(
      "/api/performance/client-performance?wallets=98241376"
    );
    expect(fetchCalls[2]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(fetchCalls[2]?.body).toContain("18/07/2026 09:30");
  });

  test("replies with the card even when the last-trade fetch hangs", async () => {
    process.env.LAST_TRADE_DEADLINE_MS = "200";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.includes("/api/clients/")) {
        // Never resolves - the deadline must win.
        return new Promise<Response>(() => {});
      }

      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 98241376,
                account_id: 78451293,
                full_name: "Test Client",
                activity_status: "active",
                trades: 5,
                volume: 0.05,
                account_type: "Premium",
                deposits: 100,
                withdrawals: 0,
                account_currency: "USD",
                equity: 32.88,
                archived: null,
                subaffiliate: 30506525,
                account_regdate: "2026-07-22",
                status: "approved",
                balance: 32.88,
                commission: 0,
              },
            ],
            totals: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(
      () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
      2000
    );
    const reply = fetchCalls.find(
      (c) => c.url === "https://api.line.me/v2/bot/message/reply"
    );
    expect(reply?.body).toContain("Trading Account Summary");
    expect(reply?.body).toContain("N/A");
  });

  test("HFM server error replies with the HFM-down notice instead of silence", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("/api/performance/client-performance")) {
        return new Response("upstream boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(
      () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
      2000
    );
    const reply = fetchCalls.find(
      (c) => c.url === "https://api.line.me/v2/bot/message/reply"
    );
    // "HFM API" appears verbatim inside the Thai server_error notice.
    expect(reply?.body).toContain("HFM API");
  });

  test("wallet whose accounts are all archived replies with the partner notice", async () => {
    // Self-contained whitelist: .env leaks real LINE_WHITELIST_UIDS into
    // isolated runs (-t), which would reject Uabc123 before the lookup.
    process.env.LINE_WHITELIST_UIDS = "Uabc123";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "65238209" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 65238209,
                account_id: 198058740,
                activity_status: "Archived Trading Account",
                trades: 2908,
                volume: 132.2,
                account_type: "PREMIUM",
                balance: 0,
                account_currency: "USD",
                equity: 0,
                archived: true,
                subaffiliate: 30506525,
                account_regdate: "2026-04-08T17:14:12",
                status: "Approved",
              },
            ],
            totals: {},
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(
      () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
      2000
    );
    const reply = fetchCalls.find(
      (c) => c.url === "https://api.line.me/v2/bot/message/reply"
    );
    expect(reply?.body).toContain("\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E15\u0E49 Partner 30506525 \u0E41\u0E15\u0E48\u0E44\u0E21\u0E48\u0E21\u0E35 Trading Account");
    expect(reply?.body).not.toContain("\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25");
  });

  test("an expired reply token falls back to pushing the card", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "expired",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/message/reply")) {
        return new Response("Invalid reply token", { status: 400 });
      }
      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 98241376,
                account_id: 78451293,
                full_name: "Test Client",
                activity_status: "active",
                trades: 5,
                volume: 0.05,
                account_type: "Premium",
                deposits: 100,
                withdrawals: 0,
                account_currency: "USD",
                equity: 32.88,
                archived: null,
                subaffiliate: 30506525,
                account_regdate: "2026-07-22",
                status: "approved",
                balance: 32.88,
                commission: 0,
              },
            ],
            totals: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getLastTradeMap({
      fetchClientsFn: async () => ({
        ok: true,
        data: [{ id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow],
      }),
    });

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(
      () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/push"),
      2000
    );
    const pushed = fetchCalls.find(
      (c) => c.url === "https://api.line.me/v2/bot/message/push"
    );
    expect(JSON.parse(pushed!.body!).to).toBe("Uabc123");
    expect(pushed?.body).toContain("Trading Account Summary");
  });

  test("a total send failure still pushes the try-again notice", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "expired",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const pushedTexts: string[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      const raw = typeof init?.body === "string" ? init.body : undefined;

      if (url.endsWith("/message/reply")) {
        return new Response("Invalid reply token", { status: 400 });
      }
      if (url.endsWith("/message/push")) {
        const msg = JSON.parse(raw ?? "{}").messages?.[0];
        if (msg?.type === "flex") {
          // Push of the card also rejected - drives the dispatcher catch-all.
          return new Response("Invalid flex payload", { status: 400 });
        }
        pushedTexts.push(msg?.text ?? "");
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 98241376,
                account_id: 78451293,
                full_name: "Test Client",
                activity_status: "active",
                trades: 5,
                volume: 0.05,
                account_type: "Premium",
                deposits: 100,
                withdrawals: 0,
                account_currency: "USD",
                equity: 32.88,
                archived: null,
                subaffiliate: 30506525,
                account_regdate: "2026-07-22",
                status: "approved",
                balance: 32.88,
                commission: 0,
              },
            ],
            totals: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getLastTradeMap({
      fetchClientsFn: async () => ({
        ok: true,
        data: [{ id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow],
      }),
    });

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(() => pushedTexts.length > 0, 2000);
    // Decodes to "please send the Wallet ID again".
    expect(pushedTexts[0]).toContain(
      "\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
    );
  });

  test("a non-whitelisted user gets no retry notice when their rejection fails", async () => {
    process.env.LINE_WHITELIST_UIDS = "Usomeone_else";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "expired",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const pushes: string[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      if (url.endsWith("/message/reply")) {
        // Even the rejection notice fails, so the catch-all runs.
        return new Response("Invalid reply token", { status: 400 });
      }
      if (url.endsWith("/message/push")) {
        pushes.push(typeof init?.body === "string" ? init.body : "");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );
    expect(response.status).toBe(200);

    // Absence assertion: give the handler and its catch-all time to finish.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pushes).toHaveLength(0);
  });

  test("a database failure does not stop the lookup reply", async () => {
    const { app } = await importWebhook();
    process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/none";
    resetDbForTests();

    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("/api/performance/client-performance")) {
        return new Response("upstream boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(
      () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
      2000
    );
    const reply = fetchCalls.find(
      (c) => c.url === "https://api.line.me/v2/bot/message/reply"
    );
    expect(reply?.body).toContain("HFM API");
  });

  test("T-prefix account lookup resolves wallet via client_id and returns all linked accounts", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "456", text: "T123456789" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token456",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
      }

      if (url.includes("accounts=123456789")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 45219,
                account_id: 123456789,
                activity_status: "active",
                trades: 10,
                volume: 1.5,
                account_type: "Standard",
                balance: 5000,
                account_currency: "USD",
                equity: 5100,
                archived: false,
                subaffiliate: 98241376,
                account_regdate: "2024-06-01T00:00:00Z",
                status: "approved",
              },
            ],
            totals: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("wallets=45219")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 45219,
                account_id: 123456789,
                activity_status: "active",
                trades: 10,
                volume: 1.5,
                account_type: "Standard",
                balance: 5000,
                account_currency: "USD",
                equity: 5100,
                archived: false,
                subaffiliate: 98241376,
                account_regdate: "2024-06-01T00:00:00Z",
                status: "approved",
              },
              {
                client_id: 45219,
                account_id: 987654321,
                activity_status: "active",
                trades: 5,
                volume: 0.8,
                account_type: "Standard",
                balance: 3000,
                account_currency: "USD",
                equity: 3100,
                archived: false,
                subaffiliate: 98241376,
                account_regdate: "2024-07-01T00:00:00Z",
                status: "approved",
              },
            ],
            totals: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getLastTradeMap({
      fetchClientsFn: async () => ({ ok: true, data: [] as HFMClientRow[] }),
    });

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

    await waitFor(() => fetchCalls.length >= 4);
    expect(fetchCalls[1]?.url).toContain("accounts=123456789");
    expect(fetchCalls[2]?.url).toContain("wallets=45219");
    expect(fetchCalls[3]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const pushBody = JSON.parse(fetchCalls[3]?.body ?? "{}");
    expect(pushBody.messages[0].altText).toContain("Wallet 45219");
    const contents = pushBody.messages[0].contents;
    expect(contents.type).toBe("carousel");
    expect(contents.contents).toHaveLength(2);
  });

  test("pagination splits clients in chunks of 5 and appends pagination card, postback navigates correctly", async () => {
    const { app } = await importWebhook();

    const mockClients = Array.from({ length: 7 }, (_, i) => ({
      client_id: 98241376,
      account_id: 1000000 + i,
      activity_status: "active",
      trades: 10,
      volume: 1.5,
      account_type: "Standard",
      balance: 5000,
      account_currency: "USD",
      equity: 5100,
      archived: false,
      subaffiliate: 98241376,
      account_regdate: "2024-06-01T00:00:00Z",
      status: "approved",
    }));

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
      }

      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: mockClients,
            totals: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getLastTradeMap({
      fetchClientsFn: async () => ({ ok: true, data: [] as HFMClientRow[] }),
    });

    const bodyText = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "msg_page1", text: "98241376" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "reply_page1",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });

    const sigText = computeSig(bodyText, SECRET);
    const resText = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sigText,
        },
        body: bodyText,
      })
    );
    expect(resText.status).toBe(200);

    await waitFor(() => fetchCalls.length >= 3);
    const reply1 = JSON.parse(fetchCalls[2]?.body ?? "{}");
    expect(reply1.messages[0].contents.type).toBe("carousel");
    expect(reply1.messages[0].contents.contents).toHaveLength(6);
    const lastCard1 = reply1.messages[0].contents.contents[5];
    expect(lastCard1.header.contents[0].text).toBe("Page Navigation");
    expect(lastCard1.body.contents.find((c: any) => c.type === "box").contents[0].action.data).toContain("page=2");

    fetchCalls.length = 0;

    const bodyPostback = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "postback",
          postback: { data: "action=page&kind=wallet&id=98241376&page=2" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "reply_page2",
          timestamp: 1716000000001,
          mode: "active",
        },
      ],
    });

    const sigPostback = computeSig(bodyPostback, SECRET);
    const resPostback = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sigPostback,
        },
        body: bodyPostback,
      })
    );
    expect(resPostback.status).toBe(200);

    await waitFor(() => fetchCalls.length >= 3);
    const reply2 = JSON.parse(fetchCalls[2]?.body ?? "{}");
    expect(reply2.messages[0].contents.type).toBe("carousel");
    expect(reply2.messages[0].contents.contents).toHaveLength(3);
    const lastCard2 = reply2.messages[0].contents.contents[2];
    expect(lastCard2.header.contents[0].text).toBe("Page Navigation");
    expect(lastCard2.body.contents.find((c: any) => c.type === "box").contents[0].action.data).toContain("page=1");
  });


  test("plain wallet lookup hides volume while lot-prefixed lookup shows it", async () => {
    const { app } = await importWebhook();

    const mockClients = [
      {
        client_id: 45219,
        account_id: 1000001,
        activity_status: "active",
        trades: 10,
        volume: 1.5,
        account_type: "Standard",
        balance: 5000,
        account_currency: "USD",
        equity: 5100,
        archived: false,
        subaffiliate: 98241376,
        account_regdate: "2024-06-01T00:00:00Z",
        status: "approved",
      },
    ];

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
      }

      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({ clients: mockClients, totals: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getLastTradeMap({
      fetchClientsFn: async () => ({ ok: true, data: [] as HFMClientRow[] }),
    });

    const sendText = async (text: string, replyToken: string) => {
      const bodyText = JSON.stringify({
        destination: "U123",
        events: [
          {
            type: "message",
            message: { type: "text", id: `msg_${replyToken}`, text },
            source: { type: "user", userId: "Uabc123" },
            replyToken,
            timestamp: 1716000000000,
            mode: "active",
          },
        ],
      });
      const res = await app.fetch(
        new Request("http://localhost/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-line-signature": computeSig(bodyText, SECRET),
          },
          body: bodyText,
        })
      );
      expect(res.status).toBe(200);
    };

    await sendText("98241376", "reply_plain");
    await waitFor(() => fetchCalls.length >= 3);
    const replyPlain = JSON.parse(fetchCalls[2]?.body ?? "{}");
    const plainCardJson = JSON.stringify(replyPlain.messages[0].contents);
    expect(plainCardJson).toContain("\"Trades\"");
    expect(plainCardJson).not.toContain("\"Volume\"");
    expect(plainCardJson).not.toContain("lots");

    fetchCalls.length = 0;

    await sendText("lot 98241376", "reply_lot");
    await waitFor(() => fetchCalls.length >= 3);
    const replyLot = JSON.parse(fetchCalls[2]?.body ?? "{}");
    const lotCardJson = JSON.stringify(replyLot.messages[0].contents);
    expect(lotCardJson).toContain("\"Trades\"");
    expect(lotCardJson).toContain("\"Volume\"");
    expect(lotCardJson).toContain("1.50 lots");
  });

  test("invalid input returns format error message", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "789", text: "hello" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token789",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response("{}", { status: 200 });
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

    await waitFor(() => fetchCalls.length >= 1);
    expect(fetchCalls[0]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const pushBody = JSON.parse(fetchCalls[0]?.body ?? "{}");
    expect(pushBody.messages[0].text).toContain("Wallet ID");
  });

  test("report command generates report and replies to user", async () => {
    process.env.TARGET_WALLET = "30506525";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "rpt", text: "report" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "tokenRpt",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
      }

      if (url.includes("/api/clients/")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 11111,
                wallet: 6503256,
                type: "Standard",
                last_trade: "2026-04-25 10:00:00",
                volume: "1.0",
                balance: 500,
                commission: 10,
                account_currency: "USD",
                country: "Thailand",
                rebates_paid: 0,
                rebates_unpaid: 0,
                rebates_rejected: 0,
                first_trade: "2026-04-20 10:00:00",
                first_funding: "2026-04-20 10:00:00",
                registration: "2026-04-20T00:00:00Z",
                server: 5,
                platform: "MT4",
                conversion_device: "Mobile Browser",
                deposits: 500,
                withdrawals: 0,
                name: "Wallet Owner",
                email: "owner@test.com",
                equity: 600,
                margin: 100,
                free_margin: 500,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
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

    await waitFor(() => fetchCalls.length >= 3);

    expect(fetchCalls[0]?.url).toBe("https://api.line.me/v2/bot/chat/loading/start");

    expect(fetchCalls[1]?.url).toBe("https://api.hfaffiliates.com/api/clients/");

    expect(fetchCalls[2]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const replyBody = JSON.parse(fetchCalls[2]?.body ?? "{}");
    expect(replyBody.replyToken).toBe("tokenRpt");
    expect(replyBody.messages[0].type).toBe("text");
    expect(replyBody.messages[0].text).toContain("was not found");
  });

  test("report command is case-insensitive", async () => {
    process.env.TARGET_WALLET = "30506525";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "rpt2", text: "Report" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "tokenRpt2",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });

      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
      }

      if (url.includes("/api/clients/")) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
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

    await waitFor(() => fetchCalls.length >= 3);
    expect(fetchCalls[1]?.url).toBe("https://api.hfaffiliates.com/api/clients/");
    expect(fetchCalls[2]?.url).toBe("https://api.line.me/v2/bot/message/reply");
  });

  test("reportday keyword generates report and replies", async () => {
    process.env.TARGET_WALLET = "30506525";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "rpt3", text: "reportday" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "tokenDay",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/v2/bot/chat/loading/start")) return new Response("{}", { status: 202 });
      if (url.includes("/api/clients/")) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
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
    expect((await res).status).toBe(200);

    await waitFor(() => fetchCalls.length >= 3);
    expect(fetchCalls.at(-1)?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const replyBody = JSON.parse(fetchCalls.at(-1)?.body ?? "{}");
    expect(replyBody.replyToken).toBe("tokenDay");
  });

  test("reportweek keyword generates report and replies", async () => {
    process.env.TARGET_WALLET = "30506525";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "rpt4", text: "reportweek" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "tokenWeek",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/v2/bot/chat/loading/start")) return new Response("{}", { status: 202 });
      if (url.includes("/api/clients/")) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
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
    expect((await res).status).toBe(200);

    await waitFor(() => fetchCalls.length >= 3);
    expect(fetchCalls.at(-1)?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const replyBody = JSON.parse(fetchCalls.at(-1)?.body ?? "{}");
    expect(replyBody.replyToken).toBe("tokenWeek");
  });

  test("reportmonth keyword generates report and replies", async () => {
    process.env.TARGET_WALLET = "30506525";
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "rpt5", text: "ReportMonth" },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "tokenMonth",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const fetchCalls: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/v2/bot/chat/loading/start")) return new Response("{}", { status: 202 });
      if (url.includes("/api/clients/")) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
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
    expect((await res).status).toBe(200);

    await waitFor(() => fetchCalls.length >= 3);
    expect(fetchCalls.at(-1)?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const replyBody = JSON.parse(fetchCalls.at(-1)?.body ?? "{}");
    expect(replyBody.replyToken).toBe("tokenMonth");
  });
});

async function importWebhook() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";

  resetDbForTests();

  const webhookMod = await import("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return { app };
}
