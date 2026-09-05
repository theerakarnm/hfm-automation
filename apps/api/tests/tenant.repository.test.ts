// apps/api/tests/tenant.repository.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  insertTenantRow,
  getTenantRowByWebhookId,
  getTenantRowById,
  listTenantRows,
  updateTenantRow,
  updateTenantLineIdentity,
  updateTenantTestResult,
  rotateWebhookId,
  countTenants,
  listWhitelistUids,
  addWhitelistUid,
  removeWhitelistUid,
} from "../src/repositories/tenant.repository";
import type { DrizzleDb } from "../src/db/connection";
import type { TenantInput } from "../src/types/tenant.types";
import { encryptSecret } from "../src/utils/crypto";
import { createTestDb, closeTestDb } from "./db-helpers";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");

const INPUT: TenantInput = {
  label: "OA Test",
  active: true,
  lineChannelAccessToken: "tok_a",
  lineChannelSecret: "sec_a",
  hfmApiKey: "hfm_a",
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 30506525,
  whitelistEnabled: true,
};

let db: DrizzleDb;
let client: ReturnType<typeof import("postgres")>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  client = t.client;
});

afterAll(async () => {
  await closeTestDb(client);
});

describe("tenant.repository", () => {
  test("insert, read by webhook id, list, count", async () => {
    const id = await insertTenantRow(db, INPUT);
    expect(id).toBeGreaterThan(0);
    const row = await getTenantRowByWebhookId(db, (await getTenantRowById(db, id))!.webhookId);
    expect(row!.label).toBe("OA Test");
    expect(row!.lineChannelAccessTokenEnc).not.toBe("tok_a");
    expect((await listTenantRows(db)).length).toBe(1);
    expect(await countTenants(db)).toBe(1);
  });

  test("webhook ids are UUID shaped", async () => {
    const rows = await listTenantRows(db);
    expect(rows[0]!.webhookId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("updateTenantRow with a partial input keeps stored secrets", async () => {
    const rows = await listTenantRows(db);
    const before = rows[0]!.lineChannelAccessTokenEnc;
    await updateTenantRow(db, rows[0]!.id, { label: "Renamed" });
    const after = (await getTenantRowById(db, rows[0]!.id))!;
    expect(after.label).toBe("Renamed");
    expect(after.lineChannelAccessTokenEnc).toBe(before);
  });

  test("line identity, test result, webhook rotation", async () => {
    const id = (await listTenantRows(db))[0]!.id;
    await updateTenantLineIdentity(db, id, {
      userId: "U123",
      basicId: "@abc",
      displayName: "Test OA",
    });
    await updateTenantTestResult(db, id, {
      lineOk: true,
      hfmOk: false,
      walletOk: true,
      message: "hfm 401",
    });
    const before = (await getTenantRowById(db, id))!.webhookId;
    const rotated = await rotateWebhookId(db, id);
    expect(rotated).not.toBe(before);
    expect((await getTenantRowById(db, id))!.webhookId).toBe(rotated);
    const row = await getTenantRowById(db, id);
    expect(row!.lineBotUserId).toBe("U123");
    expect(row!.lastTestResult).toContain("hfm 401");
    expect(row!.lastTestedAt).not.toBeNull();
  });

  test("whitelist uid add, list, remove, dedupe", async () => {
    const id = (await listTenantRows(db))[0]!.id;
    await addWhitelistUid(db, id, "Uaaa", "boss");
    await addWhitelistUid(db, id, "Ubbb", null);
    await addWhitelistUid(db, id, "Uaaa", "duplicate"); // onConflictDoNothing
    expect(await listWhitelistUids(db, id)).toEqual(["Uaaa", "Ubbb"]);
    await removeWhitelistUid(db, id, "Uaaa");
    expect(await listWhitelistUids(db, id)).toEqual(["Ubbb"]);
  });

  test("stored ciphertext is decryptable by the config layer", async () => {
    const row = (await listTenantRows(db))[0]!;
    // Round trip through the real crypto module, proving the stored format.
    expect(encryptSecret("x")).not.toBeNull();
    const { decryptSecret } = await import("../src/utils/crypto");
    expect(decryptSecret(row.lineChannelSecretEnc)).toBe("sec_a");
  });
});
