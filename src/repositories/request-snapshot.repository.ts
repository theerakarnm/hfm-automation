import type { Database } from "bun:sqlite";
import type { HFMClientRow } from "../types/hfm.types";

export interface RequestSnapshotRow {
  client_id: number;
}

export interface RequestSnapshotResult {
  rows: RequestSnapshotRow[];
  snapshotDate: string;
  createdAt: string;
}

export function insertRequestSnapshot(
  db: Database,
  date: string,
  rows: HFMClientRow[],
): number {
  const now = new Date().toISOString();
  const insertHeader = db.prepare(
    "INSERT INTO client_request_snapshots (snapshot_date, created_at) VALUES ($date, $createdAt)"
  );
  const insertRow = db.prepare(
    "INSERT OR IGNORE INTO client_request_snapshot_rows (snapshot_id, client_id) VALUES ($snapshotId, $clientId)"
  );

  const seen = new Set<number>();
  const tx = db.transaction(() => {
    const info = insertHeader.run({ date, createdAt: now });
    const snapshotId = Number(info.lastInsertRowid);
    for (const row of rows) {
      if (seen.has(row.wallet)) continue;
      seen.add(row.wallet);
      insertRow.run({ snapshotId, clientId: row.wallet });
    }
    return snapshotId;
  });

  return tx();
}

export function getLatestRequestSnapshotBefore(
  db: Database,
  beforeDate: string,
): RequestSnapshotResult | null {
  const headerRow = db
    .prepare(
      "SELECT id, snapshot_date, created_at FROM client_request_snapshots WHERE snapshot_date <= $beforeDate ORDER BY id DESC LIMIT 1"
    )
    .get({ beforeDate }) as { id: number; snapshot_date: string; created_at: string } | null;
  if (!headerRow) return null;

  const rows = db
    .prepare(
      "SELECT client_id FROM client_request_snapshot_rows WHERE snapshot_id = $snapshotId"
    )
    .all({ snapshotId: headerRow.id }) as Array<{ client_id: number }>;

  if (rows.length === 0) return null;

  return {
    rows: rows.map((r) => ({ client_id: r.client_id })),
    snapshotDate: headerRow.snapshot_date,
    createdAt: headerRow.created_at,
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
