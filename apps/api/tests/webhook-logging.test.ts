import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { closeDb, resetDbForTests } from "../src/db/connection";
import { applyTestSchema } from "./db-helpers";
import { resetLastTradeCache } from "../src/services/last-trade.service";
import { withInlineQueue } from "./helpers/inline-queue";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const ORIGINAL_FETCH = globalThis.fetch;

const SECRET = "test_channel_secret";

interface LogCall {
  level: string;
  context: string;
  fields: Record<string, unknown>;
  message: string;
}

const logCalls: LogCall[] = [];

// Swap the pino logger for a recording stub before webhook.ts is imported,
// so every log line the route emits can be asserted. The webhook graph also
// pulls logError (services) and logger.warn (flex builder) through this
// module, so the stub has to cover them.
mock.module("../src/utils/logger", () => {
  const emit =
    (level: string) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      const { context, ...fields } = obj;
      logCalls.push({
        level,
        context: String(context ?? ""),
        fields,
        message: msg ?? "",
      });
    };
  const stubLogger = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: () => stubLogger,
  };
  return {
    logger: stubLogger,
    logError: (context: string, error: unknown): void => {
      const message =
        error instanceof Error ? error.message : String(error);
      logCalls.push({ level: "error", context, fields: {}, message });
    },
    logInfo: (context: string, fields: Record<string, unknown>, message: string): void => {
      logCalls.push({ level: "info", context, fields, message });
    },
    logWarn: (context: string, fields: Record<string, unknown>, message: string): void => {
      logCalls.push({ level: "warn", context, fields, message });
    },
  };
});

function computeSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for webhook background work");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLog(
  predicate: (call: LogCall) => boolean,
  timeoutMs = 2000
): Promise<LogCall> {
  const startedAt = Date.now();
  while (true) {
    const found = logCalls.find(predicate);
    if (found) return found;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for log line");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setupTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`
    DROP TABLE IF EXISTS line_groups CASCADE;
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
  `);
  await applyTestSchema(db);
  await client.end();
  resetDbForTests();
}

async function importWebhook() {
  const webhookMod = await import("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return { app: withInlineQueue(app) };
}

async function postEvent(
  app: Hono,
  events: unknown[],
  destination = "U123"
): Promise<Response> {
  const body = JSON.stringify({ destination, events });
  return app.fetch(
    new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-line-signature": computeSig(body, SECRET),
      },
      body,
    })
  );
}

function textEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    message: { type: "text", id: "msg1", text: "hello" },
    source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
    replyToken: "token123",
    timestamp: 1716000000000,
    mode: "active",
    ...overrides,
  };
}

describe("webhook structured logging", () => {
  beforeEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.LINE_CHANNEL_SECRET = SECRET;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
    process.env.HFM_API_KEY = "test_hfm_key";
    process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
    logCalls.length = 0;
    await setupTestDb();
    resetLastTradeCache();
  });

  afterEach(async () => {
    resetLastTradeCache();
    globalThis.fetch = ORIGINAL_FETCH;
    // Every handler call created a fresh getDb() pool; close it so the
    // files running after this one do not hit "too many clients".
    await closeDb();
    delete process.env.LINE_WHITELIST_UIDS;
    delete process.env.LINE_WHITELIST_ENABLED;
    delete process.env.LINE_GROUP_WHITELIST_IDS;
    delete process.env.LINE_GROUP_WHITELIST_ENABLED;
    delete process.env.DATABASE_URL;
    delete process.env.LAST_TRADE_DEADLINE_MS;
    delete process.env.LOT_DISPLAY_MODE;
    resetDbForTests();
  });

  test("batch received line carries destination and eventCount", async () => {
    const { app } = await importWebhook();
    const res = await postEvent(app, [textEvent()]);
    expect(res.status).toBe(200);

    const batch = logCalls.find(
      (c) => c.message === "webhook batch received"
    );
    expect(batch).toBeDefined();
    expect(batch!.level).toBe("info");
    expect(batch!.fields).toEqual({ destination: "U123", eventCount: 1 });
  });

  test("per-event line carries trace fields", async () => {
    const { app } = await importWebhook();
    await postEvent(app, [
      textEvent({
        webhookEventId: "3ea0b476-1234-4cde-8f5a-000000000001",
        deliveryContext: { isRedelivery: true },
      }),
    ]);

    const received = logCalls.find(
      (c) => c.message === "webhook event received"
    );
    expect(received).toBeDefined();
    expect(received!.fields).toEqual({
      webhookEventId: "3ea0b476-1234-4cde-8f5a-000000000001",
      eventType: "message",
      sourceType: "group",
      chatId: "Cgroup1",
      hasUserId: true,
      isRedelivery: true,
    });
  });

  test("events without webhookEventId get a generated short trace id", async () => {
    const { app } = await importWebhook();
    await postEvent(app, [textEvent()]);

    const received = logCalls.find(
      (c) => c.message === "webhook event received"
    );
    expect(String(received!.fields.webhookEventId)).toMatch(/^evt-[0-9a-f]{8}$/);
  });

  test("batches over MAX_WEBHOOK_EVENTS log a truncation warning", async () => {
    const { app } = await importWebhook();
    const events = Array.from({ length: 22 }, (_, i) => ({
      type: "leave",
      source: { type: "user", userId: `Uleft${i}` },
      timestamp: 1716000000000,
      mode: "active",
    }));
    await postEvent(app, events);

    const batch = logCalls.find(
      (c) => c.message === "webhook batch received"
    );
    expect(batch!.fields.eventCount).toBe(22);

    const warn = await waitForLog((c) => c.message === "webhook batch truncated");
    expect(warn.level).toBe("warn");
    expect(warn.fields).toEqual({
      destination: "U123",
      received: 22,
      kept: 20,
      dropped: 2,
    });
  });

  test("no chat context logs reason no_chat_context", async () => {
    const { app } = await importWebhook();
    // A group source without groupId cannot become a ChatContext.
    await postEvent(app, [
      textEvent({ source: { type: "group" }, replyToken: undefined }),
    ]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "no_chat_context"
    );
    expect(skipped.level).toBe("info");
    expect(skipped.context).toBe("webhook");
    expect(String(skipped.fields.webhookEventId)).toMatch(/^evt-/);
  });

  test("unregistered group text logs reason chat_not_allowed and stays silent", async () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cother";
    const { app } = await importWebhook();
    const calls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await postEvent(app, [textEvent({ message: { type: "text", id: "m", text: "98241376" } })]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "chat_not_allowed"
    );
    expect(skipped.level).toBe("info");
    expect(calls.some((c) => c.includes("api.line.me"))).toBe(false);
  });

  test("unregistered group postback logs reason chat_not_allowed", async () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cother";
    const { app } = await importWebhook();
    await postEvent(app, [
      {
        type: "postback",
        postback: { data: "action=page&kind=wallet&id=98241376&page=2" },
        source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
        replyToken: "token123",
        timestamp: 1716000000000,
        mode: "active",
      },
    ]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "chat_not_allowed"
    );
    expect(skipped.level).toBe("info");
  });

  test("report command in a group logs reason report_not_in_group", async () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const { app } = await importWebhook();
    await postEvent(app, [textEvent({ message: { type: "text", id: "m", text: "report" } })]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "report_not_in_group"
    );
    expect(skipped.level).toBe("info");
    expect(
      logCalls.some((c) => c.message.startsWith("reply"))
    ).toBe(false);
  });

  test("plain group chatter logs reason no_mention_not_lookup", async () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const { app } = await importWebhook();
    await postEvent(app, [textEvent()]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "no_mention_not_lookup"
    );
    expect(skipped.level).toBe("info");

    const parsed = logCalls.find((c) => c.message === "text parsed");
    expect(parsed).toBeDefined();
    expect(parsed!.fields.isLookup).toBe(false);
    expect(parsed!.fields.textLength).toBe(5);
  });

  test("join from a one-on-one chat logs reason join_from_user_chat", async () => {
    process.env.LINE_WHITELIST_UIDS = "Uabc123";
    const { app } = await importWebhook();
    const calls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await postEvent(app, [
      {
        type: "join",
        source: { type: "user", userId: "Uabc123" },
        replyToken: "token123",
        timestamp: 1716000000000,
        mode: "active",
      },
    ]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "join_from_user_chat"
    );
    expect(skipped.level).toBe("info");
    expect(calls.some((c) => c.includes("api.line.me"))).toBe(false);
  });

  test("leave from a one-on-one chat logs reason leave_from_user_chat", async () => {
    const { app } = await importWebhook();
    await postEvent(app, [
      {
        type: "leave",
        source: { type: "user", userId: "Uabc123" },
        timestamp: 1716000000000,
        mode: "active",
      },
    ]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "leave_from_user_chat"
    );
    expect(skipped.level).toBe("info");
  });

  test("unhandled event types log reason unhandled_event_type", async () => {
    const { app } = await importWebhook();
    await postEvent(app, [
      {
        type: "follow",
        source: { type: "user", userId: "Uabc123" },
        timestamp: 1716000000000,
        mode: "active",
      },
    ]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "unhandled_event_type"
    );
    expect(skipped.level).toBe("info");
  });

  test("postback without a page action logs reason postback_unhandled_action", async () => {
    process.env.LINE_WHITELIST_UIDS = "Uabc123";
    const { app } = await importWebhook();
    await postEvent(app, [
      {
        type: "postback",
        postback: { data: "action=something_else" },
        source: { type: "user", userId: "Uabc123" },
        replyToken: "token123",
        timestamp: 1716000000000,
        mode: "active",
      },
    ]);

    const skipped = await waitForLog(
      (c) => c.fields.reason === "postback_unhandled_action"
    );
    expect(skipped.level).toBe("info");
  });

  test("a successful flex reply logs replyType, outcome and duration", async () => {
    process.env.LINE_WHITELIST_UIDS = "Uabc123";
    const { app } = await importWebhook();
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
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
      if (url.includes("/api/clients/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: [
              { id: 78451293, last_trade: "2026-07-18T09:30:00Z" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await postEvent(app, [
      textEvent({
        message: { type: "text", id: "m", text: "98241376" },
        source: { type: "user", userId: "Uabc123" },
        webhookEventId: "evt-flex-check",
      }),
    ]);

    const sent = await waitForLog((c) => c.message === "reply sent");
    expect(sent.level).toBe("info");
    expect(sent.fields.webhookEventId).toBe("evt-flex-check");
    expect(sent.fields.replyType).toBe("flex");
    expect(sent.fields.outcome).toBe("sent");
    expect(typeof sent.fields.durationMs).toBe("number");

    const perf = logCalls.find((c) => c.fields.op === "fetch_performance");
    expect(perf).toBeDefined();
    expect(perf!.fields.deadlineMs).toBe(8000);
    expect(perf!.fields.webhookEventId).toBe("evt-flex-check");
  });

  test("a failed LINE reply logs outcome failed with status and x-line-request-id", async () => {
    // The user is not whitelisted, so the rejection notice is the only reply
    // and the retry prompt is skipped afterwards.
    process.env.LINE_WHITELIST_UIDS = "Usomeone_else";
    const { app } = await importWebhook();
    globalThis.fetch = (async () =>
      new Response("Invalid reply token", {
        status: 400,
        headers: { "x-line-request-id": "req-abc-123" },
      })) as unknown as typeof globalThis.fetch;

    await postEvent(app, [
      textEvent({
        message: { type: "text", id: "m", text: "98241376" },
        source: { type: "user", userId: "Uabc123" },
        webhookEventId: "evt-fail-check",
      }),
    ]);

    const failed = await waitForLog((c) => c.message === "reply failed");
    expect(failed.level).toBe("warn");
    expect(failed.fields.webhookEventId).toBe("evt-fail-check");
    expect(failed.fields.replyType).toBe("reply");
    expect(failed.fields.outcome).toBe("failed");
    expect(failed.fields.httpStatus).toBe(400);
    expect(failed.fields.lineRequestId).toBe("req-abc-123");
    expect(typeof failed.fields.durationMs).toBe("number");
  });

  test("last-trade fetch past the deadline logs a latency warning", async () => {
    process.env.LINE_WHITELIST_UIDS = "Uabc123";
    process.env.LAST_TRADE_DEADLINE_MS = "50";
    const { app } = await importWebhook();
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      if (url.endsWith("/v2/bot/chat/loading/start")) {
        return new Response("{}", { status: 202 });
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
      if (url.includes("/api/clients/")) {
        // Never resolves - the deadline must win.
        return new Promise<Response>(() => {});
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await postEvent(app, [
      textEvent({
        message: { type: "text", id: "m", text: "98241376" },
        source: { type: "user", userId: "Uabc123" },
        webhookEventId: "evt-latency-check",
      }),
    ]);

    const slow = await waitForLog(
      (c) =>
        c.message === "upstream latency over deadline" &&
        c.fields.op === "get_last_trade_map_within",
      5000
    );
    expect(slow.level).toBe("warn");
    expect(slow.fields.webhookEventId).toBe("evt-latency-check");
    expect(slow.fields.deadlineMs).toBe(50);
    expect(slow.fields.durationMs).toBeGreaterThanOrEqual(50);

    const perf = logCalls.find(
      (c) =>
        c.fields.op === "fetch_performance" &&
        c.message === "upstream latency"
    );
    expect(perf).toBeDefined();
    expect(perf!.level).toBe("info");

    // The warn fires before the flex reply finishes, so await it here.
    await waitForLog((c) => c.message === "reply sent", 5000);
  });

  test("customer text, reply tokens and signatures never reach the logs", async () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const { app } = await importWebhook();
    await postEvent(app, [
      textEvent({
        message: { type: "text", id: "m", text: "MY-SECRET-PAYLOAD-98241376" },
      }),
    ]);

    await waitForLog((c) => c.fields.reason === "no_mention_not_lookup");
    const dumped = JSON.stringify(logCalls);
    expect(dumped).not.toContain("MY-SECRET-PAYLOAD-98241376");
    expect(dumped).not.toContain("token123");
    expect(dumped).not.toContain("x-line-signature");
    expect(dumped).not.toContain("test_channel_secret");
    expect(dumped).not.toContain("test_token");
  });
});
