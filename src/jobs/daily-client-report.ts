import type { Database } from "bun:sqlite";
import type { HFMClientsPerformanceResponse, HFMAllClientsResult } from "../types/hfm.types";
import { getDatabase, initSqlite, checkpointDatabase } from "../services/sqlite.service";
import { countByDate, insertMany, purgeOlderThan, countWalletsByDate, getMissingWalletIds, getNewWalletIds } from "../repositories/snapshot.repository";
import { getRangeSnapshot, upsertRangeSnapshot } from "../repositories/report-range.repository";
import { seedFromEnv, getActiveUids } from "../repositories/recipient.repository";
import { fetchAllClients, fetchClientsByRange } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import { getIctDateString, getPreviousIctDateString, formatShortDate, getThisWeekRange, getLastWeekRange, getThisMonthRange, getLastMonthRange } from "../utils/date";

export type ReportPeriod = "day" | "week" | "month";

function getTargetWallet(): { wallet: number; label: string } {
  const raw = Number(process.env.TARGET_WALLET);
  return {
    wallet: Number.isNaN(raw) || raw === 0 ? 0 : raw,
    label: process.env.TARGET_WALLET?.trim() || "N/A",
  };
}

function filterByWallet(clients: HFMClientsPerformanceResponse["clients"], targetWallet: number): HFMClientsPerformanceResponse["clients"] {
  if (!targetWallet) return clients;
  return clients.filter((c) => c.subaffiliate === targetWallet);
}

function countDistinctClients(clients: HFMClientsPerformanceResponse["clients"]): number {
  const ids = new Set(clients.map((c) => c.client_id));
  return ids.size;
}

function findMissing(prev: HFMClientsPerformanceResponse["clients"], curr: HFMClientsPerformanceResponse["clients"]): number[] {
  const currIds = new Set(curr.map((c) => c.client_id));
  const prevIds = new Set<number>();
  for (const c of prev) {
    if (!currIds.has(c.client_id) && !prevIds.has(c.client_id)) {
      prevIds.add(c.client_id);
    }
  }
  return [...prevIds].sort((a, b) => a - b);
}

function findNew(prev: HFMClientsPerformanceResponse["clients"], curr: HFMClientsPerformanceResponse["clients"]): number[] {
  const prevIds = new Set(prev.map((c) => c.client_id));
  const newIds = new Set<number>();
  for (const c of curr) {
    if (!prevIds.has(c.client_id) && !newIds.has(c.client_id)) {
      newIds.add(c.client_id);
    }
  }
  return [...newIds].sort((a, b) => a - b);
}

export function buildWeeklyReportMessage(options: {
  dates: string[];
  dateCounts: Map<string, number>;
  targetWalletLabel: string;
  missingWalletIds: number[];
  newWalletCount: number;
}): string {
  const { dates, dateCounts, targetWalletLabel, missingWalletIds, newWalletCount } = options;

  let message = "";
  for (const date of dates) {
    const count = dateCounts.get(date) ?? 0;
    message += `${formatShortDate(date)} : Total Wallet under ${targetWalletLabel} : ${count} Wallets\n`;
  }

  const missingCount = missingWalletIds.length;
  message += `${missingCount} Missing Wallet today\n`;
  for (const id of missingWalletIds) {
    message += `-${id}\n`;
  }

  message += `${newWalletCount} New Wallets today`;

  return message.trimEnd();
}

