import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { dailyReportNotifications } from "../db/schema";

export async function markDailyReportSent(
  db: DrizzleDb,
  tenantId: number,
  snapshotDate: string,
): Promise<void> {
  await db
    .insert(dailyReportNotifications)
    .values({ tenantId, snapshotDate })
    .onConflictDoNothing();
}

export async function isDailyReportSent(
  db: DrizzleDb,
  tenantId: number,
  snapshotDate: string,
): Promise<boolean> {
  const rows = await db
    .select({ snapshotDate: dailyReportNotifications.snapshotDate })
    .from(dailyReportNotifications)
    .where(
      and(
        eq(dailyReportNotifications.tenantId, tenantId),
        eq(dailyReportNotifications.snapshotDate, snapshotDate),
      ),
    );
  return rows.length > 0;
}
