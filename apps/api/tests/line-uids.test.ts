import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { initDb, resetDbForTests, getDb } from "../src/db/connection";
import {
  insertTenantRow,
  getTenantRowById,
} from "../src/repositories/tenant.repository";
import { listLineUsers } from "../src/repositories/line-user.repository";
import { invalidateTenantCache } from "../src/services/tenant-config.service";
import type { TenantInput } from "../src/types/tenant.types";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const ORIGINAL_FETCH = globalThis.fetch;

// Bun auto-loads apps/api/.env into process.env. The per-OA values would
// make the bootstrap seed run on any initDb call, and the real DATABASE_URL
// would point the routes' getDb() default at a non-test database.
function clearPerOaEnv() {
  for (const key of [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_SECRET",
    "HFM_API_KEY",
    "TARGET_WALLET",
    "LINE_WHITELIST_UIDS",
    "LINE_NOTIFY_UIDS",
  ]) {
    delete process.env[key];
  }
}

clearPerOaEnv();
process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
process.env.DATABASE_URL = TEST_DATABASE_URL;
resetDbForTests();

const SECRET_A = "test_channel_secret_A";
const SECRET_B = "test_channel_secret_B";
const LABEL_A = "oa-alpha";
const LABEL_B = "oa-beta";

let tenantIdA = 0;
let tenantIdB = 0;
let webhookIdA = "";
let webhookIdB = "";

const TENANT_INPUT = (label: string, secret: string): TenantInput => ({
  label,
  active: true,
  lineChannelAccessToken: `tok_${label}`,
  lineChannelSecret: secret,
  hfmApiKey: `hfm_${label}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 30506525,
  whitelistEnabled: true,
});

function computeSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

// The webhook records line_users fire-and-forget, so the row lands shortly
// after the response. Returns whatever it has at the timeout so the
// caller's toHaveLength assertion still reports a useful diff.
async function waitForUsers(
  db: ReturnType<typeof getDb>,
  tenantId: number,
  count: number,
  timeoutMs = 1000,
): Promise<Awaited<ReturnType<typeof listLineUsers>>> {
  const startedAt = Date.now();
  for (;;) {
    const users = await listLineUsers(db, tenantId);
    if (users.length >= count) return users;
    if (Date.now() - startedAt > timeoutMs) return users;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setupTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });
  await db.execute(sql`
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
    DROP TABLE IF EXISTS tenant_health_state CASCADE;
    DROP TABLE IF EXISTS tenant_whitelist_uids CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
  `);
  await initDb(db);
  tenantIdA = await insertTenantRow(db, TENANT_INPUT(LABEL_A, SECRET_A));
  tenantIdB = await insertTenantRow(db, TENANT_INPUT(LABEL_B, SECRET_B));
  webhookIdA = (await getTenantRowById(db, tenantIdA))!.webhookId;
  webhookIdB = (await getTenantRowById(db, tenantIdB))!.webhookId;
  await client.end();
  // Fresh tenant ids reuse the same numbers, so a cached config from the
  // previous test (or another test file) must never leak in.
  invalidateTenantCache();
  resetDbForTests();
}

describe("webhook UID collection", () => {
  beforeEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await setupTestDb();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.INTERNAL_API_KEY;
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  test("collects UID from text message event", async () => {
    const app = await createApp();
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
    const sig = computeSig(body, SECRET_A);

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    await app.fetch(
      new Request(`http://localhost/webhook?oa=${webhookIdA}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDb();
    const users = await waitForUsers(db, tenantIdA, 1);
    expect(users).toHaveLength(1);
    expect(users[0]!.line_uid).toBe("Umsg001");
  });

  test("collects UID from follow event (non-text)", async () => {
    const app = await createApp();
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
    const sig = computeSig(body, SECRET_A);

    await app.fetch(
      new Request(`http://localhost/webhook?oa=${webhookIdA}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDb();
    const users = await waitForUsers(db, tenantIdA, 1);
    expect(users).toHaveLength(1);
    expect(users[0]!.line_uid).toBe("Ufollow001");
    expect(users[0]!.last_event_type).toBe("follow");
  });

  test("does NOT collect UID when signature is invalid", async () => {
    const app = await createApp();
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
      new Request(`http://localhost/webhook?oa=${webhookIdA}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": "invalid_sig",
        },
        body,
      })
    );

    const db = getDb();
    const users = await listLineUsers(db, tenantIdA);
    expect(users).toHaveLength(0);
  });

  test("collects multiple UIDs from multiple events", async () => {
    const app = await createApp();
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
    const sig = computeSig(body, SECRET_A);

    await app.fetch(
      new Request(`http://localhost/webhook?oa=${webhookIdA}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDb();
    const users = await waitForUsers(db, tenantIdA, 2);
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.line_uid).sort()).toEqual(["Uuser1", "Uuser2"]);
  });

  test("skips events without userId (group source)", async () => {
    const app = await createApp();
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
    const sig = computeSig(body, SECRET_A);

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    await app.fetch(
      new Request(`http://localhost/webhook?oa=${webhookIdA}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-line-signature": sig },
        body,
      })
    );

    const db = getDb();
    const users = await listLineUsers(db, tenantIdA);
    expect(users).toHaveLength(0);
  });
});

