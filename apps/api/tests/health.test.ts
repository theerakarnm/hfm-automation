import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { initDb, resetDbForTests } from "../src/db/connection";
import { insertTenantRow } from "../src/repositories/tenant.repository";
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

const TENANT_INPUT = (label: string): TenantInput => ({
  label,
  active: true,
  lineChannelAccessToken: `tok_${label}`,
  lineChannelSecret: `sec_${label}`,
  hfmApiKey: `hfm_${label}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 30506525,
  whitelistEnabled: true,
});

let tenantIdA = 0;
let tenantIdB = 0;

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
  tenantIdA = await insertTenantRow(db, TENANT_INPUT("health-A"));
  tenantIdB = await insertTenantRow(db, TENANT_INPUT("health-B"));
  // Tenant A has a recorded "down" state; tenant B has none, which must
  // report the healthy default.
  await db.execute(sql`
    INSERT INTO tenant_health_state (tenant_id, healthy) VALUES (${tenantIdA}, 0)
  `);
  await client.end();
  invalidateTenantCache();
  resetDbForTests();
}

describe("GET /internal/health", () => {
  beforeEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INTERNAL_API_KEY = "test_key";
    await setupTestDb();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
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
      new Request("http://localhost/internal/health?key=wrong")
    );
    expect(res.status).toBe(401);
  });

  test("returns healthy when the database is up; no hfm_api check exists", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/health?key=test_key")
    );
    const body = await res.json() as { status: string; checks: Record<string, string> };
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks.database).toBe("ok");
    expect(body.checks.hfm_api).toBeUndefined();
  });

  test("stays 200 even when the HFM upstream is unreachable", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof globalThis.fetch;

    const res = await app.fetch(
      new Request("http://localhost/internal/health?key=test_key")
    );
    const body = await res.json() as { status: string; checks: Record<string, string> };
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks.database).toBe("ok");
    expect(body.checks.hfm_api).toBeUndefined();
  });

  test("GET /internal/health/tenants returns one entry per tenant", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/health/tenants?key=test_key")
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tenants: Array<{
        id: number;
        label: string;
        active: boolean;
        healthy: number;
        changedAt: string | null;
      }>;
    };
    expect(body.tenants).toHaveLength(2);
    const entryA = body.tenants.find((t) => t.id === tenantIdA)!;
    const entryB = body.tenants.find((t) => t.id === tenantIdB)!;
    expect(entryA.label).toBe("health-A");
    expect(entryA.active).toBe(true);
    expect(entryA.healthy).toBe(0);
    expect(entryA.changedAt).not.toBeNull();
    expect(entryB.label).toBe("health-B");
    expect(entryB.healthy).toBe(1);
    expect(entryB.changedAt).toBeNull();
  });
});
