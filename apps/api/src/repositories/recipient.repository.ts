import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { notifyRecipients } from "../db/schema";

// seedFromEnv and parseNotifyUids are gone by design: recipients now come
// from the database only, managed per tenant through the internal UI.

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

export async function removeRecipient(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
): Promise<void> {
  await db
    .delete(notifyRecipients)
    .where(
      and(
        eq(notifyRecipients.tenantId, tenantId),
        eq(notifyRecipients.lineUid, lineUid),
      ),
    );
}

export async function getActiveUids(db: DrizzleDb, tenantId: number): Promise<string[]> {
  const rows = await db
    .select({ lineUid: notifyRecipients.lineUid })
    .from(notifyRecipients)
    .where(
      and(eq(notifyRecipients.tenantId, tenantId), eq(notifyRecipients.active, 1)),
    );
  return rows.map((r) => r.lineUid);
}
