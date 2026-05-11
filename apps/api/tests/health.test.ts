import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb, resetDbForTests } from "../src/db/connection";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const ORIGINAL_FETCH = globalThis.fetch;

describe("GET /internal/health", () => {
  beforeEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INTERNAL_API_KEY = "test_key";
    process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";

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
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.INTERNAL_API_KEY;
    delete process.env.HFM_API_BASE_URL;
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

  test("returns healthy when database and HFM API are up", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    globalThis.fetch = (async () => {
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const res = await app.fetch(
      new Request("http://localhost/internal/health?key=test_key")
    );
    const body = await res.json() as { status: string; checks: Record<string, string> };
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks.database).toBe("ok");
    expect(body.checks.hfm_api).toBe("ok");
  });

  test("returns 503 when HFM API is down", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    globalThis.fetch = (async () => {
      return new Response(null, { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const res = await app.fetch(
      new Request("http://localhost/internal/health?key=test_key")
    );
    const body = await res.json() as { status: string; checks: Record<string, string> };
    expect(res.status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.database).toBe("ok");
    expect(body.checks.hfm_api).toBe("error");
  });

  test("returns 503 when HFM API throws", async () => {
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
    expect(res.status).toBe(503);
    expect(body.checks.hfm_api).toBe("error");
  });
});
