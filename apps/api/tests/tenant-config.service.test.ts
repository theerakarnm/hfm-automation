// apps/api/tests/tenant-config.service.test.ts
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  getTenantById,
  getTenantByWebhookId,
  listActiveTenants,
  saveTenant,
  invalidateTenantCache,
  TENANT_CACHE_TTL_MS,
  __setTenantClockForTests,
} from "../src/services/tenant-config.service";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { listWhitelistUids, addWhitelistUid } from "../src/repositories/tenant.repository";
import { getTenantRowById } from "../src/repositories/tenant.repository";
import { resetDbForTests } from "../src/db/connection";
import type { DrizzleDb } from "../src/db/connection";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;
let fakeNow = 1_000_000;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  __setTenantClockForTests(() => fakeNow);
});

afterAll(async () => {
  await closeTestDb(client);
  resetDbForTests();
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  invalidateTenantCache();
  fakeNow = 1_000_000;
});

describe("tenant-config.service", () => {
  test("resolves a decrypted TenantConfig with whitelist uids", async () => {
    const id = await insertTenantRow(db, {
      label: "A",
      active: true,
      lineChannelAccessToken: "tokA",
      lineChannelSecret: "secA",
      hfmApiKey: "keyA",
      hfmApiBaseUrl: "https://api.hfaffiliates.com",
      targetWallet: 111,
      whitelistEnabled: true,
    });
    await addWhitelistUid(db, id, "U1", null);
    await addWhitelistUid(db, id, "U2", null);

    const ctx = await getTenantById(id);
    expect(ctx!.lineChannelAccessToken).toBe("tokA");
    expect(ctx!.lineChannelSecret).toBe("secA");
    expect(ctx!.hfmApiKey).toBe("keyA");
    expect(ctx!.targetWallet).toBe(111);
    expect(ctx!.whitelistUids).toEqual(["U1", "U2"]);
    expect(ctx!.active).toBe(true);
  });

  test("getTenantByWebhookId finds the same tenant", async () => {
    const id = (await listActiveTenants())[0]!.id;
    const byId = await getTenantById(id);
    const byWebhook = await getTenantByWebhookId(byId!.webhookId);
    expect(byWebhook!.id).toBe(id);
  });

  test("unknown webhook id returns null, inactive tenants excluded from list", async () => {
    expect(await getTenantByWebhookId("nope")).toBeNull();
    const id2 = await saveTenant({
      label: "B",
      active: false,
      lineChannelAccessToken: "tokB",
      lineChannelSecret: "secB",
      hfmApiKey: "keyB",
      hfmApiBaseUrl: "https://api.hfaffiliates.com",
      targetWallet: 222,
      whitelistEnabled: true,
    });
    const actives = await listActiveTenants();
    expect(actives.find((t) => t.id === id2)).toBeUndefined();
  });

  test("saveTenant update keeps secrets when fields are empty strings", async () => {
    const id = await saveTenant({
      label: "C",
      active: true,
      lineChannelAccessToken: "tokC",
      lineChannelSecret: "secC",
      hfmApiKey: "keyC",
      hfmApiBaseUrl: "https://api.hfaffiliates.com",
      targetWallet: 333,
      whitelistEnabled: true,
    });
    await saveTenant(
      {
        label: "C2",
        active: true,
        lineChannelAccessToken: "",
        lineChannelSecret: "",
        hfmApiKey: "",
        hfmApiBaseUrl: "https://api.hfaffiliates.com",
        targetWallet: 334,
        whitelistEnabled: true,
      },
      id,
    );
    const ctx = await getTenantById(id);
    expect(ctx!.label).toBe("C2");
    expect(ctx!.lineChannelAccessToken).toBe("tokC");
    expect(ctx!.targetWallet).toBe(334);
  });

  test("cache is used within TTL and expires after TTL", async () => {
    const id = (await listActiveTenants()).find((t) => t.label === "A")!.id;
    const first = await getTenantById(id);
    await addWhitelistUid(db, id, "U3", null);
    const cached = await getTenantById(id);
    expect(cached!.whitelistUids).toEqual(first!.whitelistUids); // still cached
    fakeNow += TENANT_CACHE_TTL_MS + 1;
    const fresh = await getTenantById(id);
    expect(fresh!.whitelistUids).toContain("U3"); // cache expired
  });

  test("invalidateTenantCache takes effect immediately", async () => {
    const id = (await listActiveTenants()).find((t) => t.label === "A")!.id;
    await getTenantById(id);
    await addWhitelistUid(db, id, "U4", null);
    invalidateTenantCache(id);
    expect((await getTenantById(id))!.whitelistUids).toContain("U4");
  });

  test("saveTenant invalidates the cache for the saved tenant", async () => {
    const id = (await listActiveTenants()).find((t) => t.label === "A")!.id;
    await getTenantById(id);
    await saveTenant(
      {
        label: "A",
        active: true,
        lineChannelAccessToken: "tokA2",
        lineChannelSecret: "secA",
        hfmApiKey: "keyA",
        hfmApiBaseUrl: "https://api.hfaffiliates.com",
        targetWallet: 111,
        whitelistEnabled: true,
      },
      id,
    );
    expect((await getTenantById(id))!.lineChannelAccessToken).toBe("tokA2");
  });
});
