import { eq, lt, count, desc } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { clientSnapshots } from "../db/schema";

export async function countByDate(db: DrizzleDb, date: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(clientSnapshots)
    .where(eq(clientSnapshots.snapshotDate, date));
  return rows[0]?.count ?? 0;
}

export async function getWalletIdsByDate(
  db: DrizzleDb,
  date: string,
): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ clientId: clientSnapshots.clientId })
    .from(clientSnapshots)
    .where(eq(clientSnapshots.snapshotDate, date));
  return new Set(rows.map((r) => r.clientId));
}

/** Nearest snapshot date strictly before `date` (for snap fallback). */
export async function getNearestSnapshotDateBefore(
  db: DrizzleDb,
  date: string,
): Promise<string | null> {
  const rows = await db
    .selectDistinct({ date: clientSnapshots.snapshotDate })
    .from(clientSnapshots)
    .where(lt(clientSnapshots.snapshotDate, date))
    .orderBy(desc(clientSnapshots.snapshotDate))
    .limit(1);
  return rows[0]?.date ?? null;
}
