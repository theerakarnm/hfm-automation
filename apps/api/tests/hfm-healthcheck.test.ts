import { expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import {
  runHfmHealthCheckForTenant,
  runHfmHealthCheckAll,
  getTenantHealthState,
} from "../src/jobs/hfm-healthcheck";
import { resetDbForTests } from "../src/db/connection";
import type { DrizzleDb } from "../src/db/connection";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { addRecipient } from "../src/repositories/recipient.repository";
import { invalidateTenantCache } from "../src/services/tenant-config.service";
import type { TenantConfig, TenantInput } from "../src/types/tenant.types";
import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type postgres from "postgres";

// Bun auto-loads apps/api/.env into process.env. The per-OA values would make
// the bootstrap seed run on any initDb call, and the real DATABASE_URL would
// point the healthcheck's getDb() default at a non-test database. Clear and
// override them before any schema or db work happens in this file.
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
process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
process.env.DATABASE_URL = TEST_DATABASE_URL;
resetDbForTests();

const UID_A = "U_recipient_tenant_A";
const UID_B = "U_recipient_tenant_B";

const TENANT_INPUT = (label: string): TenantInput => ({
  label,
  active: true,
  lineChannelAccessToken: `tok_${label}`,
  lineChannelSecret: `sec_${label}`,
  hfmApiKey: `hfm_${label}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 111 * label.charCodeAt(0),
  whitelistEnabled: true,
});

function makeCtx(id: number, label: string): TenantConfig {
  return {
    id,
    webhookId: `webhook-${label.toLowerCase()}`,
    label,
    active: true,
    lineChannelAccessToken: `tok_${label}`,
    lineChannelSecret: `sec_${label}`,
    lineBotUserId: null,
    lineBasicId: null,
    lineDisplayName: null,
    hfmApiKey: `hfm_${label}`,
    hfmApiBaseUrl: "https://api.hfaffiliates.com",
    targetWallet: 111 * label.charCodeAt(0),
    whitelistEnabled: true,
    whitelistUids: [],
    lastTestedAt: null,
    lastTestResult: null,
  };
}

let db: DrizzleDb;
let client: postgres.Sql;
let ctxA: TenantConfig;
let ctxB: TenantConfig;

// Captures every pushToAll call so we can assert on count, uids, and text.
const pushes: { uids: string[]; text: string }[] = [];
const pushToAllFn = async (uids: string[], text: string) => {
  pushes.push({ uids: [...uids], text });
};
const pushCount = () => pushes.length;

// Injects a scripted health sequence for tenant A, like the old in-memory
// harness did, but with the real database behind the persisted state.
function makeHarness(healthSeq: boolean[]) {
  let i = 0;
  return {
    run: () =>
      runHfmHealthCheckForTenant(ctxA, {
        db,
        checkHealthyFn: async () => healthSeq[i++]!,
        getUidsFn: async () => ["Utest123"],
        pushToAllFn,
      }),
  };
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  const idA = await insertTenantRow(db, TENANT_INPUT("A"));
  const idB = await insertTenantRow(db, TENANT_INPUT("B"));
  ctxA = makeCtx(idA, "A");
  ctxB = makeCtx(idB, "B");
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM tenant_health_state`);
  await db.execute(sql`DELETE FROM notify_recipients`);
  await addRecipient(db, ctxA.id, UID_A, null);
  await addRecipient(db, ctxB.id, UID_B, null);
  pushes.length = 0;
  invalidateTenantCache();
});

afterAll(async () => {
  await closeTestDb(client);
});

test("no alert while the API stays up (baseline up -> up)", async () => {
  const h = makeHarness([true]);
  await h.run();
  expect(pushes).toEqual([]);
  expect(await getTenantHealthState(db, ctxA.id)).toBe(true);
});

test("transition-only: up -> down -> down -> up sends exactly two alerts", async () => {
  const h = makeHarness([true, false, false, true]);
  await h.run(); // up -> up: nothing
  await h.run(); // up -> down: down alert
  await h.run(); // down -> down: nothing (no spam)
  await h.run(); // down -> up: recovered alert

  expect(pushes.length).toBe(2);
  expect(pushes[0]!.text).toContain("ขัดข้อง");
  expect(pushes[1]!.text).toContain("กลับมาใช้งานได้");
  // The final state is persisted as healthy.
  expect(await getTenantHealthState(db, ctxA.id)).toBe(true);
});

test("first probe down (from up baseline) alerts once", async () => {
  const h = makeHarness([false]);
  await h.run();
  expect(pushes.length).toBe(1);
  expect(pushes[0]!.text).toContain("ขัดข้อง");
  expect(await getTenantHealthState(db, ctxA.id)).toBe(false);
});

test("no recipients: records the transition without sending", async () => {
  const opts = {
    db,
    getUidsFn: async () => [] as string[],
    pushToAllFn,
  };

  // up -> down with no recipients: nothing sent, but state must advance to down.
  await runHfmHealthCheckForTenant(ctxA, { ...opts, checkHealthyFn: async () => false });
  expect(pushes).toEqual([]);
  expect(await getTenantHealthState(db, ctxA.id)).toBe(false);

  // down -> up should now be a real transition (recovered), still no recipients.
  await runHfmHealthCheckForTenant(ctxA, { ...opts, checkHealthyFn: async () => true });
  expect(pushes).toEqual([]);
  expect(await getTenantHealthState(db, ctxA.id)).toBe(true);

  // up -> up: confirm state settled at "up" (no further transition logic fires).
  await runHfmHealthCheckForTenant(ctxA, { ...opts, checkHealthyFn: async () => true });
  expect(pushes).toEqual([]);
  expect(await getTenantHealthState(db, ctxA.id)).toBe(true);
});

test("state change is persisted, restart does not re-alert", async () => {
  await runHfmHealthCheckForTenant(ctxA, { checkHealthyFn: async () => false, pushToAllFn });
  await runHfmHealthCheckForTenant(ctxA, { checkHealthyFn: async () => false, pushToAllFn });
  expect(pushCount()).toBe(1); // second run sees unchanged persisted state
  expect(await getTenantHealthState(db, ctxA.id)).toBe(false);
});

test("tenant A down does not alert tenant B's recipients", async () => {
  // The injectable probe is tenant-blind (it gets no ctx), and
  // runHfmHealthCheckAll loops tenants in id order, so the script answers
  // "down" for the first probed tenant (A) and "up" for the second (B).
  let probes = 0;
  await runHfmHealthCheckAll({
    checkHealthyFn: async () => (probes++ === 0 ? false : true),
    pushToAllFn,
  });

  // Exactly one down alert, addressed only to A's recipients.
  expect(pushCount()).toBe(1);
  expect(pushes[0]!.uids).toEqual([UID_A]);
  expect(pushes[0]!.text).toContain("ขัดข้อง");

  // B stayed healthy: no message reached B's uid, and B has no down state.
  expect(pushes.some((p) => p.uids.includes(UID_B))).toBe(false);
  expect(await getTenantHealthState(db, ctxB.id)).toBe(true);
  expect(await getTenantHealthState(db, ctxA.id)).toBe(false);
});
