import { test, expect, describe, afterEach } from "bun:test";
import { Hono } from "hono";
import { resetDatabaseForTests, getDatabase, initSqlite } from "../src/services/sqlite.service";

const ORIGINAL_FETCH = globalThis.fetch;

describe("GET /internal/health", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetDatabaseForTests();
    delete process.env.INTERNAL_API_KEY;
    delete process.env.HFM_API_BASE_URL;
  });

  function createApp() {
    process.env.INTERNAL_API_KEY = "test_key";
    process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
    process.env.SQLITE_PATH = ":memory:";
    const db = getDatabase();
    initSqlite(db);

    const internalMod = require("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);
    return app;
  }

  test("returns 401 without API key", async () => {
    process.env.INTERNAL_API_KEY = "secret";
    process.env.SQLITE_PATH = ":memory:";
    const db = getDatabase();
    initSqlite(db);

    const internalMod = require("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/health?key=wrong")
    );
    expect(res.status).toBe(401);
  });

  test("returns healthy when database and HFM API are up", async () => {
    const app = createApp();

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
    const app = createApp();

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
    const app = createApp();

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
