import type { Database } from "bun:sqlite";
import type { HFMPerformanceData } from "../types/hfm.types";

export interface SnapshotRow {
  id: number;
  snapshot_date: string;
  composite_key: string;
  account_id: number;
  client_id: number;
  full_name: string;
  raw_json: string;
  created_at: string;
}

export interface SnapshotClient {
  composite_key: string;
  account_id: number;
  client_id: number;
  full_name: string;
  raw: HFMPerformanceData;
}

export function toCompositeKey(client: HFMPerformanceData): string {
  return `${client.account_id}_${client.client_id}`;
}

export function countByDate(db: Database, date: string): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM client_snapshots WHERE snapshot_date = $date")
    .get({ date }) as { count: number } | null;
  return row?.count ?? 0;
}

export function getByDate(db: Database, date: string): SnapshotClient[] {
  const rows = db
    .query("SELECT composite_key, account_id, client_id, full_name, raw_json FROM client_snapshots WHERE snapshot_date = $date")
    .all({ date }) as Array<{
    composite_key: string;
    account_id: number;
    client_id: number;
    full_name: string;
    raw_json: string;
  }>;
  return rows.map((row) => ({
    composite_key: row.composite_key,
    account_id: row.account_id,
    client_id: row.client_id,
    full_name: row.full_name,
    raw: JSON.parse(row.raw_json) as HFMPerformanceData,
  }));
}

export function insertMany(db: Database, date: string, clients: HFMPerformanceData[]): void {
  const insert = db.prepare(
    "INSERT INTO client_snapshots (snapshot_date, composite_key, account_id, client_id, full_name, raw_json) VALUES ($date, $compositeKey, $accountId, $clientId, $fullName, $rawJson)"
  );
  const tx = db.transaction(() => {
    for (const client of clients) {
      const fullName = client.full_name?.trim() || "Unknown Client";
      insert.run({
        date,
        compositeKey: toCompositeKey(client),
        accountId: client.account_id,
        clientId: client.client_id,
        fullName,
        rawJson: JSON.stringify(client),
      });
    }
  });
  tx();
}

export function purgeOlderThan(db: Database, days: number, referenceDate: string): void {
  db.prepare(
    "DELETE FROM client_snapshots WHERE date(snapshot_date) < date($referenceDate, '-' || $days || ' days')"
  ).run({ referenceDate, days });
}
