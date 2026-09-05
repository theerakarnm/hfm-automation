// apps/api/src/repositories/tenant.repository.ts
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/connection";
import { tenants, tenantHealthState, tenantWhitelistUids } from "../db/schema";
import type { TenantInput, TenantRow, TenantTestResult } from "../types/tenant.types";
import { encryptSecret } from "../utils/crypto";

// NOTE: this file never decrypts. insert/update encrypt in place because the
// input is plaintext from the UI, but reads return *_enc values untouched.
// Decryption belongs to tenant-config.service only.

function toRow(r: typeof tenants.$inferSelect): TenantRow {
  return {
    id: r.id,
    webhookId: r.webhookId,
    label: r.label,
    active: r.active,
    lineChannelAccessTokenEnc: r.lineChannelAccessTokenEnc,
    lineChannelSecretEnc: r.lineChannelSecretEnc,
    lineBotUserId: r.lineBotUserId,
    lineBasicId: r.lineBasicId,
    lineDisplayName: r.lineDisplayName,
    hfmApiKeyEnc: r.hfmApiKeyEnc,
    hfmApiBaseUrl: r.hfmApiBaseUrl,
    targetWallet: r.targetWallet,
    whitelistEnabled: r.whitelistEnabled,
    keyVersion: r.keyVersion,
    lastTestedAt: r.lastTestedAt,
    lastTestResult: r.lastTestResult,
  };
}

export async function listTenantRows(db: DrizzleDb): Promise<TenantRow[]> {
  const rows = await db.select().from(tenants).orderBy(tenants.id);
  return rows.map(toRow);
}

export async function getTenantRowById(
  db: DrizzleDb,
  id: number,
): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id));
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getTenantRowByWebhookId(
  db: DrizzleDb,
  webhookId: string,
): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.webhookId, webhookId));
  return rows[0] ? toRow(rows[0]) : null;
}

function toEncryptedValues(input: TenantInput) {
  return {
    label: input.label,
    active: input.active ? 1 : 0,
    lineChannelAccessTokenEnc: encryptSecret(input.lineChannelAccessToken),
    lineChannelSecretEnc: encryptSecret(input.lineChannelSecret),
    hfmApiKeyEnc: encryptSecret(input.hfmApiKey),
    hfmApiBaseUrl: input.hfmApiBaseUrl,
    targetWallet: input.targetWallet,
    whitelistEnabled: input.whitelistEnabled ? 1 : 0,
  };
}

export async function insertTenantRow(
  db: DrizzleDb,
  input: TenantInput,
): Promise<number> {
  const rows = await db
    .insert(tenants)
    .values({ webhookId: randomUUID(), ...toEncryptedValues(input) })
    .returning({ id: tenants.id });
  return rows[0]!.id;
}

export async function updateTenantRow(
  db: DrizzleDb,
  id: number,
  input: Partial<TenantInput>,
): Promise<void> {
  const set: Record<string, string | number> = { updatedAt: new Date().toISOString() };
  if (input.label !== undefined) set.label = input.label;
  if (input.active !== undefined) set.active = input.active ? 1 : 0;
  if (input.lineChannelAccessToken) {
    set.lineChannelAccessTokenEnc = encryptSecret(input.lineChannelAccessToken);
  }
  if (input.lineChannelSecret) {
    set.lineChannelSecretEnc = encryptSecret(input.lineChannelSecret);
  }
  if (input.hfmApiKey) set.hfmApiKeyEnc = encryptSecret(input.hfmApiKey);
  if (input.hfmApiBaseUrl !== undefined) set.hfmApiBaseUrl = input.hfmApiBaseUrl;
  if (input.targetWallet !== undefined) set.targetWallet = input.targetWallet;
  if (input.whitelistEnabled !== undefined) {
    set.whitelistEnabled = input.whitelistEnabled ? 1 : 0;
  }
  await db.update(tenants).set(set).where(eq(tenants.id, id));
}

export async function updateTenantLineIdentity(
  db: DrizzleDb,
  id: number,
  identity: { userId: string; basicId: string | null; displayName: string | null },
): Promise<void> {
  await db
    .update(tenants)
    .set({
      lineBotUserId: identity.userId,
      lineBasicId: identity.basicId,
      lineDisplayName: identity.displayName,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tenants.id, id));
}

export async function updateTenantTestResult(
  db: DrizzleDb,
  id: number,
  result: TenantTestResult,
): Promise<void> {
  await db
    .update(tenants)
    .set({
      lastTestedAt: new Date().toISOString(),
      lastTestResult: JSON.stringify(result),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tenants.id, id));
}

// Healthcheck edge state for the status page. A missing row means "never
// probed", which the healthcheck job treats as healthy; the caller decides
// how to render that case.
export interface TenantHealthStateRow {
  healthy: boolean;
  changedAt: string;
}

export async function getTenantHealthStateRow(
  db: DrizzleDb,
  tenantId: number,
): Promise<TenantHealthStateRow | null> {
  const rows = await db
    .select({ healthy: tenantHealthState.healthy, changedAt: tenantHealthState.changedAt })
    .from(tenantHealthState)
    .where(eq(tenantHealthState.tenantId, tenantId));
  return rows[0] ? { healthy: rows[0].healthy === 1, changedAt: rows[0].changedAt } : null;
}

export async function rotateWebhookId(db: DrizzleDb, id: number): Promise<string> {
  const webhookId = randomUUID();
  await db
    .update(tenants)
    .set({ webhookId, updatedAt: new Date().toISOString() })
    .where(eq(tenants.id, id));
  return webhookId;
}

export async function countTenants(db: DrizzleDb): Promise<number> {
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.length;
}

export async function listWhitelistUids(
  db: DrizzleDb,
  tenantId: number,
): Promise<string[]> {
  const rows = await db
    .select({ lineUid: tenantWhitelistUids.lineUid })
    .from(tenantWhitelistUids)
    .where(eq(tenantWhitelistUids.tenantId, tenantId));
  return rows.map((r) => r.lineUid);
}

export async function addWhitelistUid(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
  label: string | null,
): Promise<void> {
  await db
    .insert(tenantWhitelistUids)
    .values({ tenantId, lineUid, label })
    .onConflictDoNothing();
}

export async function removeWhitelistUid(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
): Promise<void> {
  await db
    .delete(tenantWhitelistUids)
    .where(
      and(
        eq(tenantWhitelistUids.tenantId, tenantId),
        eq(tenantWhitelistUids.lineUid, lineUid),
      ),
    );
}