describe("GET /internal/line-uids", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INTERNAL_API_KEY = "internal_key";
    await setupTestDb();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  test("returns 401 without API key", async () => {
    process.env.INTERNAL_API_KEY = "secret";

    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/line-uids?key=wrong")
    );
    expect(res.status).toBe(401);
  });

  test("with ?tenant=<id> returns only that tenant's uids", async () => {
    process.env.INTERNAL_API_KEY = "test_key";

    const { recordLineUserRequest } = await import("../src/repositories/line-user.repository");
    const db = getDb();
    await recordLineUserRequest(db, tenantIdA, "Ualpha1", "message");
    await recordLineUserRequest(db, tenantIdA, "Ualpha2", "follow");
    await recordLineUserRequest(db, tenantIdB, "Ubeta1", "message");

    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request(`http://localhost/internal/line-uids?key=test_key&tenant=${tenantIdA}`)
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tenant: { id: number; label: string };
      count: number;
      uids: string[];
      users: Array<{ line_uid: string }>;
    };
    expect(body.tenant.id).toBe(tenantIdA);
    expect(body.tenant.label).toBe(LABEL_A);
    expect(body.count).toBe(2);
    expect(body.uids).toContain("Ualpha1");
    expect(body.uids).toContain("Ualpha2");
    expect(body.uids).not.toContain("Ubeta1");
    expect(body.users).toHaveLength(2);
  });

  test("?tenant also resolves by webhook id and label", async () => {
    process.env.INTERNAL_API_KEY = "test_key";

    const { recordLineUserRequest } = await import("../src/repositories/line-user.repository");
    const db = getDb();
    await recordLineUserRequest(db, tenantIdB, "Ubeta1", "message");

    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    for (const selector of [webhookIdB, LABEL_B]) {
      const res = await app.fetch(
        new Request(`http://localhost/internal/line-uids?key=test_key&tenant=${encodeURIComponent(selector)}`)
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { tenant: { id: number }; uids: string[] };
      expect(body.tenant.id).toBe(tenantIdB);
      expect(body.uids).toEqual(["Ubeta1"]);
    }
  });

  test("unknown tenant selector returns 404", async () => {
    process.env.INTERNAL_API_KEY = "test_key";

    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/line-uids?key=test_key&tenant=no-such-tenant")
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unknown tenant");
  });

  test("without ?tenant returns every tenant's uids grouped", async () => {
    process.env.INTERNAL_API_KEY = "test_key";

    const { recordLineUserRequest } = await import("../src/repositories/line-user.repository");
    const db = getDb();
    await recordLineUserRequest(db, tenantIdA, "Ualpha1", "message");
    await recordLineUserRequest(db, tenantIdB, "Ubeta1", "message");
    await recordLineUserRequest(db, tenantIdB, "Ubeta2", "follow");

    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/line-uids?key=test_key")
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tenants: Array<{
        tenant: { id: number; label: string };
        users: Array<{ line_uid: string }>;
      }>;
    };
    expect(body.tenants).toHaveLength(2);
    const entryA = body.tenants.find((t) => t.tenant.id === tenantIdA)!;
    const entryB = body.tenants.find((t) => t.tenant.id === tenantIdB)!;
    expect(entryA.tenant.label).toBe(LABEL_A);
    expect(entryA.users.map((u) => u.line_uid)).toEqual(["Ualpha1"]);
    expect(entryB.tenant.label).toBe(LABEL_B);
    expect(entryB.users.map((u) => u.line_uid).sort()).toEqual(["Ubeta1", "Ubeta2"]);
  });

  test("with ?tenant=<A> returns empty list when A has no uids", async () => {
    process.env.INTERNAL_API_KEY = "test_key";

    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request(`http://localhost/internal/line-uids?key=test_key&tenant=${tenantIdA}`)
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; uids: string[]; users: unknown[] };
    expect(body.count).toBe(0);
    expect(body.uids).toEqual([]);
    expect(body.users).toEqual([]);
  });
});

async function createApp() {
  resetDbForTests();
  const webhookMod = await import("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return app;
}
