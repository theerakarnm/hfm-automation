import { eq, lte, desc, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { clientRequestSnapshots, clientRequestSnapshotRows } from "../db/schema";
import type { HFMClientRow } from "../types/hfm.types";

export interface RequestSnapshotRow {
  client_id: number;
}

export interface RequestSnapshotResult {
  rows: RequestSnapshotRow[];
  snapshotDate: string;
  createdAt: string;
}

export async function insertRequestSnapshot(
  db: DrizzleDb,
  date: string,
  rows: HFMClientRow[],
): Promise<number> {
  return await db.transaction(async (tx) => {
    const [header] = await tx
      .insert(clientRequestSnapshots)
      .values({ snapshotDate: date })
      .returning({ id: clientRequestSnapshots.id });

    const snapshotId = header.id;
    const seen = new Set<number>();
    const values: { snapshotId: number; clientId: number }[] = [];

    for (const row of rows) {
      if (seen.has(row.wallet)) continue;
      seen.add(row.wallet);
      values.push({ snapshotId, clientId: row.wallet });
    }

    if (values.length > 0) {
      await tx
        .insert(clientRequestSnapshotRows)
        .values(values)
        .onConflictDoNothing();
    }

    return snapshotId;
  });
}

export async function getLatestRequestSnapshotBefore(
  db: DrizzleDb,
  beforeDate: string,
): Promise<RequestSnapshotResult | null> {
  const [header] = await db
    .select()
    .from(clientRequestSnapshots)
    .where(lte(clientRequestSnapshots.snapshotDate, beforeDate))
    .orderBy(desc(clientRequestSnapshots.id))
    .limit(1);

  if (!header) return null;

  const rows = await db
    .select({ clientId: clientRequestSnapshotRows.clientId })
    .from(clientRequestSnapshotRows)
    .where(eq(clientRequestSnapshotRows.snapshotId, header.id));

  if (rows.length === 0) return null;

  return {
    rows: rows.map((r) => ({ client_id: r.clientId })),
    snapshotDate: header.snapshotDate,
    createdAt: header.createdAt,
  };
}

export function countDistinctWallets(rows: RequestSnapshotRow[]): number {
  return new Set(rows.map((r) => r.client_id)).size;
}

export function findMissingWalletIds(
  prev: RequestSnapshotRow[],
  curr: RequestSnapshotRow[],
): number[] {
  const currIds = new Set(curr.map((r) => r.client_id));
  const prevIds = new Set<number>();
  for (const r of prev) {
    if (!currIds.has(r.client_id) && !prevIds.has(r.client_id)) {
      prevIds.add(r.client_id);
    }
  }
  return [...prevIds].sort((a, b) => a - b);
}

export function findNewWalletIds(
  prev: RequestSnapshotRow[],
  curr: RequestSnapshotRow[],
): number[] {
  const prevIds = new Set(prev.map((r) => r.client_id));
  const newIds = new Set<number>();
  for (const r of curr) {
    if (!prevIds.has(r.client_id) && !newIds.has(r.client_id)) {
      newIds.add(r.client_id);
    }
  }
  return [...newIds].sort((a, b) => a - b);
}
