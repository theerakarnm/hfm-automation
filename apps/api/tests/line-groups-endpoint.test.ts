import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb, getDb, resetDbForTests } from "../src/db/connection";
import { recordLineGroupEvent } from "../src/repositories/line-group.repository";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5433/hfm_test";

async function setupTestDb(): Promise<void> {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`DROP TABLE IF EXISTS line_groups CASCADE;`);
  await initDb(db);
  await client.end();
  resetDbForTests();
}

async function createApp(): Promise<Hono> {
  const internalMod = await import("../src/routes/internal");
  const app = new Hono();
  app.route("/internal", internalMod.default);
  return app;
}

describe("GET /internal/line-groups", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INTERNAL_API_KEY = "test_key";
    await setupTestDb();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  test("returns 401 without the API key", async () => {
    const app = await createApp();
    const res = await app.fetch(
      new Request("http://localhost/internal/line-groups?key=wrong")
    );
    expect(res.status).toBe(401);
  });

  test("returns an empty list when the bot is in no group", async () => {
    const app = await createApp();
    const res = await app.fetch(
      new Request("http://localhost/internal/line-groups?key=test_key")
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { count: number; groups: unknown[] };
    expect(json.count).toBe(0);
    expect(json.groups).toEqual([]);
  });

  test("returns the recorded groups", async () => {
    const db = getDb();
    await recordLineGroupEvent(db, {
      chatId: "Cgroup1",
      chatType: "group",
      eventType: "join",
    });

    const app = await createApp();
    const res = await app.fetch(
      new Request("http://localhost/internal/line-groups?key=test_key")
    );
    const json = (await res.json()) as {
      count: number;
      groups: Array<{ chat_id: string; chat_type: string; active: number }>;
    };
    expect(json.count).toBe(1);
    expect(json.groups[0]?.chat_id).toBe("Cgroup1");
    expect(json.groups[0]?.chat_type).toBe("group");
    expect(json.groups[0]?.active).toBe(1);
  });
});
