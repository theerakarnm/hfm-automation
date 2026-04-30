import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { resetDatabaseForTests, getDatabase, initSqlite } from "../src/services/sqlite.service";

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

function createWebhookApp() {
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
  process.env.SQLITE_PATH = ":memory:";

  const db = getDatabase();
  initSqlite(db);

  const webhookMod = require("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return app;
}

describe("webhook", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.SQLITE_PATH = ":memory:";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.LINE_WHITELIST_UIDS;
    delete process.env.LINE_WHITELIST_ENABLED;
    resetDatabaseForTests();
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
  });

  test("T-prefix account lookup resolves wallet and returns all linked accounts", async () => {
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

      if (url.includes("wallets=98241376")) {
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
                client_id: 45220,
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
    expect(fetchCalls[2]?.url).toContain("wallets=98241376");
    expect(fetchCalls[3]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const pushBody = JSON.parse(fetchCalls[3]?.body ?? "{}");
    expect(pushBody.messages[0].altText).toContain("Wallet 98241376");
    const contents = pushBody.messages[0].contents;
    expect(contents.type).toBe("carousel");
    expect(contents.contents).toHaveLength(2);
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

      if (url.includes("/api/performance/client-performance") && !url.includes("?")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 6503256,
                account_id: 11111,
                activity_status: "active",
                trades: 10,
                volume: 1.0,
                account_type: "Standard",
                balance: 500,
                account_currency: "USD",
                equity: 600,
                archived: null,
                subaffiliate: 30506525,
                account_regdate: "2026-04-20T00:00:00Z",
                status: "approved",
                full_name: "Wallet Owner",
              },
            ],
            totals: { clients: 1, accounts: 1, volume: 1.0, balance: 500, withdrawals: 0, commission: 10 },
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

    expect(fetchCalls[1]?.url).toBe("https://api.hfaffiliates.com/api/performance/client-performance");

    expect(fetchCalls[2]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    const replyBody = JSON.parse(fetchCalls[2]?.body ?? "{}");
    expect(replyBody.replyToken).toBe("tokenRpt");
    expect(replyBody.messages[0].type).toBe("text");
    expect(replyBody.messages[0].text).toContain("Total Wallet under 30506525");
    expect(replyBody.messages[0].text).toContain("0 Missing Wallet today");
    expect(replyBody.messages[0].text).toContain("0 New Wallets today");
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

      if (url.includes("/api/performance/client-performance") && !url.includes("?")) {
        return new Response(
          JSON.stringify({
            clients: [],
            totals: { clients: 0, accounts: 0, volume: 0, balance: 0, withdrawals: 0, commission: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );
    const response = await res;
    expect(response.status).toBe(200);

    await waitFor(() => fetchCalls.length >= 3);
    expect(fetchCalls[1]?.url).toBe("https://api.hfaffiliates.com/api/performance/client-performance");
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
      if (url.includes("/api/performance/client-performance") && !url.includes("?")) {
        return new Response(
          JSON.stringify({ clients: [], totals: { clients: 0, accounts: 0, volume: 0, balance: 0, withdrawals: 0, commission: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
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
      if (url.includes("/api/performance/client-performance") && !url.includes("?")) {
        return new Response(
          JSON.stringify({ clients: [], totals: { clients: 0, accounts: 0, volume: 0, balance: 0, withdrawals: 0, commission: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
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
      if (url.includes("/api/performance/client-performance") && !url.includes("?")) {
        return new Response(
          JSON.stringify({ clients: [], totals: { clients: 0, accounts: 0, volume: 0, balance: 0, withdrawals: 0, commission: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
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
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
  process.env.SQLITE_PATH = ":memory:";

  const db = getDatabase();
  initSqlite(db);

  const webhookMod = await import("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return { app };
}
