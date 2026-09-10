// apps/api/tests/internal-config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema";
import { createTestDb, closeTestDb } from "./db-helpers";
import { resetDbForTests, type DrizzleDb } from "../src/db/connection";
import {
  addWhitelistUid,
  insertTenantRow,
  getTenantRowById,
  listWhitelistUids,
  updateTenantLineIdentity,
  updateTenantTestResult,
} from "../src/repositories/tenant.repository";
import { getActiveUids } from "../src/repositories/recipient.repository";
import { recordLineUserRequest } from "../src/repositories/line-user.repository";
import { getTenantById, invalidateTenantCache } from "../src/services/tenant-config.service";
import type { TenantInput, TenantTestResult } from "../src/types/tenant.types";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const INTERNAL_KEY = "internal-config-test-key";
const TOKEN_PLAIN = "tok_plaintext_must_never_render";
const SECRET_PLAIN = "sec_plaintext_must_never_render";
const HFM_PLAIN = "hfm_plaintext_must_never_render";

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
process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
process.env.DATABASE_URL = TEST_DATABASE_URL;

const TENANT: TenantInput = {
  label: "oa-config-ui",
  active: true,
  lineChannelAccessToken: TOKEN_PLAIN,
  lineChannelSecret: SECRET_PLAIN,
  hfmApiKey: HFM_PLAIN,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 30506525,
  whitelistEnabled: true,
};

let tenantId = 0;

beforeEach(async () => {
  process.env.INTERNAL_API_KEY = INTERNAL_KEY;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  tenantId = await insertTenantRow(t.db, TENANT);
  await closeTestDb(t.client);
  // The routes resolve their own handle through getDb(); drop the cached
  // singleton so it reconnects to the freshly recreated test database.
  resetDbForTests();
});

afterEach(() => {
  delete process.env.INTERNAL_API_KEY;
  delete process.env.DATABASE_URL;
  resetDbForTests();
});

function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

// The session cookie embeds the CSRF token (see routes/internal-auth.ts),
// so the test can extract it exactly like the rendered form would carry it.
function csrfFromCookie(adminCookieValue: string): string {
  const value = adminCookieValue.slice(adminCookieValue.indexOf("=") + 1);
  return value.split(".")[1]!;
}

async function createInternalApp() {
  const internalMod = await import("../src/routes/internal");
  const app = new Hono();
  app.route("/internal", internalMod.default);
  return app;
}

// Log in with INTERNAL_API_KEY exactly like an operator browser would, then
// keep the httpOnly session cookie for subsequent requests.
async function adminCookie(app: Hono): Promise<string> {
  const login = await app.request("/internal/login", {
    method: "POST",
    body: formBody({ key: INTERNAL_KEY }),
  });
  expect(login.status).toBe(302);
  const setCookie = login.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return setCookie!.split(";")[0]!;
}

