import type { Database } from "bun:sqlite";
import type { HFMClientsPerformanceResponse } from "../types/hfm.types";

export interface RangeSnapshotRow {
  period: string;
  from_date: string;
  to_date: string;
  data: HFMClientsPerformanceResponse;
}

export function getRangeSnapshot(
  db: Database,
  period: string,
  fromDate: string,
  toDate: string,
): RangeSnapshotRow | null {
  const row = db
    .prepare(
      "SELECT period, from_date, to_date, raw_json FROM report_range_snapshots WHERE period = $period AND from_date = $fromDate AND to_date = $toDate"
    )
    .get({ period, fromDate, toDate }) as {
    period: string;
    from_date: string;
    to_date: string;
    raw_json: string;
  } | null;
  if (!row) return null;
  return {
    period: row.period,
    from_date: row.from_date,
    to_date: row.to_date,
    data: JSON.parse(row.raw_json) as HFMClientsPerformanceResponse,
  };
}

export function upsertRangeSnapshot(
  db: Database,
  period: string,
  fromDate: string,
  toDate: string,
  data: HFMClientsPerformanceResponse,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO report_range_snapshots (period, from_date, to_date, raw_json) VALUES ($period, $fromDate, $toDate, $rawJson)"
  ).run({
    period,
    fromDate,
    toDate,
    rawJson: JSON.stringify(data),
  });
}
