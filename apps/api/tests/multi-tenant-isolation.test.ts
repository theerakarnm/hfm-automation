import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { initDb, resetDbForTests, getDb } from "../src/db/connection";
import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import { app } from "../src/app";
import { saveTenant, invalidateTenantCache, getTenantConfigForTests } from "../src/services/tenant-config.service";
import { addWhitelistUid, getTenantRowById } from "../src/repositories/tenant.repository";
import { addRecipient, getActiveUids } from "../src/repositories/recipient.repository";
import { insertMany, countByDate } from "../src/repositories/snapshot.repository";
import { markDailyReportSent, isDailyReportSent } from "../src/repositories/daily-notification.repository";
import { listLineUsers } from "../src/repositories/line-user.repository";
import { getLastTradeMap, resetLastTradeCache } from "../src/services/last-trade.service";
import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";
import { Glob } from "bun";
import path from "node:path";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");

// Bun auto-loads apps/api/.env. Its per-OA values would make the bootstrap
// seed run inside initDb below and write a tenant built from real secrets;
// this suite always seeds its own tenants, so delete them up front.
for (const name of [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "HFM_API_KEY",
  "HFM_API_BASE_URL",
  "TARGET_WALLET",
  "LINE_WHITELIST_ENABLED",
  "LINE_WHITELIST_UIDS",
  "LINE_NOTIFY_UIDS",
]) {
  delete process.env[name];
}

const UID_A = "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UID_B = "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_A = "Ubotbotbotbotbotbotbotbotbotbot1";
const BOT_B = "Ubotbotbotbotbotbotbotbotbotbot2";

let db: ReturnType<typeof getDb>;
let client: postgres.Sql;
let idA = 0;
let idB = 0;
let webhookA = "";
let webhookB = "";

interface RecordedRequest { url: string; auth: string; body: string }
const outbound: RecordedRequest[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";

function stubFetchRecording(): void {
  // Each test asserts on its own traffic only, so start from an empty tape.
  outbound.length = 0;
  (globalThis as any).fetch = async (url: any, init?: RequestInit) => {
    outbound.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
      body: String(init?.body ?? ""),
    });
    // LINE APIs succeed; HFM endpoints return an empty-but-valid payload.
    if (String(url).startsWith("https://api.line.me")) {
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
}

async function postWebhook(webhookId: string, secret: string, body: object) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", secret).update(raw).digest("base64");
  return app.request(`/webhook?oa=${webhookId}`, {
    method: "POST",
    headers: { "x-line-signature": sig, "content-type": "application/json" },
    body: raw,
  });
}

// The webhook handler answers 200 before the reply work finishes, so every
// outbound assertion must first wait for the flow's final call: the LINE
// reply POST (both the success and the error path end with exactly one).
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for webhook background work");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function countReplyPosts(token: string): number {
  return outbound.filter(
    (r) => r.url === LINE_REPLY_URL && r.auth === `Bearer ${token}`,
  ).length;
}

function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
  return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  // createTestDb drops and recreates every table in its new shape; the
  // following initDb call is then an idempotent no-op that proves initDb
  // itself runs clean against a fresh multi-tenant schema.
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  resetDbForTests();
  await initDb(getDb(TEST_DATABASE_URL));

  idA = await saveTenant({
    label: "OA Alpha", active: true,
    lineChannelAccessToken: "line_tok_A", lineChannelSecret: "line_sec_A",
    hfmApiKey: "hfm_key_A", hfmApiBaseUrl: "https://hfm-a.test",
    targetWallet: 111111, whitelistEnabled: true,
  });
  idB = await saveTenant({
    label: "OA Beta", active: true,
    lineChannelAccessToken: "line_tok_B", lineChannelSecret: "line_sec_B",
    hfmApiKey: "hfm_key_B", hfmApiBaseUrl: "https://hfm-b.test",
    targetWallet: 222222, whitelistEnabled: true,
  });
  // saveTenant already dropped these two ids; the full clear also removes
  // any entry a previously run test file cached under other ids.
  invalidateTenantCache();
  await addWhitelistUid(db, idA, UID_A, null);
  await addWhitelistUid(db, idB, UID_B, null);
  webhookA = (await getTenantRowById(db, idA))!.webhookId;
  webhookB = (await getTenantRowById(db, idB))!.webhookId;
});

afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  await closeTestDb(client);
  resetDbForTests();
  delete process.env.DATABASE_URL;
});

