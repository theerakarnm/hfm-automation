import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { resetDatabaseForTests, getDatabase, initSqlite } from "../src/services/sqlite.service";
import { listLineUsers } from "../src/repositories/line-user.repository";

const ORIGINAL_FETCH = globalThis.fetch;

const SECRET = "test_channel_secret";

function computeSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function createApp() {
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
  process.env.INTERNAL_API_KEY = "internal_key";
  process.env.SQLITE_PATH = ":memory:";

  const db = getDatabase();
  initSqlite(db);

  const webhookMod = require("../src/routes/webhook");
  const internalMod = require("../src/routes/internal");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  app.route("/internal", internalMod.default);
  return app;
}

describe("webhook UID collection", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.SQLITE_PATH = ":memory:";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetDatabaseForTests();
    delete process.env.LINE_WHITELIST_UIDS;
    delete process.env.LINE_WHITELIST_ENABLED;
    delete process.env.LINE_CHANNEL_SECRET;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.HFM_API_KEY;
    delete process.env.HFM_API_BASE_URL;
    delete process.env.INTERNAL_API_KEY;
    delete process.env.SQLITE_PATH;
  });

  test("collects UID from text message event", async () => {
    const app = createApp();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "hello" },
          source: { type: "user", userId: "Umsg001" },
          replyToken: "tok",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    await new Promise((r) => setTimeout(r, 50));

    const db = getDatabase();
    const users = listLineUsers(db);
    expect(users).toHaveLength(1);
    expect(users[0]!.line_uid).toBe("Umsg001");
  });

  test("collects UID from follow event (non-text)", async () => {
    const app = createApp();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "follow",
          source: { type: "user", userId: "Ufollow001" },
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDatabase();
    const users = listLineUsers(db);
    expect(users).toHaveLength(1);
    expect(users[0]!.line_uid).toBe("Ufollow001");
    expect(users[0]!.last_event_type).toBe("follow");
  });

  test("does NOT collect UID when signature is invalid", async () => {
    const app = createApp();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "hi" },
          source: { type: "user", userId: "Ubadsig" },
          replyToken: "tok",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });

    await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": "invalid_sig",
        },
        body,
      })
    );

    const db = getDatabase();
    const users = listLineUsers(db);
    expect(users).toHaveLength(0);
  });

  test("collects multiple UIDs from multiple events", async () => {
    const app = createApp();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "follow",
          source: { type: "user", userId: "Uuser1" },
          timestamp: 1716000000000,
          mode: "active",
        },
        {
          type: "follow",
          source: { type: "user", userId: "Uuser2" },
          timestamp: 1716000001000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDatabase();
    const users = listLineUsers(db);
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.line_uid).sort()).toEqual(["Uuser1", "Uuser2"]);
  });

  test("skips events without userId (group source)", async () => {
    const app = createApp();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "hi" },
          source: { type: "group", groupId: "C123" },
          replyToken: "tok",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDatabase();
    const users = listLineUsers(db);
    expect(users).toHaveLength(0);
  });
});

describe("GET /internal/line-uids", () => {
  beforeEach(() => {
    process.env.SQLITE_PATH = ":memory:";
  });

  afterEach(() => {
    resetDatabaseForTests();
    delete process.env.INTERNAL_API_KEY;
    delete process.env.SQLITE_PATH;
  });

  test("returns 401 without API key", async () => {
    process.env.INTERNAL_API_KEY = "secret";
    process.env.SQLITE_PATH = ":memory:";
    const db = getDatabase();
    initSqlite(db);

    const internalMod = require("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/line-uids?key=wrong")
    );
    expect(res.status).toBe(401);
  });

  test("returns collected UIDs", async () => {
    process.env.INTERNAL_API_KEY = "test_key";
    process.env.SQLITE_PATH = ":memory:";
    const db = getDatabase();
    initSqlite(db);

    const { recordLineUserRequest } = require("../src/repositories/line-user.repository");
    recordLineUserRequest(db, "Uabc123", "message");
    recordLineUserRequest(db, "Udef456", "follow");

    const internalMod = require("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/line-uids?key=test_key")
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; uids: string[]; users: Array<{ line_uid: string }> };
    expect(body.count).toBe(2);
    expect(body.uids).toContain("Uabc123");
    expect(body.uids).toContain("Udef456");
    expect(body.users).toHaveLength(2);
  });

  test("returns empty list when no UIDs collected", async () => {
    process.env.INTERNAL_API_KEY = "test_key";
    process.env.SQLITE_PATH = ":memory:";
    const db = getDatabase();
    initSqlite(db);

    const internalMod = require("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/line-uids?key=test_key")
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; uids: string[]; users: unknown[] };
    expect(body.count).toBe(0);
    expect(body.uids).toEqual([]);
    expect(body.users).toEqual([]);
  });
});
