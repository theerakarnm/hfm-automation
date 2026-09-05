// apps/api/src/services/tenant-config.service.ts
import { getDb, type DrizzleDb } from "../db/connection";
import {
  getTenantRowById,
  getTenantRowByWebhookId,
  insertTenantRow,
  listTenantRows,
  listWhitelistUids,
  updateTenantRow,
} from "../repositories/tenant.repository";
import { decryptSecret } from "../utils/crypto";
import { logger, logError } from "../utils/logger";
import type { TenantConfig, TenantInput, TenantRow, TenantTestResult } from "../types/tenant.types";

// 60 seconds: the UI saves invalidate immediately, so this TTL only guards
// against direct database edits or a future second process.
export const TENANT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  config: TenantConfig;
  cachedAt: number;
}

let cache = new Map<number, CacheEntry>();
let clock: () => number = Date.now;

// Tests inject a fake clock; production code never touches this.
export function __setTenantClockForTests(fn: () => number): void {
  clock = fn;
}

async function resolveConfig(db: DrizzleDb, row: TenantRow): Promise<TenantConfig> {
  // A decrypt failure here means CONFIG_ENCRYPTION_KEY changed or the row is
  // corrupt. Fail this tenant loudly; never serve a half-decrypted config.
  return {
    id: row.id,
    webhookId: row.webhookId,
    label: row.label,
    active: row.active === 1,
    lineChannelAccessToken: decryptSecret(row.lineChannelAccessTokenEnc),
    lineChannelSecret: decryptSecret(row.lineChannelSecretEnc),
    lineBotUserId: row.lineBotUserId,
    lineBasicId: row.lineBasicId,
    lineDisplayName: row.lineDisplayName,
    hfmApiKey: decryptSecret(row.hfmApiKeyEnc),
    hfmApiBaseUrl: row.hfmApiBaseUrl,
    targetWallet: row.targetWallet,
    whitelistEnabled: row.whitelistEnabled === 1,
    whitelistUids: await listWhitelistUids(db, row.id),
    lastTestedAt: row.lastTestedAt,
    lastTestResult: parseTestResult(row.lastTestResult),
  };
}

function parseTestResult(raw: string | null): TenantTestResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TenantTestResult;
  } catch {
    logError("tenant-config", new Error("Unparseable last_test_result, ignoring"));
    return null;
  }
}

async function cached(
  db: DrizzleDb,
  row: TenantRow,
): Promise<TenantConfig> {
  const hit = cache.get(row.id);
  if (hit && clock() - hit.cachedAt < TENANT_CACHE_TTL_MS) return hit.config;
  const config = await resolveConfig(db, row);
  cache.set(row.id, { config, cachedAt: clock() });
  return config;
}

export async function getTenantById(id: number): Promise<TenantConfig | null> {
  const row = await getTenantRowById(getDb(), id);
  return row ? cached(getDb(), row) : null;
}

export async function getTenantByWebhookId(
  webhookId: string,
): Promise<TenantConfig | null> {
  const row = await getTenantRowByWebhookId(getDb(), webhookId);
  return row ? cached(getDb(), row) : null;
}

export async function listActiveTenants(): Promise<TenantConfig[]> {
  const rows = (await listTenantRows(getDb())).filter((r) => r.active === 1);
  return Promise.all(rows.map((r) => cached(getDb(), r)));
}

export function invalidateTenantCache(tenantId?: number): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}

export async function saveTenant(input: TenantInput, id?: number): Promise<number> {
  const db = getDb();
  const tenantId = id
    ? (await updateTenantRow(db, id, input), id)
    : await insertTenantRow(db, input);
  invalidateTenantCache(tenantId);
  logger.info({ tenantId }, "tenant config saved, cache invalidated");
  return tenantId;
}

// Tests that run against an explicit db handle instead of the global getDb()
// resolve tenants through this. It bypasses the cache on purpose: tests need
// fresh reads after direct inserts and seeded rows.
export async function getTenantConfigForTests(
  db: DrizzleDb,
  id: number,
): Promise<TenantConfig | null> {
  const row = await getTenantRowById(db, id);
  return row ? resolveConfig(db, row) : null;
}
