import type { Database } from "bun:sqlite";
import type { HFMPerformanceData } from "../types/hfm.types";

const CHUNK_SIZE = 500;

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

export interface DiffCounts {
  added: number;
  missing: number;
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
  const tx = db.transaction((batch: HFMPerformanceData[]) => {
    for (const client of batch) {
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

  for (let i = 0; i < clients.length; i += CHUNK_SIZE) {
    tx(clients.slice(i, i + CHUNK_SIZE));
  }
}

export function diffCounts(db: Database, today: string, yesterday: string): DiffCounts {
  const addedRow = db.prepare(
    `SELECT COUNT(*) as count FROM client_snapshots today
     WHERE today.snapshot_date = $today
       AND NOT EXISTS (
         SELECT 1 FROM client_snapshots yest
         WHERE yest.snapshot_date = $yesterday AND yest.composite_key = today.composite_key
       )`
  ).get({ today, yesterday }) as { count: number };

  const missingRow = db.prepare(
    `SELECT COUNT(*) as count FROM client_snapshots yest
     WHERE yest.snapshot_date = $yesterday
       AND NOT EXISTS (
         SELECT 1 FROM client_snapshots today
         WHERE today.snapshot_date = $today AND today.composite_key = yest.composite_key
       )`
  ).get({ today, yesterday }) as { count: number };

  return { added: addedRow.count, missing: missingRow.count };
}

export function getAddedClients(db: Database, today: string, yesterday: string, limit: number): SnapshotClient[] {
  const rows = db.prepare(
    `SELECT composite_key, account_id, client_id, full_name, raw_json
     FROM client_snapshots today
     WHERE today.snapshot_date = $today
       AND NOT EXISTS (
         SELECT 1 FROM client_snapshots yest
         WHERE yest.snapshot_date = $yesterday AND yest.composite_key = today.composite_key
       )
     LIMIT $limit`
  ).all({ today, yesterday, limit }) as Array<{
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

export function getMissingClients(db: Database, today: string, yesterday: string, limit: number): SnapshotClient[] {
  const rows = db.prepare(
    `SELECT composite_key, account_id, client_id, full_name, raw_json
     FROM client_snapshots yest
     WHERE yest.snapshot_date = $yesterday
       AND NOT EXISTS (
         SELECT 1 FROM client_snapshots today
         WHERE today.snapshot_date = $today AND today.composite_key = yest.composite_key
       )
     LIMIT $limit`
  ).all({ today, yesterday, limit }) as Array<{
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

export function purgeOlderThan(db: Database, days: number, referenceDate: string): void {
  db.prepare(
    "DELETE FROM client_snapshots WHERE date(snapshot_date) < date($referenceDate, '-' || $days || ' days')"
  ).run({ referenceDate, days });
}

export function getRecentSnapshotDates(db: Database, upToDate: string, limit: number): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT snapshot_date FROM client_snapshots WHERE snapshot_date <= $upToDate ORDER BY snapshot_date DESC LIMIT $limit"
  ).all({ upToDate, limit }) as Array<{ snapshot_date: string }>;
  return rows.map((r) => r.snapshot_date).reverse();
}

export function countWalletsByDate(db: Database, date: string, targetWallet: number): number {
  const row = db.prepare(
    targetWallet
      ? `SELECT COUNT(DISTINCT client_id) as count FROM client_snapshots WHERE snapshot_date = $date AND json_extract(raw_json, '$.subaffiliate') = $targetWallet`
      : "SELECT COUNT(DISTINCT client_id) as count FROM client_snapshots WHERE snapshot_date = $date"
  ).get({ date, targetWallet }) as { count: number } | null;
  return row?.count ?? 0;
}

export function getMissingWalletIds(db: Database, today: string, yesterday: string, targetWallet: number): number[] {
  const rows = db.prepare(
    targetWallet
      ? `SELECT DISTINCT yest.client_id FROM client_snapshots yest
         WHERE yest.snapshot_date = $yesterday
         AND json_extract(yest.raw_json, '$.subaffiliate') = $targetWallet
         AND yest.client_id NOT IN (
           SELECT DISTINCT today.client_id FROM client_snapshots today
           WHERE today.snapshot_date = $today
           AND json_extract(today.raw_json, '$.subaffiliate') = $targetWallet
         )
         ORDER BY yest.client_id`
      : `SELECT DISTINCT yest.client_id FROM client_snapshots yest
         WHERE yest.snapshot_date = $yesterday
         AND yest.client_id NOT IN (
           SELECT DISTINCT today.client_id FROM client_snapshots today
           WHERE today.snapshot_date = $today
         )
         ORDER BY yest.client_id`
  ).all({ today, yesterday, targetWallet }) as Array<{ client_id: number }>;
  return rows.map((r) => r.client_id);
}

export function getNewWalletIds(db: Database, today: string, yesterday: string, targetWallet: number): number[] {
  const rows = db.prepare(
    targetWallet
      ? `SELECT DISTINCT today.client_id FROM client_snapshots today
         WHERE today.snapshot_date = $today
         AND json_extract(today.raw_json, '$.subaffiliate') = $targetWallet
         AND today.client_id NOT IN (
           SELECT DISTINCT yest.client_id FROM client_snapshots yest
           WHERE yest.snapshot_date = $yesterday
           AND json_extract(yest.raw_json, '$.subaffiliate') = $targetWallet
         )
         ORDER BY today.client_id`
      : `SELECT DISTINCT today.client_id FROM client_snapshots today
         WHERE today.snapshot_date = $today
         AND today.client_id NOT IN (
           SELECT DISTINCT yest.client_id FROM client_snapshots yest
           WHERE yest.snapshot_date = $yesterday
         )
         ORDER BY today.client_id`
  ).all({ today, yesterday, targetWallet }) as Array<{ client_id: number }>;
  return rows.map((r) => r.client_id);
}