export function buildComparisonReportMessage(options: {
  title: string;
  prevLabel: string;
  prevFrom: string;
  prevTo: string;
  prevCount: number;
  currLabel: string;
  currFrom: string;
  currTo: string;
  currCount: number;
  targetWalletLabel: string;
  missingIds: number[];
  newIds: number[];
}): string {
  const {
    title,
    prevLabel,
    prevFrom,
    prevTo,
    prevCount,
    currLabel,
    currFrom,
    currTo,
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
  msg += `${prevLabel} (${formatShortDate(prevFrom)} - ${formatShortDate(prevTo)}): ${prevCount} Wallets\n`;
  msg += `${currLabel} (${formatShortDate(currFrom)} - ${formatShortDate(currTo)}): ${currCount} Wallets\n`;
  msg += `Change: ${sign}${delta} Wallets${pctStr}\n`;

  if (missingIds.length > 0) {
    msg += `${missingIds.length} Missing Wallets since ${prevLabel}\n`;
    for (const id of missingIds) {
      msg += `-${id}\n`;
    }
  } else {
    msg += `0 Missing Wallets since ${prevLabel}\n`;
  }

  if (newIds.length > 0) {
    msg += `${newIds.length} New Wallets in ${currLabel}\n`;
  } else {
    msg += `0 New Wallets in ${currLabel}\n`;
  }

  return msg.trimEnd();
}

export interface RunDailyClientReportOptions {
  now?: Date;
  db?: Database;
  fetchAllClientsFn?: () => Promise<HFMAllClientsResult>;
  fetchByRangeFn?: (fromDate: string, toDate: string) => Promise<HFMAllClientsResult>;
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
  fetchAll: () => Promise<HFMAllClientsResult>,
): Promise<void> {
  const existingTodayCount = countByDate(db, today);
  if (existingTodayCount > 0) return;

  const result = await fetchAll();
  if (!result.ok) throw new Error(`HFM fetchAllClients failed: ${result.reason}`);

  insertMany(db, today, result.data.clients);
}

async function ensureRangeSnapshot(
  db: Database,
  period: string,
  fromDate: string,
  toDate: string,
  fetchByRange: (fromDate: string, toDate: string) => Promise<HFMAllClientsResult>,
): Promise<HFMClientsPerformanceResponse> {
  const cached = getRangeSnapshot(db, period, fromDate, toDate);
  if (cached) return cached.data;

  const result = await fetchByRange(fromDate, toDate);
  if (!result.ok) throw new Error(`HFM fetchClientsByRange(${fromDate},${toDate}) failed: ${result.reason}`);

  upsertRangeSnapshot(db, period, fromDate, toDate, result.data);
  return result.data;
}

async function buildReportData(
  db: Database,
  now: Date,
  today: string,
  fetchAll: () => Promise<HFMAllClientsResult>,
  period: ReportPeriod = "day",
  fetchByRange: (fromDate: string, toDate: string) => Promise<HFMAllClientsResult> = fetchClientsByRange,
) {
  const { wallet: targetWallet, label: targetLabel } = getTargetWallet();

  if (period === "day") {
    await ensureTodaySnapshot(db, today, fetchAll);
    const yesterday = getPreviousIctDateString(now);
    const dates = [today];

    const dateCounts = new Map<string, number>();
    for (const d of dates) {
      dateCounts.set(d, countWalletsByDate(db, d, targetWallet));
    }

    const yesterdayExists = countByDate(db, yesterday) > 0;
    const missingWalletIds = yesterdayExists
      ? getMissingWalletIds(db, today, yesterday, targetWallet)
      : [];
    const newWalletCount = yesterdayExists
      ? getNewWalletIds(db, today, yesterday, targetWallet).length
      : 0;

    return buildWeeklyReportMessage({
      dates,
      dateCounts,
      targetWalletLabel: targetLabel,
      missingWalletIds,
      newWalletCount,
    });
  }

  if (period === "week") {
    const lastWeek = getLastWeekRange(now);
    const thisWeek = getThisWeekRange(now);

    const prevData = await ensureRangeSnapshot(db, "week_prev", lastWeek.from, lastWeek.to, fetchByRange);
    const currData = await ensureRangeSnapshot(db, "week_curr", thisWeek.from, thisWeek.to, fetchByRange);

    const prevClients = filterByWallet(prevData.clients, targetWallet);
    const currClients = filterByWallet(currData.clients, targetWallet);

    return buildComparisonReportMessage({
      title: "Week-over-week Wallet Report",
      prevLabel: "Last week",
      prevFrom: lastWeek.from,
      prevTo: lastWeek.to,
      prevCount: countDistinctClients(prevClients),
      currLabel: "This week",
      currFrom: thisWeek.from,
      currTo: thisWeek.to,
      currCount: countDistinctClients(currClients),
      targetWalletLabel: targetLabel,
      missingIds: findMissing(prevClients, currClients),
      newIds: findNew(prevClients, currClients),
    });
  }

  if (period === "month") {
    const lastMonth = getLastMonthRange(now);
    const thisMonth = getThisMonthRange(now);

    const prevData = await ensureRangeSnapshot(db, "month_prev", lastMonth.from, lastMonth.to, fetchByRange);
    const currData = await ensureRangeSnapshot(db, "month_curr", thisMonth.from, thisMonth.to, fetchByRange);

    const prevClients = filterByWallet(prevData.clients, targetWallet);
    const currClients = filterByWallet(currData.clients, targetWallet);

    return buildComparisonReportMessage({
      title: "Month-over-month Wallet Report",
      prevLabel: "Last month",
      prevFrom: lastMonth.from,
      prevTo: lastMonth.to,
      prevCount: countDistinctClients(prevClients),
      currLabel: "This month",
      currFrom: thisMonth.from,
      currTo: thisMonth.to,
      currCount: countDistinctClients(currClients),
      targetWalletLabel: targetLabel,
      missingIds: findMissing(prevClients, currClients),
      newIds: findNew(prevClients, currClients),
    });
  }

  throw new Error(`Unknown report period: ${period}`);
}

export async function generateReportForUser(options: RunDailyClientReportOptions = {}): Promise<string> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchAll = options.fetchAllClientsFn ?? fetchAllClients;
  const fetchByRange = options.fetchByRangeFn ?? fetchClientsByRange;
  const period = options.reportPeriod ?? "day";

  initSqlite(db);
  const today = getIctDateString(now);
  return await buildReportData(db, now, today, fetchAll, period, fetchByRange);
}

