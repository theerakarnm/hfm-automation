// apps/api/tests/internal-config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema";
import { createTestDb, closeTestDb } from "./db-helpers";
import { resetDbForTests, type DrizzleDb } from "../src/db/connection";
import { insertTenantRow, getTenantRowById } from "../src/repositories/tenant.repository";
import { getTenantById, invalidateTenantCache } from "../src/services/tenant-config.service";
import type { TenantInput } from "../src/types/tenant.types";

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

  // The session cookie embeds the CSRF token (see routes/internal-auth.ts),
  // so the test can extract it exactly like the rendered form would carry it.
  function csrfFromCookie(adminCookieValue: string): string {
    const value = adminCookieValue.slice(adminCookieValue.indexOf("=") + 1);
    return value.split(".")[1]!;
  }

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