describe("cross-tenant isolation", () => {
  test("webhook for A sends LINE replies with A's token and HFM calls with A's key", async () => {
    stubFetchRecording();
    const res = await postWebhook(webhookA, "line_sec_A", {
      destination: BOT_A,
      events: [{ type: "message", replyToken: "rt_a", source: { type: "user", userId: UID_A }, message: { type: "text", text: "98241376" } }],
    });
    expect(res.status).toBe(200);
    await waitFor(() => countReplyPosts("line_tok_A") >= 1);
    const lineAuths = outbound.filter((r) => r.url.includes("api.line.me")).map((r) => r.auth);
    const hfmAuths = outbound.filter((r) => r.url.includes("hfm-a.test")).map((r) => r.auth);
    expect(lineAuths.length).toBeGreaterThan(0);
    expect(new Set(lineAuths)).toEqual(new Set(["Bearer line_tok_A"]));
    expect(hfmAuths.every((a) => a === "Bearer hfm_key_A")).toBe(true);
    expect(outbound.some((r) => r.url.includes("hfm-b.test"))).toBe(false);
  });

  test("A's valid signature replayed against B's URL is rejected", async () => {
    stubFetchRecording();
    const res = await postWebhook(webhookB, "line_sec_A", {
      destination: BOT_B, events: [],
    });
    expect(res.status).toBe(400);
    expect(outbound.length).toBe(0);
  });

  test("interleaved concurrent requests never mix credentials", async () => {
    stubFetchRecording();
    const results = await Promise.all([
      postWebhook(webhookA, "line_sec_A", { destination: BOT_A, events: [{ type: "message", replyToken: "rt_a1", source: { type: "user", userId: UID_A }, message: { type: "text", text: "98241376" } }] }),
      postWebhook(webhookB, "line_sec_B", { destination: BOT_B, events: [{ type: "message", replyToken: "rt_b1", source: { type: "user", userId: UID_B }, message: { type: "text", text: "98241377" } }] }),
      postWebhook(webhookA, "line_sec_A", { destination: BOT_A, events: [{ type: "message", replyToken: "rt_a2", source: { type: "user", userId: UID_A }, message: { type: "text", text: "98241378" } }] }),
      postWebhook(webhookB, "line_sec_B", { destination: BOT_B, events: [{ type: "message", replyToken: "rt_b2", source: { type: "user", userId: UID_B }, message: { type: "text", text: "98241379" } }] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    await waitFor(() => countReplyPosts("line_tok_A") >= 2 && countReplyPosts("line_tok_B") >= 2);
    const lineAuths = new Set(outbound.filter((r) => r.url.includes("api.line.me")).map((r) => r.auth));
    expect(lineAuths.has("Bearer line_tok_A")).toBe(true);
    expect(lineAuths.has("Bearer line_tok_B")).toBe(true);
    for (const r of outbound.filter((x) => x.url.includes("hfm-a.test"))) {
      expect(r.auth).toBe("Bearer hfm_key_A");
    }
    for (const r of outbound.filter((x) => x.url.includes("hfm-b.test"))) {
      expect(r.auth).toBe("Bearer hfm_key_B");
    }
  });

  test("last-trade cache warmed by A is not served to B", async () => {
    resetLastTradeCache();
    const fetchA = async (): Promise<HFMClientsResult> => ({ ok: true, data: [makeRow({ id: 1, last_trade: "a" })] });
    const fetchB = async (): Promise<HFMClientsResult> => ({ ok: true, data: [makeRow({ id: 2, last_trade: "b" })] });
    const ctxA = await getTenantConfigForTests(getDb(), idA);
    const ctxB = await getTenantConfigForTests(getDb(), idB);
    const mapA = await getLastTradeMap(ctxA!, { fetchClientsFn: fetchA });
    const mapB = await getLastTradeMap(ctxB!, { fetchClientsFn: fetchB });
    expect(mapA!.has(2)).toBe(false);
    expect(mapB!.has(1)).toBe(false);
  });

  test("snapshot and notification rows do not leak across tenants", async () => {
    const db = getDb();
    await insertMany(db, idA, [{ snapshotDate: "2026-09-05", clientId: 98241376, name: "x", email: null }]);
    expect(await countByDate(db, idB, "2026-09-05")).toBe(0);
    await markDailyReportSent(db, idA, "2026-09-05");
    expect(await isDailyReportSent(db, idB, "2026-09-05")).toBe(false);
  });

  test("line_users rows stay per tenant", async () => {
    const db = getDb();
    const { recordLineUserRequest } = await import("../src/repositories/line-user.repository");
    // Fresh uids: the webhook tests above legitimately recorded rows for
    // both tenants already, so isolation is asserted per uid, not by count.
    const ISO_A = "Uisolatedaaaaaaaaaaaaaaaaaaaaaaaa1";
    const ISO_B = "Uisolatedbbbbbbbbbbbbbbbbbbbbbbbb2";
    await recordLineUserRequest(db, idA, ISO_A, "message");
    await recordLineUserRequest(db, idB, ISO_B, "message");
    const uidsA = (await listLineUsers(db, idA)).map((r) => r.line_uid);
    const uidsB = (await listLineUsers(db, idB)).map((r) => r.line_uid);
    expect(uidsA).toContain(ISO_A);
    expect(uidsA).not.toContain(ISO_B);
    expect(uidsB).toContain(ISO_B);
    expect(uidsB).not.toContain(ISO_A);
  });

  test("notify recipients stay per tenant", async () => {
    const db = getDb();
    await addRecipient(db, idA, "Un1", null);
    expect(await getActiveUids(db, idB)).toEqual([]);
  });
});

describe("no per-tenant env reads remain", () => {
  test("src never reads the eight per-OA env vars except in bootstrap.ts", async () => {
    const forbidden = [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET",
      "HFM_API_KEY",
      "HFM_API_BASE_URL",
      "TARGET_WALLET",
      "LINE_WHITELIST_UIDS",
      "LINE_WHITELIST_ENABLED",
      "LINE_NOTIFY_UIDS",
    ];
    const offenders: string[] = [];
    const glob = new Glob("**/*.ts");
    const srcRoot = path.join(import.meta.dir, "..", "src");
    for await (const file of glob.scan(srcRoot)) {
      const text = await Bun.file(path.join(srcRoot, file)).text();
      if (file === "db/bootstrap.ts") continue; // the one allowed place
      for (const name of forbidden) {
        if (text.includes(`process.env.${name}`)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
