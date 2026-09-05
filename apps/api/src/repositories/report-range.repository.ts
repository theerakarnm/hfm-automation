import { eq, and } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { reportRangeSnapshots } from "../db/schema";
import type { HFMClientsPerformanceResponse } from "../types/hfm.types";

export interface RangeSnapshotRow {
  period: string;
  from_date: string;
  to_date: string;
  data: HFMClientsPerformanceResponse;
}

export async function getRangeSnapshot(
  db: DrizzleDb,
  tenantId: number,
  period: string,
  fromDate: string,
  toDate: string,
): Promise<RangeSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(reportRangeSnapshots)
    .where(
      and(
        eq(reportRangeSnapshots.tenantId, tenantId),
        eq(reportRangeSnapshots.period, period),
        eq(reportRangeSnapshots.fromDate, fromDate),
        eq(reportRangeSnapshots.toDate, toDate),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    period: row.period,
    from_date: row.fromDate,
    to_date: row.toDate,
    data: JSON.parse(row.rawJson) as HFMClientsPerformanceResponse,
  };
}

export async function upsertRangeSnapshot(
  db: DrizzleDb,
  tenantId: number,
  period: string,
  fromDate: string,
  toDate: string,
  data: HFMClientsPerformanceResponse,
): Promise<void> {
  await db
    .insert(reportRangeSnapshots)
    .values({
      tenantId,
      period,
      fromDate,
      toDate,
      rawJson: JSON.stringify(data),
    })
    .onConflictDoUpdate({
      target: [
        reportRangeSnapshots.tenantId,
        reportRangeSnapshots.period,
        reportRangeSnapshots.fromDate,
        reportRangeSnapshots.toDate,
      ],
      set: { rawJson: JSON.stringify(data) },
    });
}
