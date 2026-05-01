import type { Database } from "bun:sqlite";
import type { HFMClientRow, HFMClientsResult } from "../types/hfm.types";
import { getDatabase, initSqlite, checkpointDatabase } from "../services/sqlite.service";
import { countByDate, insertMany, purgeOlderThan } from "../repositories/snapshot.repository";
import {
  insertRequestSnapshot,
  getLatestRequestSnapshotBefore,
  type RequestSnapshotRow,
} from "../repositories/request-snapshot.repository";
import { seedFromEnv, getActiveUids } from "../repositories/recipient.repository";
import { fetchClients, normalizeClientRow } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import {
  getIctDateString,
  getPreviousIctDateString,
  formatShortDate,
  getLastWeekRange,
  getLastMonthRange,
} from "../utils/date";

export type ReportPeriod = "day" | "week" | "month";

function getTargetWallet(): { wallet: number; label: string } {
  const raw = Number(process.env.TARGET_WALLET);
  return {
    wallet: Number.isNaN(raw) || raw === 0 ? 0 : raw,
    label: process.env.TARGET_WALLET?.trim() || "N/A",
  };
}

function dedupeByCompositeKey(rows: HFMClientRow[]): HFMClientRow[] {
  const seen = new Set<string>();
  const result: HFMClientRow[] = [];
  for (const row of rows) {
    const key = `${row.id}_${row.wallet}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(row);
    }
  }
  return result;
}

function extractWalletIds(rows: HFMClientRow[]): Set<number> {
  return new Set(rows.map((r) => r.wallet));
}

function getWalletIdsFromNightlySnapshot(db: Database, date: string): Set<number> {
  const rows = db
    .prepare("SELECT DISTINCT client_id FROM client_snapshots WHERE snapshot_date = $date")
    .all({ date }) as Array<{ client_id: number }>;
  return new Set(rows.map((r) => r.client_id));
}

function findMissingFromSets(prev: Set<number>, curr: Set<number>): number[] {
  const result: number[] = [];
  for (const id of prev) {
    if (!curr.has(id)) result.push(id);
  }
  return result.sort((a, b) => a - b);
}

function findNewFromSets(prev: Set<number>, curr: Set<number>): number[] {
  const result: number[] = [];
  for (const id of curr) {
    if (!prev.has(id)) result.push(id);
  }
  return result.sort((a, b) => a - b);
}

function findMissingFromRequestSnapshots(prev: RequestSnapshotRow[], curr: Set<number>): number[] {
  const prevIds = new Set<number>();
  for (const r of prev) {
    if (!curr.has(r.client_id) && !prevIds.has(r.client_id)) {
      prevIds.add(r.client_id);
    }
  }
  return [...prevIds].sort((a, b) => a - b);
}

function findNewFromRequestSnapshots(prev: RequestSnapshotRow[], curr: Set<number>): number[] {
  const prevIds = new Set(prev.map((r) => r.client_id));
  const newIds = new Set<number>();
  for (const id of curr) {
    if (!prevIds.has(id)) newIds.add(id);
  }
  return [...newIds].sort((a, b) => a - b);
}

function countDistinctInSnapshots(rows: RequestSnapshotRow[]): number {
  return new Set(rows.map((r) => r.client_id)).size;
}

export function buildDayReportMessage(options: {
  baselineLabel: string;
  baselineDate: string;
  baselineCount: number;
  currentCount: number;
  targetWalletLabel: string;
  missingIds: number[];
  newIds: number[];
}): string {
  const {
    baselineLabel,
    baselineDate,
    baselineCount,
    currentCount,
    targetWalletLabel,
    missingIds,
    newIds,
  } = options;

  const delta = currentCount - baselineCount;
  const sign = delta > 0 ? "+" : "";
  const pctStr = baselineCount > 0 ? ` (${sign}${((delta / baselineCount) * 100).toFixed(2)}%)` : "";

  let msg = `Daily Wallet Report\n`;
  msg += `Wallet under ${targetWalletLabel}\n`;
  msg += `${baselineLabel} (${formatShortDate(baselineDate)}): ${baselineCount} Wallets\n`;
  msg += `Current: ${currentCount} Wallets\n`;
  msg += `Change: ${sign}${delta} Wallets${pctStr}\n`;

  if (missingIds.length > 0) {
    msg += `${missingIds.length} Missing Wallets since ${baselineLabel}\n`;
    for (const id of missingIds.slice(0, 50)) {
      msg += `-${id}\n`;
    }
    if (missingIds.length > 50) {
      msg += `... and ${missingIds.length - 50} more\n`;
    }
  } else {
    msg += `0 Missing Wallets since ${baselineLabel}\n`;
  }

  if (newIds.length > 0) {
    msg += `${newIds.length} New Wallets\n`;
  } else {
    msg += `0 New Wallets\n`;
  }

  if (msg.length > 4900) {
    msg = msg.slice(0, 4900) + "\n... truncated";
  }

  return msg.trimEnd();
}

export function buildComparisonReportMessage(options: {
  title: string;
  prevLabel: string;
  prevDate: string;
  prevCount: number;
  currLabel: string;
  currCount: number;
  targetWalletLabel: string;
  missingIds: number[];
  newIds: number[];
}): string {
  const {
    title,
    prevLabel,
    prevDate,
    prevCount,
    currLabel,
    currCount,
    targetWalletLabel,
    missingIds,
    newIds,
  } = options;

  const delta = currCount - prevCount;
  const sign = delta > 0 ? "+" : "";
  const pctStr = prevCount > 0 ? ` (${sign}${((delta / prevCount) * 100).toFixed(2)}%)` : "";

  let msg = `${title}\n`;
  msg += `Wallet under ${targetWalletLabel}\n`;
  msg += `${prevLabel} (${formatShortDate(prevDate)}): ${prevCount} Wallets\n`;
  msg += `${currLabel}: ${currCount} Wallets\n`;
  msg += `Change: ${sign}${delta} Wallets${pctStr}\n`;

  if (missingIds.length > 0) {
    msg += `${missingIds.length} Missing Wallets since ${prevLabel}\n`;
    for (const id of missingIds.slice(0, 50)) {
      msg += `-${id}\n`;
    }
    if (missingIds.length > 50) {
      msg += `... and ${missingIds.length - 50} more\n`;
    }
  } else {
    msg += `0 Missing Wallets since ${prevLabel}\n`;
  }

  if (newIds.length > 0) {
    msg += `${newIds.length} New Wallets\n`;
  } else {
    msg += `0 New Wallets\n`;
  }

  if (msg.length > 4900) {
    msg = msg.slice(0, 4900) + "\n... truncated";
  }

  return msg.trimEnd();
}

export interface RunDailyClientReportOptions {
  now?: Date;
  db?: Database;
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  reportPeriod?: ReportPeriod;
}

function hasDailyReportNotificationSent(db: Database, date: string): boolean {
  const row = db
    .query("SELECT COUNT(*) as count FROM daily_report_notifications WHERE snapshot_date = $date")
    .get({ date }) as { count: number } | null;
  return (row?.count ?? 0) > 0;
}

function markDailyReportNotificationSent(db: Database, date: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO daily_report_notifications (snapshot_date, sent_at) VALUES ($date, datetime('now'))"
  ).run({ date });
}

async function ensureTodaySnapshot(
  db: Database,
  today: string,
  fetchCurrent: () => Promise<HFMClientsResult>,
): Promise<void> {
  const existingTodayCount = countByDate(db, today);
  if (existingTodayCount > 0) return;

  const result = await fetchCurrent();
  if (!result.ok) throw new Error(`HFM fetchClients failed: ${result.reason}`);

  const normalized = dedupeByCompositeKey(result.data).map(normalizeClientRow);
  insertMany(db, today, normalized);
}

async function buildReportMessages(
  db: Database,
  now: Date,
  today: string,
  fetchCurrent: () => Promise<HFMClientsResult>,
  period: ReportPeriod,
): Promise<string[]> {
  const { label: targetLabel } = getTargetWallet();

  const result = await fetchCurrent();
  console.log(result);

  if (!result.ok) throw new Error(`HFM fetchClients failed: ${result.reason}`);
  const currentRows = dedupeByCompositeKey(result.data);
  const currentWalletIds = extractWalletIds(currentRows);
  const currCount = currentWalletIds.size;

  const messages: string[] = [];

  if (period === "day") {
    const yesterday = getPreviousIctDateString(now);
    const yesterdayExists = countByDate(db, yesterday) > 0;

    if (!yesterdayExists) {
      insertRequestSnapshot(db, today, currentRows);
      return [`The report of yesterday (${formatShortDate(yesterday)}) was not found.`];
    }

    const yesterdayWalletIds = getWalletIdsFromNightlySnapshot(db, yesterday);
    if (yesterdayWalletIds.size === 0) {
      insertRequestSnapshot(db, today, currentRows);
      return [`The report of yesterday (${formatShortDate(yesterday)}) was not found.`];
    }

    const missingIds = findMissingFromSets(yesterdayWalletIds, currentWalletIds);
    const newIds = findNewFromSets(yesterdayWalletIds, currentWalletIds);

    messages.push(
      buildDayReportMessage({
        baselineLabel: "Yesterday",
        baselineDate: yesterday,
        baselineCount: yesterdayWalletIds.size,
        currentCount: currCount,
        targetWalletLabel: targetLabel,
        missingIds,
        newIds,
      }),
    );

    const prevRequest = getLatestRequestSnapshotBefore(db, today);
    if (prevRequest) {
      const prevMissing = findMissingFromRequestSnapshots(prevRequest, currentWalletIds);
      const prevNew = findNewFromRequestSnapshots(prevRequest, currentWalletIds);
      messages.push(
        buildComparisonReportMessage({
          title: "Since Last Request",
          prevLabel: "Last request",
          prevDate: "",
          prevCount: countDistinctInSnapshots(prevRequest),
          currLabel: "Current",
          currCount,
          targetWalletLabel: targetLabel,
          missingIds: prevMissing,
          newIds: prevNew,
        }),
      );
    }

    insertRequestSnapshot(db, today, currentRows);
    return messages;
  }

  if (period === "week") {
    const lastWeek = getLastWeekRange(now);
    const lastWeekSunday = lastWeek.to;
    const lastWeekExists = countByDate(db, lastWeekSunday) > 0;

    if (!lastWeekExists) {
      insertRequestSnapshot(db, today, currentRows);
      return [`The report of last week (${formatShortDate(lastWeekSunday)}) was not found.`];
    }

    const lastWeekWalletIds = getWalletIdsFromNightlySnapshot(db, lastWeekSunday);
    if (lastWeekWalletIds.size === 0) {
      insertRequestSnapshot(db, today, currentRows);
      return [`The report of last week (${formatShortDate(lastWeekSunday)}) was not found.`];
    }

    const missingIds = findMissingFromSets(lastWeekWalletIds, currentWalletIds);
    const newIds = findNewFromSets(lastWeekWalletIds, currentWalletIds);

    messages.push(
      buildComparisonReportMessage({
        title: "Week-over-week Wallet Report",
        prevLabel: "End of last week",
        prevDate: lastWeekSunday,
        prevCount: lastWeekWalletIds.size,
        currLabel: "Current",
        currCount,
        targetWalletLabel: targetLabel,
        missingIds,
        newIds,
      }),
    );

    const prevRequest = getLatestRequestSnapshotBefore(db, today);
    if (prevRequest) {
      const prevMissing = findMissingFromRequestSnapshots(prevRequest, currentWalletIds);
      const prevNew = findNewFromRequestSnapshots(prevRequest, currentWalletIds);
      messages.push(
        buildComparisonReportMessage({
          title: "Since Last Request",
          prevLabel: "Last request",
          prevDate: "",
          prevCount: countDistinctInSnapshots(prevRequest),
          currLabel: "Current",
          currCount,
          targetWalletLabel: targetLabel,
          missingIds: prevMissing,
          newIds: prevNew,
        }),
      );
    }

    insertRequestSnapshot(db, today, currentRows);
    return messages;
  }

  if (period === "month") {
    const lastMonth = getLastMonthRange(now);
    const lastMonthEnd = lastMonth.to;
    const lastMonthExists = countByDate(db, lastMonthEnd) > 0;

    if (!lastMonthExists) {
      insertRequestSnapshot(db, today, currentRows);
      return [`The report of last month (${formatShortDate(lastMonthEnd)}) was not found.`];
    }

    const lastMonthWalletIds = getWalletIdsFromNightlySnapshot(db, lastMonthEnd);
    if (lastMonthWalletIds.size === 0) {
      insertRequestSnapshot(db, today, currentRows);
      return [`The report of last month (${formatShortDate(lastMonthEnd)}) was not found.`];
    }

    const missingIds = findMissingFromSets(lastMonthWalletIds, currentWalletIds);
    const newIds = findNewFromSets(lastMonthWalletIds, currentWalletIds);

    messages.push(
      buildComparisonReportMessage({
        title: "Month-over-month Wallet Report",
        prevLabel: "End of last month",
        prevDate: lastMonthEnd,
        prevCount: lastMonthWalletIds.size,
        currLabel: "Current",
        currCount,
        targetWalletLabel: targetLabel,
        missingIds,
        newIds,
      }),
    );

    const prevRequest = getLatestRequestSnapshotBefore(db, today);
    if (prevRequest) {
      const prevMissing = findMissingFromRequestSnapshots(prevRequest, currentWalletIds);
      const prevNew = findNewFromRequestSnapshots(prevRequest, currentWalletIds);
      messages.push(
        buildComparisonReportMessage({
          title: "Since Last Request",
          prevLabel: "Last request",
          prevDate: "",
          prevCount: countDistinctInSnapshots(prevRequest),
          currLabel: "Current",
          currCount,
          targetWalletLabel: targetLabel,
          missingIds: prevMissing,
          newIds: prevNew,
        }),
      );
    }

    insertRequestSnapshot(db, today, currentRows);
    return messages;
  }

  throw new Error(`Unknown report period: ${period}`);
}

export async function generateReportForUser(options: RunDailyClientReportOptions = {}): Promise<string[]> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchCurrent = options.fetchClientsFn ?? fetchClients;
  const period = options.reportPeriod ?? "day";

  initSqlite(db);
  const today = getIctDateString(now);
  return await buildReportMessages(db, now, today, fetchCurrent, period);
}

export async function runDailyClientReport(options: RunDailyClientReportOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchCurrent = options.fetchClientsFn ?? fetchClients;
  const pushAll = options.pushToAllFn ?? pushToAll;

  initSqlite(db);
  seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");

  const today = getIctDateString(now);

  await ensureTodaySnapshot(db, today, fetchCurrent);

  if (hasDailyReportNotificationSent(db, today)) {
    console.warn(`[cron] daily-client-report notification already sent for ${today}; skipping`);
    return;
  }

  const yesterday = getPreviousIctDateString(now);
  const yesterdayExists = countByDate(db, yesterday) > 0;

  const uids = getActiveUids(db);
  if (uids.length === 0) {
    console.warn("[cron] daily-client-report has no active LINE recipients");
  } else if (yesterdayExists) {
    const { label: targetLabel } = getTargetWallet();
    const todayWalletIds = getWalletIdsFromNightlySnapshot(db, today);
    const yesterdayWalletIds = getWalletIdsFromNightlySnapshot(db, yesterday);
    const todayCount = todayWalletIds.size;
    const yesterdayCount = yesterdayWalletIds.size;
    const missing = findMissingFromSets(yesterdayWalletIds, todayWalletIds);
    const newW = findNewFromSets(yesterdayWalletIds, todayWalletIds);
    const message = buildDayReportMessage({
      baselineLabel: "Yesterday",
      baselineDate: yesterday,
      baselineCount: yesterdayCount,
      currentCount: todayCount,
      targetWalletLabel: targetLabel,
      missingIds: missing,
      newIds: newW,
    });
    await pushAll(uids, message);
    markDailyReportNotificationSent(db, today);
  } else {
    console.warn(`[cron] daily-client-report: no yesterday snapshot for ${yesterday}, skipping notification`);
  }

  purgeOlderThan(db, 90, today);
  checkpointDatabase();
}
