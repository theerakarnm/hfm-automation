import { eq } from "drizzle-orm";
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

export async function getActiveUids(db: DrizzleDb): Promise<string[]> {
  const rows = await db
    .select({ lineUid: notifyRecipients.lineUid })
    .from(notifyRecipients)
    .where(eq(notifyRecipients.active, 1));
  return rows.map((r) => r.lineUid);
}

// Seeds LINE_NOTIFY_UIDS into the table (idempotent) and returns everyone who
// is active. Shared by every job that pushes to the notify list.
export async function resolveNotifyUids(db: DrizzleDb): Promise<string[]> {
  await seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");
  return getActiveUids(db);
}
