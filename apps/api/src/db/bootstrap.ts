// apps/api/src/db/bootstrap.ts
import type { DrizzleDb } from "./connection";
import { countTenants, insertTenantRow, addWhitelistUid } from "../repositories/tenant.repository";
import { addRecipient } from "../repositories/recipient.repository";
import { logger } from "../utils/logger";

function splitCsv(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

function isFalseLike(raw: string | undefined): boolean {
  return ["false", "0", "off", "no"].includes((raw ?? "").trim().toLowerCase());
}

// Runs once at boot inside initDb. This is the ONLY code allowed to read the
// eight per-OA env variables, and only when the tenants table is empty.
// Returns the new tenant id, or null when nothing was seeded.
export async function seedDefaultTenantFromEnv(
  db: DrizzleDb,
): Promise<number | null> {
  if ((await countTenants(db)) > 0) return null;

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const secret = process.env.LINE_CHANNEL_SECRET?.trim();
  const hfmKey = process.env.HFM_API_KEY?.trim();
  const targetWallet = Number(process.env.TARGET_WALLET);

  if (!token || !secret || !hfmKey || !Number.isFinite(targetWallet) || targetWallet <= 0) {
    logger.warn(
      "tenants table is empty and per-OA env vars are missing; nothing seeded. " +
        "Create the first tenant through the internal UI (/internal/config).",
    );
    return null;
  }

  const id = await insertTenantRow(db, {
    label: process.env.LINE_OA_LABEL?.trim() || "Default OA",
    active: true,
    lineChannelAccessToken: token,
    lineChannelSecret: secret,
    hfmApiKey: hfmKey,
    hfmApiBaseUrl:
      process.env.HFM_API_BASE_URL?.trim() || "https://api.hfaffiliates.com",
    targetWallet,
    whitelistEnabled: !isFalseLike(process.env.LINE_WHITELIST_ENABLED),
  });

  for (const uid of splitCsv(process.env.LINE_WHITELIST_UIDS)) {
    await addWhitelistUid(db, id, uid, "seeded");
  }
  for (const uid of splitCsv(process.env.LINE_NOTIFY_UIDS)) {
    await addRecipient(db, id, uid, "seeded");
  }

  const webhookId = (
    await import("../repositories/tenant.repository").then((m) =>
      m.getTenantRowById(db, id),
    )
  )!.webhookId;

  logger.info(
    { tenantId: id, webhookId },
    `[bootstrap] seeded default tenant from env. Set the LINE webhook URL to: /webhook?oa=${webhookId}`,
  );
  return id;
}
