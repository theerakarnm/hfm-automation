import type { Database } from "bun:sqlite";
import type { HFMClientsPerformanceResponse, HFMAllClientsResult } from "../types/hfm.types";
import { getDatabase, initSqlite, checkpointDatabase } from "../services/sqlite.service";
import { countByDate, insertMany, purgeOlderThan, getRecentSnapshotDates, countWalletsByDate, getMissingWalletIds } from "../repositories/snapshot.repository";
import { seedFromEnv, getActiveUids } from "../repositories/recipient.repository";
import { fetchAllClients } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import { getIctDateString, getPreviousIctDateString } from "../utils/date";

const REPORT_WEEK_DAYS = 7;

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  const shortYear = (year ?? "").slice(-2);
  return `${day}/${month}/${shortYear}`;
}

function getTargetWallet(): { wallet: number; label: string } {
  const raw = Number(process.env.TARGET_WALLET);
  return {
    wallet: Number.isNaN(raw) || raw === 0 ? 0 : raw,
    label: process.env.TARGET_WALLET?.trim() || "N/A",
  };
}

export function buildWeeklyReportMessage(options: {
  dates: string[];
  dateCounts: Map<string, number>;
  targetWalletLabel: string;
  missingWalletIds: number[];
}): string {
  const { dates, dateCounts, targetWalletLabel, missingWalletIds } = options;

  let message = "";
  for (const date of dates) {
    const count = dateCounts.get(date) ?? 0;
    message += `${formatDate(date)} : Total Wallet under ${targetWalletLabel} : ${count} Wallets\n`;
  }

  const missingCount = missingWalletIds.length;
  message += `${missingCount} Missing Wallet today\n`;
  for (const id of missingWalletIds) {
    message += `-${id}\n`;
  }

  return message.trimEnd();
}

export interface RunDailyClientReportOptions {
  now?: Date;
  db?: Database;
  fetchAllClientsFn?: () => Promise<HFMAllClientsResult>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
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

function totalsFromCount(count: number): HFMClientsPerformanceResponse["totals"] {
  return {
    clients: count,
    accounts: count,
    volume: 0,
    balance: 0,
    withdrawals: 0,
    commission: 0,
  };
}

async function ensureTodaySnapshot(
  db: Database,
  today: string,
  fetchAll: () => Promise<HFMAllClientsResult>,
): Promise<void> {
  const existingTodayCount = countByDate(db, today);
  if (existingTodayCount > 0) return;

  const result = await fetchAll();
  if (!result.ok) throw new Error(`HFM fetchAllClients failed: ${result.reason}`);

  insertMany(db, today, result.data.clients);
}

async function buildReportData(
  db: Database,
  now: Date,
  today: string,
  fetchAll: () => Promise<HFMAllClientsResult>,
) {
  await ensureTodaySnapshot(db, today, fetchAll);

  const { wallet: targetWallet, label: targetLabel } = getTargetWallet();
  const yesterday = getPreviousIctDateString(now);

  const dates = getRecentSnapshotDates(db, today, REPORT_WEEK_DAYS);

  const dateCounts = new Map<string, number>();
  for (const d of dates) {
    dateCounts.set(d, countWalletsByDate(db, d, targetWallet));
  }

  const yesterdayExists = countByDate(db, yesterday) > 0;
  const missingWalletIds = yesterdayExists
    ? getMissingWalletIds(db, today, yesterday, targetWallet)
    : [];

  return buildWeeklyReportMessage({
    dates,
    dateCounts,
    targetWalletLabel: targetLabel,
    missingWalletIds,
  });
}

export async function generateReportForUser(options: RunDailyClientReportOptions = {}): Promise<string> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchAll = options.fetchAllClientsFn ?? fetchAllClients;

  initSqlite(db);
  const today = getIctDateString(now);
  return await buildReportData(db, now, today, fetchAll);
}

export async function runDailyClientReport(options: RunDailyClientReportOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchAll = options.fetchAllClientsFn ?? fetchAllClients;
  const pushAll = options.pushToAllFn ?? pushToAll;

  initSqlite(db);
  seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");

  const today = getIctDateString(now);

  if (hasDailyReportNotificationSent(db, today)) {
    console.warn(`[cron] daily-client-report notification already sent for ${today}; skipping`);
    return;
  }

  const message = await buildReportData(db, now, today, fetchAll);

  const uids = getActiveUids(db);
  if (uids.length === 0) {
    console.warn("[cron] daily-client-report has no active LINE recipients");
  } else {
    await pushAll(uids, message);
    markDailyReportNotificationSent(db, today);
  }

  purgeOlderThan(db, 90, today);
  checkpointDatabase();
}
