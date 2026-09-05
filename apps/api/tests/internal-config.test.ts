// apps/api/tests/internal-config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, closeTestDb } from "./db-helpers";
import { resetDbForTests } from "../src/db/connection";
import { insertTenantRow } from "../src/repositories/tenant.repository";
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
