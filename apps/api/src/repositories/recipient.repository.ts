import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { notifyRecipients } from "../db/schema";

export function parseNotifyUids(envValue: string): string[] {
  return [
    ...new Set(
      envValue
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

export async function seedFromEnv(
  db: DrizzleDb,
  envValue: string,
): Promise<void> {
  const uids = parseNotifyUids(envValue);
  if (uids.length === 0) return;
  await db
    .insert(notifyRecipients)
    .values(uids.map((uid) => ({ lineUid: uid })))
    .onConflictDoNothing();
}

// Pulled forward from Task 11 for the Task 5 bootstrap seed. seedFromEnv and
// parseNotifyUids are deleted there, once the jobs no longer call them.
export async function addRecipient(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
  label: string | null,
): Promise<void> {
  await db
    .insert(notifyRecipients)
    .values({ tenantId, lineUid, label })
    .onConflictDoNothing();
}

// tenantId is optional only until Task 11 updates the legacy job callers,
// which have no tenant context yet. The filter applies whenever it is given.
export async function getActiveUids(
  db: DrizzleDb,
  tenantId?: number,
): Promise<string[]> {
  const conditions = [eq(notifyRecipients.active, 1)];
  if (tenantId !== undefined) {
    conditions.push(eq(notifyRecipients.tenantId, tenantId));
  }
  const rows = await db
    .select({ lineUid: notifyRecipients.lineUid })
    .from(notifyRecipients)
    .where(and(...conditions));
  return rows.map((r) => r.lineUid);
}