export async function runDailyClientReport(options: RunDailyClientReportOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchAll = options.fetchAllClientsFn ?? fetchAllClients;
  const pushAll = options.pushToAllFn ?? pushToAll;
  const fetchByRange = options.fetchByRangeFn ?? fetchClientsByRange;

  initSqlite(db);
  seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");

  const today = getIctDateString(now);

  await ensureTodaySnapshot(db, today, fetchAll);

  const lastWeek = getLastWeekRange(now);
  const thisWeek = getThisWeekRange(now);
  const lastMonth = getLastMonthRange(now);
  const thisMonth = getThisMonthRange(now);

  await ensureRangeSnapshot(db, "week_prev", lastWeek.from, lastWeek.to, fetchByRange);
  await ensureRangeSnapshot(db, "week_curr", thisWeek.from, thisWeek.to, fetchByRange);
  await ensureRangeSnapshot(db, "month_prev", lastMonth.from, lastMonth.to, fetchByRange);
  await ensureRangeSnapshot(db, "month_curr", thisMonth.from, thisMonth.to, fetchByRange);

  if (hasDailyReportNotificationSent(db, today)) {
    console.warn(`[cron] daily-client-report notification already sent for ${today}; skipping`);
    return;
  }

  const { wallet: targetWallet, label: targetLabel } = getTargetWallet();
  const yesterday = getPreviousIctDateString(now);
  const dateCounts = new Map<string, number>();
  dateCounts.set(today, countWalletsByDate(db, today, targetWallet));

  const yesterdayExists = countByDate(db, yesterday) > 0;
  const missingWalletIds = yesterdayExists
    ? getMissingWalletIds(db, today, yesterday, targetWallet)
    : [];
  const newWalletCount = yesterdayExists
    ? getNewWalletIds(db, today, yesterday, targetWallet).length
    : 0;

  const message = buildWeeklyReportMessage({
    dates: [today],
    dateCounts,
    targetWalletLabel: targetLabel,
    missingWalletIds,
    newWalletCount,
  });

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
