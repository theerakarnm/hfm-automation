import { eq, lt, sql, count } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { clientSnapshots } from "../db/schema";
import type { HFMPerformanceData } from "../types/hfm.types";

const CHUNK_SIZE = 500;

export async function countByDate(db: DrizzleDb, date: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(clientSnapshots)
    .where(eq(clientSnapshots.snapshotDate, date));
  return rows[0]?.count ?? 0;
}

export async function insertMany(
  db: DrizzleDb,
  date: string,
  clients: HFMPerformanceData[],
): Promise<void> {
  const seen = new Set<number>();

  for (let i = 0; i < clients.length; i += CHUNK_SIZE) {
    const chunk = clients.slice(i, i + CHUNK_SIZE);
    const values: { snapshotDate: string; clientId: number }[] = [];
    for (const client of chunk) {
      if (seen.has(client.client_id)) continue;
      seen.add(client.client_id);
      values.push({ snapshotDate: date, clientId: client.client_id });
    }
    if (values.length > 0) {
      await db
        .insert(clientSnapshots)
        .values(values)
        .onConflictDoNothing();
    }
  }
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