describe("GET /internal/config", () => {
  test("list shows never-tested badge for a fresh tenant", async () => {
    const app = await createInternalApp();
    const res = await app.request("/internal/config", {
      headers: { cookie: await adminCookie(app) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("never tested");
    expect(html).toContain("oa-config-ui");
    expect(html).not.toContain(TOKEN_PLAIN);
    expect(html).not.toContain(SECRET_PLAIN);
    expect(html).not.toContain(HFM_PLAIN);
  });

  test("unauthenticated list redirects to login", async () => {
    const app = await createInternalApp();
    const res = await app.request("/internal/config");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/internal/login");
  });
});

describe("GET /internal/config/:id and /new", () => {
  test("edit form shows csrf field and unchanged placeholders, never stored secrets", async () => {
    const app = await createInternalApp();
    const res = await app.request(`/internal/config/${tenantId}`, {
      headers: { cookie: await adminCookie(app) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="csrf"');
    expect(html).toContain("unchanged");
    expect(html).toContain("oa-config-ui");
    expect(html).not.toContain(TOKEN_PLAIN);
    expect(html).not.toContain(SECRET_PLAIN);
    expect(html).not.toContain(HFM_PLAIN);
  });

  test("new form renders with csrf field", async () => {
    const app = await createInternalApp();
    const res = await app.request("/internal/config/new", {
      headers: { cookie: await adminCookie(app) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="csrf"');
    expect(html).toContain('name="lineChannelAccessToken"');
  });

  test("unknown tenant id is 404", async () => {
    const app = await createInternalApp();
    const res = await app.request("/internal/config/9999", {
      headers: { cookie: await adminCookie(app) },
    });
    expect(res.status).toBe(404);
  });

  test("unauthenticated edit page redirects to login", async () => {
    const app = await createInternalApp();
    const res = await app.request(`/internal/config/${tenantId}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/internal/login");
  });
});

// POST /internal/config/:id and /new are the save path. Every test stubs
// globalThis.fetch, because the handler verifies the LINE token against
// api.line.me right after saving: tests must never reach the real network.
describe("POST /internal/config/:id (save)", () => {
  let app: Hono;
  let cookie: string;
  let csrf: string;
  let db: DrizzleDb;
  let client: postgres.Sql;
  const realFetch = globalThis.fetch;

  function stubBotInfo(body: {
    userId: string;
    basicId?: string;
    displayName?: string;
  }): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  // Default stub for tests that do not care about bot info: a failing
  // verification keeps the save path exercised without any network access.
  function stubFailedBotInfo(): typeof fetch {
    return (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  }

  function saveWithLabel(label: string): RequestInit {
    return {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        csrf,
        label,
        lineChannelAccessToken: "",
        lineChannelSecret: "",
        hfmApiKey: "",
        hfmApiBaseUrl: "https://api.hfaffiliates.com",
        targetWallet: "42",
        whitelistEnabled: "on",
        active: "on",
      }),
    };
  }

  beforeEach(async () => {
    globalThis.fetch = stubFailedBotInfo();
    invalidateTenantCache();
    app = await createInternalApp();
    cookie = await adminCookie(app);
    csrf = csrfFromCookie(cookie);
    client = postgres(TEST_DATABASE_URL, { max: 1 });
    db = drizzle(client, { schema });
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    invalidateTenantCache();
    await client.end();
  });

  test("save with empty secret fields keeps stored values", async () => {
    const before = await getTenantRowById(db, tenantId);
    await app.request(`/internal/config/${tenantId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf, label: "New label", lineChannelAccessToken: "", lineChannelSecret: "", hfmApiKey: "", hfmApiBaseUrl: "https://api.hfaffiliates.com", targetWallet: "42", whitelistEnabled: "on", active: "on" }),
    });
    const after = await getTenantRowById(db, tenantId);
    expect(after!.label).toBe("New label");
    expect(after!.lineChannelAccessTokenEnc).toBe(before!.lineChannelAccessTokenEnc);
  });

  test("save invalidates the tenant cache immediately", async () => {
    await getTenantById(tenantId); // prime cache
    await app.request(`/internal/config/${tenantId}`, saveWithLabel("Cache check"));
    expect((await getTenantById(tenantId))!.label).toBe("Cache check");
  });

  test("save fetches bot info and stores identity", async () => {
    globalThis.fetch = stubBotInfo({ userId: "U777", displayName: "My OA" });
    await app.request(`/internal/config/${tenantId}`, saveWithLabel("Identity"));
    const row = await getTenantRowById(db, tenantId);
    expect(row!.lineBotUserId).toBe("U777");
    expect(row!.lineDisplayName).toBe("My OA");
  });

  test("bot info failure still saves and shows a warning", async () => {
    globalThis.fetch = stubFailedBotInfo();
    const res = await app.request(`/internal/config/${tenantId}`, saveWithLabel("Warn me"));
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(decodeURIComponent(location)).toContain("LINE token could not be verified");
    // The warning is surfaced by the edit page the redirect points at.
    const page = await app.request(location, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("LINE token could not be verified");
    expect((await getTenantRowById(db, tenantId))!.label).toBe("Warn me");
  });

  test("save without csrf is rejected with 403", async () => {
    const res = await app.request(`/internal/config/${tenantId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ label: "No csrf" }),
    });
    expect(res.status).toBe(403);
  });

  test("save with a wrong csrf is rejected with 403", async () => {
    const res = await app.request(`/internal/config/${tenantId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf: "not-the-session-token", label: "Wrong csrf" }),
    });
    expect(res.status).toBe(403);
  });

  test("invalid input renders an error page with status 400", async () => {
    const res = await app.request("/internal/config/new", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        csrf,
        label: "",
        lineChannelAccessToken: "",
        lineChannelSecret: "",
        hfmApiKey: "",
        hfmApiBaseUrl: "http://insecure.example",
        targetWallet: "-1",
      }),
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("label is required");
    expect(html).toContain("access token is required");
    expect(html).toContain("base URL must be https");
    expect(html).toContain("target wallet must be a positive integer");
  });

  test("rotate changes the webhook id and shows old and new urls", async () => {
    const before = await getTenantRowById(db, tenantId);
    const res = await app.request(`/internal/config/${tenantId}/rotate`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf }),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(before!.webhookId);
    const after = await getTenantRowById(db, tenantId);
    expect(after!.webhookId).not.toBe(before!.webhookId);
    expect(html).toContain(after!.webhookId);
    expect(html).toContain("LINE Developers Console");
  });
});

// POST /internal/config/:id/test runs three upstream checks against the
// tenant's OWN stored credentials. Every test stubs globalThis.fetch,
// because the handler always calls api.line.me and the HFM API: tests must
// never reach the real network.
describe("POST /internal/config/:id/test", () => {
  let app: Hono;
  let cookie: string;
  let csrf: string;
  let db: DrizzleDb;
  let client: postgres.Sql;
  let testId = 0;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    // A second tenant whose LINE token starts with "line_ok" so the stub can
    // tell the LINE check from the HFM checks apart, with its own HFM key.
    client = postgres(TEST_DATABASE_URL, { max: 1 });
    db = drizzle(client, { schema });
    testId = await insertTenantRow(db, {
      ...TENANT,
      label: "oa-test-connection",
      lineChannelAccessToken: "line_ok_token",
      hfmApiKey: "hfm_own_key",
    });
    invalidateTenantCache();
    app = await createInternalApp();
    cookie = await adminCookie(app);
    csrf = csrfFromCookie(cookie);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    invalidateTenantCache();
    await client.end();
  });

  test("test stores a failing result and the list shows the badge", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const auth = String((init!.headers as Record<string, string>).Authorization);
      if (auth.startsWith("Bearer line_ok")) {
        return new Response(JSON.stringify({ userId: "U1" }), { status: 200 });
      }
      return new Response("nope", { status: 401 }); // HFM down
    }) as unknown as typeof fetch;

    const res = await app.request(`/internal/config/${testId}/test`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/internal/config/${testId}`);

    const row = await getTenantRowById(db, testId);
    expect(row!.lastTestedAt).not.toBeNull();
    const result = JSON.parse(row!.lastTestResult!) as TenantTestResult;
    expect(result.lineOk).toBe(true);
    expect(result.hfmOk).toBe(false);
    expect(result.walletOk).toBe(false);
    expect(result.message).toBe("LINE ok");
    const list = await (await app.request("/internal/config", { headers: { cookie } })).text();
    expect(list).toContain("test failed");
  });

  test("wallet check uses the tenant's own HFM key", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const auth = String(headers?.Authorization ?? "");
      if (auth.includes("hfm")) {
        seen.push(auth);
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await app.request(`/internal/config/${testId}/test`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf }),
    });
    // Two HFM-authed calls happen: the balance probe and the wallet
    // performance lookup. Both must carry this tenant's own key, never
    // another tenant's and never an env fallback.
    expect(seen.length).toBe(2);
    expect(seen.every((auth) => auth === "Bearer hfm_own_key")).toBe(true);
  });

  test("test without a valid csrf is rejected with 403", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const res = await app.request(`/internal/config/${testId}/test`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf: "not-the-session-token" }),
    });
    expect(res.status).toBe(403);
    const row = await getTenantRowById(db, testId);
    expect(row!.lastTestResult).toBeNull(); // nothing stored on a rejected post
  });

  test("edit page carries a test connection button and a status link", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const html = await (await app.request(`/internal/config/${testId}`, { headers: { cookie } })).text();
    expect(html).toContain(`action="/internal/config/${testId}/test"`);
    expect(html).toContain("Test connection");
    expect(html).toContain(`href="/internal/config/${testId}/status"`);
  });

  test("unknown tenant test is 404", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const res = await app.request("/internal/config/9999/test", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /internal/config/:id/status", () => {
  let app: Hono;
  let cookie: string;
  let db: DrizzleDb;
  let client: postgres.Sql;
  let testId = 0;

  beforeEach(async () => {
    client = postgres(TEST_DATABASE_URL, { max: 1 });
    db = drizzle(client, { schema });
    testId = await insertTenantRow(db, { ...TENANT, label: "oa-status-page" });
    invalidateTenantCache();
    app = await createInternalApp();
    cookie = await adminCookie(app);
  });

  afterEach(async () => {
    invalidateTenantCache();
    await client.end();
  });

  test("status page shows identity, wallet, test result, health, webhook, users, cache", async () => {
    await updateTenantLineIdentity(db, testId, {
      userId: "Ubot9",
      basicId: "@statbasic",
      displayName: "Status OA",
    });
    await updateTenantTestResult(db, testId, {
      lineOk: true,
      hfmOk: true,
      walletOk: false,
      message: "LINE ok, HFM ok",
    });
    await recordLineUserRequest(db, testId, "Ustatususer", "message");
    await db.insert(schema.tenantHealthState).values({ tenantId: testId, healthy: 0 });
    invalidateTenantCache();

    const res = await app.request(`/internal/config/${testId}/status`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Status OA");
    expect(html).toContain("@statbasic");
    expect(html).toContain("Ubot9");
    expect(html).toContain("active");
    expect(html).toContain(String(TENANT.targetWallet));
    expect(html).toContain("test failed"); // walletOk false
    expect(html).toContain("LINE ok, HFM ok");
    expect(html).toContain("unhealthy");
    expect(html).toContain("/webhook?oa=");
    expect(html).toContain("Ustatususer");
    expect(html).toContain("cold"); // last-trade cache not warmed
    expect(html).not.toContain(TOKEN_PLAIN);
    expect(html).not.toContain(SECRET_PLAIN);
    expect(html).not.toContain(HFM_PLAIN);
  });

  test("status page shows healthy and no-state cases without secrets", async () => {
    await db.insert(schema.tenantHealthState).values({ tenantId: testId, healthy: 1 });
    invalidateTenantCache();
    const html = await (await app.request(`/internal/config/${testId}/status`, { headers: { cookie } })).text();
    expect(html).toContain("healthy");
    expect(html).toContain("never tested");
    expect(html).toContain("No LINE user has talked to this OA yet.");
    expect(html).not.toContain(TOKEN_PLAIN);
  });

  test("unauthenticated status page redirects to login", async () => {
    const res = await app.request(`/internal/config/${testId}/status`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/internal/login");
  });

  test("unknown tenant status is 404", async () => {
    const res = await app.request("/internal/config/9999/status", { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});

// POST /internal/config/:id/whitelist and /internal/config/:id/recipients
// manage the per-tenant uid lists. The whitelist case mounts the webhook
// route too: the point of the first test is that an added uid authorises
// webhook traffic on the very next request, without a restart, thanks to
// the mandatory invalidateTenantCache. The webhook path may call the LINE
// reply API, so every test in this block stubs globalThis.fetch.
describe("POST /internal/config/:id/whitelist and /recipients", () => {
  let app: Hono;
  let cookie: string;
  let csrf: string;
  let db: DrizzleDb;
  let client: postgres.Sql;
  let idB = 0;
  const realFetch = globalThis.fetch;

  // Same escape sequences as the webhook route source: the "no access"
  // rejection text and the "wrong format" usage-help text.
  const REJECT_MARKER = "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E2A\u0E34\u0E17\u0E18\u0E34\u0E4C\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19\u0E1A\u0E2D\u0E17\u0E19\u0E35\u0E49";
  const FORMAT_MARKER = "\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07";

  function postForm(path: string, fields: Record<string, string>) {
    return app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf, ...fields }),
    });
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for webhook background work");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(async () => {
    client = postgres(TEST_DATABASE_URL, { max: 1 });
    db = drizzle(client, { schema });
    idB = await insertTenantRow(db, { ...TENANT, label: "oa-second-tenant" });
    invalidateTenantCache();
    const internalMod = await import("../src/routes/internal");
    const webhookMod = await import("../src/routes/webhook");
    app = new Hono();
    app.route("/internal", internalMod.default);
    app.route("/webhook", webhookMod.default);
    cookie = await adminCookie(app);
    csrf = csrfFromCookie(cookie);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    invalidateTenantCache();
    await client.end();
  });

  test("adding a whitelist uid takes effect on the next webhook without restart", async () => {
    // A pre-existing uid keeps the list non-empty. An empty list allows
    // everyone (old env behaviour), which would make this test pass even
    // if the endpoint forgot to invalidate the cache.
    await addWhitelistUid(db, tenantId, "Uexisting", null);
    await getTenantById(tenantId); // prime the cache with the OLD list

    const res = await postForm(`/internal/config/${tenantId}/whitelist`, {
      action: "add", lineUid: "Unew", label: "new guy",
    });
    expect(res.status).toBe(302);

    // Fresh read after the invalidation: the cached config now carries it.
    const ctx = await getTenantById(tenantId);
    expect(ctx!.whitelistUids).toContain("Unew");

    // A signed webhook from Unew must not be rejected. Rejection is visible
    // only in the LINE reply the bot sends (the webhook always answers
    // 200), so record outbound bodies and check what was answered.
    const recorded: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      recorded.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const webhookId = (await getTenantRowById(db, tenantId))!.webhookId;
    const raw = JSON.stringify({
      destination: "UdestWhitelist",
      events: [{
        type: "message",
        replyToken: "rt_whitelist_add",
        source: { type: "user", userId: "Unew" },
        message: { type: "text", text: "hello" },
      }],
    });
    const sig = createHmac("sha256", SECRET_PLAIN).update(raw).digest("base64");
    const webhookRes = await app.request(`/webhook?oa=${webhookId}`, {
      method: "POST",
      headers: { "x-line-signature": sig, "content-type": "application/json" },
      body: raw,
    });
    expect(webhookRes.status).toBe(200);

    // The reply is sent in the background: wait for it, then assert it is
    // the usage-help text of the whitelisted path, never the rejection.
    await waitFor(() => recorded.length > 0);
    const joined = recorded.join("\n");
    expect(joined).not.toContain(REJECT_MARKER);
    expect(joined).toContain(FORMAT_MARKER);
  });

  test("notify recipients are per tenant", async () => {
    const resA = await postForm(`/internal/config/${tenantId}/recipients`, {
      action: "add", lineUid: "Ur1", label: "boss A",
    });
    const resB = await postForm(`/internal/config/${idB}/recipients`, {
      action: "add", lineUid: "Ur2", label: "boss B",
    });
    expect(resA.status).toBe(302);
    expect(resB.status).toBe(302);
    expect(await getActiveUids(db, tenantId)).toEqual(["Ur1"]);
    expect(await getActiveUids(db, idB)).toEqual(["Ur2"]);
  });

  test("removing a whitelist uid is visible on a fresh read", async () => {
    await addWhitelistUid(db, tenantId, "Ugone", null);
    await addWhitelistUid(db, tenantId, "Ustays", null);
    await getTenantById(tenantId); // prime the cache
    const res = await postForm(`/internal/config/${tenantId}/whitelist`, {
      action: "remove", lineUid: "Ugone",
    });
    expect(res.status).toBe(302);
    const ctx = await getTenantById(tenantId);
    expect(ctx!.whitelistUids).not.toContain("Ugone");
    expect(ctx!.whitelistUids).toContain("Ustays");
  });

  test("removing a recipient works through the same endpoint", async () => {
    await postForm(`/internal/config/${tenantId}/recipients`, {
      action: "add", lineUid: "Ubye",
    });
    const res = await postForm(`/internal/config/${tenantId}/recipients`, {
      action: "remove", lineUid: "Ubye",
    });
    expect(res.status).toBe(302);
    expect(await getActiveUids(db, tenantId)).toEqual([]);
  });

  test("whitelist mutation without a valid csrf is rejected with 403", async () => {
    const res = await app.request(`/internal/config/${tenantId}/whitelist`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ action: "add", lineUid: "Uevil" }),
    });
    expect(res.status).toBe(403);
    expect(await listWhitelistUids(db, tenantId)).toEqual([]);
  });

  test("recipient mutation with a wrong csrf is rejected with 403", async () => {
    const res = await app.request(`/internal/config/${tenantId}/recipients`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ csrf: "not-the-session-token", action: "add", lineUid: "Uevil" }),
    });
    expect(res.status).toBe(403);
    expect(await getActiveUids(db, tenantId)).toEqual([]);
  });

  test("invalid action or empty uid renders a 400 error page", async () => {
    const badAction = await postForm(`/internal/config/${tenantId}/whitelist`, {
      action: "nuke", lineUid: "Uok",
    });
    expect(badAction.status).toBe(400);
    expect(await badAction.text()).toContain("action must be add or remove");

    const emptyUid = await postForm(`/internal/config/${tenantId}/recipients`, {
      action: "add", lineUid: "  ",
    });
    expect(emptyUid.status).toBe(400);
    expect(await emptyUid.text()).toContain("line uid is required");
  });

  test("unknown tenant id is 404 for both endpoints", async () => {
    expect((await postForm("/internal/config/9999/whitelist", {
      action: "add", lineUid: "Ux",
    })).status).toBe(404);
    expect((await postForm("/internal/config/9999/recipients", {
      action: "add", lineUid: "Ux",
    })).status).toBe(404);
  });

  test("detail page renders both lists with remove buttons and add forms", async () => {
    await addWhitelistUid(db, tenantId, "Ushown", "shown guy");
    await db.insert(schema.notifyRecipients).values({
      tenantId, lineUid: "Urshown", label: "shown recipient",
    });
    const html = await (await app.request(`/internal/config/${tenantId}`, {
      headers: { cookie },
    })).text();
    expect(html).toContain("Whitelist uids");
    expect(html).toContain("Notify recipients");
    expect(html).toContain("Ushown");
    expect(html).toContain("Urshown");
    expect(html).toContain(`action="/internal/config/${tenantId}/whitelist"`);
    expect(html).toContain(`action="/internal/config/${tenantId}/recipients"`);
    // remove button (action=remove) and add form (action=add) both present
    expect(html).toContain('value="remove"');
    expect(html).toContain('value="add"');
    expect(html).toContain("Remove");
    expect(html).toContain("Add");
  });
});
