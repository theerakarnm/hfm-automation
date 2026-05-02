import type { Database } from "bun:sqlite";
import type { HFMPerformanceData } from "../types/hfm.types";

const CHUNK_SIZE = 500;

export function countByDate(db: Database, date: string): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM client_snapshots WHERE snapshot_date = $date")
    .get({ date }) as { count: number } | null;
  return row?.count ?? 0;
}

export function insertMany(db: Database, date: string, clients: HFMPerformanceData[]): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO client_snapshots (snapshot_date, client_id) VALUES ($date, $clientId)"
  );
  const seen = new Set<number>();
  const tx = db.transaction((batch: HFMPerformanceData[]) => {
    for (const client of batch) {
      if (seen.has(client.client_id)) continue;
      seen.add(client.client_id);
      insert.run({ date, clientId: client.client_id });
    }
  });

  for (let i = 0; i < clients.length; i += CHUNK_SIZE) {
    tx(clients.slice(i, i + CHUNK_SIZE));
  }
}

export function purgeOlderThan(db: Database, days: number, referenceDate: string): void {
  db.prepare(
    "DELETE FROM client_snapshots WHERE date(snapshot_date) < date($referenceDate, '-' || $days || ' days')"
  ).run({ referenceDate, days });
}
