// apps/api/tests/bootstrap.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { seedDefaultTenantFromEnv } from "../src/db/bootstrap";
import { countTenants } from "../src/repositories/tenant.repository";
import { getActiveUids } from "../src/repositories/recipient.repository";
import { getTenantConfigForTests } from "../src/services/tenant-config.service";
import { resetDbForTests } from "../src/db/connection";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  db = t.db;
  client = t.client;
});

afterAll(async () => {
  await closeTestDb(client);
  resetDbForTests();
  delete process.env.DATABASE_URL;
});

describe("bootstrap seed", () => {
  test("seeds one tenant from env exactly once", async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "prod_token";
    process.env.LINE_CHANNEL_SECRET = "prod_secret";
    process.env.HFM_API_KEY = "prod_hfm_key";
    process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
    process.env.TARGET_WALLET = "30506525";
    process.env.LINE_WHITELIST_ENABLED = "true";
    process.env.LINE_WHITELIST_UIDS = "Uw1,Uw2";
    process.env.LINE_NOTIFY_UIDS = "Un1,Un2";

    const id = await seedDefaultTenantFromEnv(db);
    expect(id).not.toBeNull();
    expect(await countTenants(db)).toBe(1);

    const ctx = await getTenantConfigForTests(db, id!);
    expect(ctx!.lineChannelAccessToken).toBe("prod_token");
    expect(ctx!.targetWallet).toBe(30506525);
    expect(ctx!.whitelistUids).toEqual(["Uw1", "Uw2"]);
    expect(await getActiveUids(db, id!)).toEqual(["Un1", "Un2"]);

    // Second boot must not seed again, even if env still present.
    const again = await seedDefaultTenantFromEnv(db);
    expect(again).toBeNull();
    expect(await countTenants(db)).toBe(1);
  });

  test("no env vars and empty table seeds nothing", async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_SECRET;
    delete process.env.HFM_API_KEY;
    expect(await seedDefaultTenantFromEnv(db)).toBeNull();
  });
});
