import type { Database } from "bun:sqlite";
import type { HFMClientRow } from "../types/hfm.types";

export interface RequestSnapshotRow {
  composite_key: string;
  account_id: number;
  client_id: number;
  full_name: string;
  raw: HFMClientRow;
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
    "INSERT INTO client_request_snapshot_rows (snapshot_id, composite_key, account_id, client_id, full_name, raw_json) VALUES ($snapshotId, $compositeKey, $accountId, $clientId, $fullName, $rawJson)"
  );

  const tx = db.transaction(() => {
    const info = insertHeader.run({ date, createdAt: now });
    const snapshotId = Number(info.lastInsertRowid);
    for (const row of rows) {
      const compositeKey = `${row.id}_${row.wallet}`;
      insertRow.run({
        snapshotId,
        compositeKey,
        accountId: row.id,
        clientId: row.wallet,
        fullName: row.name?.trim() || "Unknown Client",
        rawJson: JSON.stringify(row),
      });
    }
    return snapshotId;
  });

  return tx();
}

export function getLatestRequestSnapshotBefore(
  db: Database,
  beforeDate: string,
): RequestSnapshotRow[] | null {
  const headerRow = db
    .prepare(
      "SELECT id FROM client_request_snapshots WHERE snapshot_date <= $beforeDate ORDER BY id DESC LIMIT 1"
    )
    .get({ beforeDate }) as { id: number } | null;
  if (!headerRow) return null;

  const rows = db
    .prepare(
      "SELECT composite_key, account_id, client_id, full_name, raw_json FROM client_request_snapshot_rows WHERE snapshot_id = $snapshotId"
    )
    .all({ snapshotId: headerRow.id }) as Array<{
    composite_key: string;
    account_id: number;
    client_id: number;
    full_name: string;
    raw_json: string;
  }>;

  if (rows.length === 0) return null;

  return rows.map((r) => ({
    composite_key: r.composite_key,
    account_id: r.account_id,
    client_id: r.client_id,
    full_name: r.full_name,
    raw: JSON.parse(r.raw_json) as HFMClientRow,
  }));
}

export function countDistinctWallets(rows: RequestSnapshotRow[]): number {
  const ids = new Set(rows.map((r) => r.client_id));
  return ids.size;
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
