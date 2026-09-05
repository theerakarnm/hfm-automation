import { and, eq, lt, sql, count, desc } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { clientSnapshots } from "../db/schema";

const CHUNK_SIZE = 500;

// Task 6 tenant scoping: rows carry their own snapshot_date so callers can
// backfill multiple dates in one call. normalizeClientRow-style mapping now
// happens in the caller (the job does it in Task 14).
export interface ClientSnapshotInput {
  snapshotDate: string;
  clientId: number;
  name: string | null;
  email: string | null;
}

export async function countByDate(
  db: DrizzleDb,
  tenantId: number,
  date: string,
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(clientSnapshots)
    .where(
      and(
        eq(clientSnapshots.tenantId, tenantId),
        eq(clientSnapshots.snapshotDate, date),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function insertMany(
  db: DrizzleDb,
  tenantId: number,
  rows: ClientSnapshotInput[],
): Promise<void> {
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const values: {
      tenantId: number;
      snapshotDate: string;
      clientId: number;
      name: string | null;
      email: string | null;
    }[] = [];
    for (const row of chunk) {
      const key = `${row.snapshotDate}_${row.clientId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({
        tenantId,
        snapshotDate: row.snapshotDate,
        clientId: row.clientId,
        name: row.name,
        email: row.email,
      });
    }
    if (values.length > 0) {
      await db
        .insert(clientSnapshots)
        .values(values)
        .onConflictDoNothing();
    }
  }
}

export async function getLatestSnapshotDateBefore(
  db: DrizzleDb,
  beforeDate: string,
): Promise<string | null> {
  const rows = await db
    .selectDistinct({ date: clientSnapshots.snapshotDate })
    .from(clientSnapshots)
    .where(lt(clientSnapshots.snapshotDate, beforeDate))
    .orderBy(desc(clientSnapshots.snapshotDate))
    .limit(1);
  return rows[0]?.date ?? null;
}

export async function purgeOlderThan(
  db: DrizzleDb,
  days: number,
  referenceDate: string,
): Promise<void> {
  await db
    .delete(clientSnapshots)
    .where(
      sql`${clientSnapshots.snapshotDate}::date < (${referenceDate}::date - ${days} * INTERVAL '1 day')`,
    );
}
