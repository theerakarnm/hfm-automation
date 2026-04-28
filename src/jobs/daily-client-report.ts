import type { Database } from "bun:sqlite";
import type { SnapshotClient, DiffCounts } from "../repositories/snapshot.repository";
import type { HFMClientsPerformanceResponse, HFMAllClientsResult } from "../types/hfm.types";
import { getDatabase, initSqlite, checkpointDatabase } from "../services/sqlite.service";
import { countByDate, insertMany, purgeOlderThan, diffCounts, getAddedClients, getMissingClients } from "../repositories/snapshot.repository";
import { seedFromEnv, getActiveUids } from "../repositories/recipient.repository";
import { fetchAllClients } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import { getIctDateString, getPreviousIctDateString } from "../utils/date";

const LINE_SAFE_LIMIT = 4500;
const DISPLAY_LIMIT_PER_SECTION = 50;

export function buildDailyClientReportMessage(options: {
  date: string;
  totals: HFMClientsPerformanceResponse["totals"];
  counts: DiffCounts;
  addedClients: SnapshotClient[];
  missingClients: SnapshotClient[];
}): string {
  const { date, totals, counts, addedClients, missingClients } = options;
  const displayDate = formatDate(date);
  const totalClients = Number(totals.clients);

  const header = `\uD83D\uDCC5 Daily Client Report \u2014 ${displayDate}`;

  if (counts.added === 0 && counts.missing === 0) {
    return `${header}\n\u2705 No changes detected.\n\uD83D\uDCCA Total Clients Today: ${totalClients}`;
  }

  const totalLine = `\uD83D\uDCCA Total Clients Today: ${totalClients}`;

  let message = `${header}\n\n`;

  message += buildSection("\u2705 New Clients", counts.added, addedClients);
  message += buildSection("\u274C Missing Clients", counts.missing, missingClients);
  message += `\n${totalLine}`;

  if (message.length <= LINE_SAFE_LIMIT) {
    return message;
  }

  return truncateReport(header, counts, addedClients, missingClients, totalLine);
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

function buildSection(title: string, totalCount: number, clients: SnapshotClient[]): string {
  const sep = "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501";
  let section = `${title} (${totalCount})\n${sep}\n`;
  for (const c of clients) {
    section += clientBlock(c);
  }
  return section;
}

function clientBlock(c: SnapshotClient): string {
  return `\u2022 ${c.full_name}\n  Client ID : ${c.client_id}\n  Account ID: ${c.account_id}\n\n`;
}

function truncateReport(
  header: string,
  counts: DiffCounts,
  addedClients: SnapshotClient[],
  missingClients: SnapshotClient[],
  totalLine: string
): string {
  const sep = "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501";
  let message = `${header}\n\n`;

  const allClients: Array<{ client: SnapshotClient; section: "new" | "missing" }> = [
    ...addedClients.map((c) => ({ client: c, section: "new" as const })),
    ...missingClients.map((c) => ({ client: c, section: "missing" as const })),
  ];

  let addedNewHeader = false;
  let addedMissingHeader = false;
  let remaining = counts.added + counts.missing;
  let fitCount = 0;

  for (const item of allClients) {
    if (item.section === "new" && !addedNewHeader) {
      message += `\u2705 New Clients (${counts.added})\n${sep}\n`;
      addedNewHeader = true;
    }
    if (item.section === "missing" && !addedMissingHeader) {
      message += `\n\u274C Missing Clients (${counts.missing})\n${sep}\n`;
      addedMissingHeader = true;
    }

    const block = clientBlock(item.client);
    remaining = counts.added + counts.missing - fitCount;
    const truncationLine = `... and ${remaining} more. Check full report.\n\n${totalLine}`;

    if (message.length + block.length + truncationLine.length > LINE_SAFE_LIMIT) {
      break;
    }

    message += block;
    fitCount++;
    remaining = counts.added + counts.missing - fitCount;
  }

  if (remaining > 0) {
    message += `... and ${remaining} more. Check full report.\n`;
  }

  message += `\n${totalLine}`;

  return message.slice(0, 5000);
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

export async function runDailyClientReport(options: RunDailyClientReportOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchAll = options.fetchAllClientsFn ?? fetchAllClients;
  const pushAll = options.pushToAllFn ?? pushToAll;

  initSqlite(db);
  seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");

  const today = getIctDateString(now);
  const yesterday = getPreviousIctDateString(now);

  const existingTodayCount = countByDate(db, today);
  let totals: HFMClientsPerformanceResponse["totals"];

  if (existingTodayCount > 0) {
    if (hasDailyReportNotificationSent(db, today)) {
      console.warn(`[cron] daily-client-report snapshot and notification already exist for ${today}; skipping`);
      return;
    }
    totals = totalsFromCount(existingTodayCount);
  } else {
    const result = await fetchAll();
    if (!result.ok) throw new Error(`HFM fetchAllClients failed: ${result.reason}`);

    insertMany(db, today, result.data.clients);
    totals = result.data.totals;
  }

  const yesterdayCount = countByDate(db, yesterday);

  const isFirstRun = yesterdayCount === 0;

  if (isFirstRun) {
    const todayCount = countByDate(db, today);
    const message = `\uD83D\uDCC5 Daily Client Report \u2014 ${today.split("-").reverse().join("/")}\n\uD83D\uDD14 First run \u2014 baseline snapshot saved.\n\uD83D\uDCCA Total Clients Today: ${Number(totals.clients)}`;

    const uids = getActiveUids(db);
    if (uids.length === 0) {
      console.warn("[cron] daily-client-report has no active LINE recipients");
    } else {
      await pushAll(uids, message);
      markDailyReportNotificationSent(db, today);
    }

    purgeOlderThan(db, 90, today);
    checkpointDatabase();
    return;
  }

  const counts = diffCounts(db, today, yesterday);

  if (counts.added === 0 && counts.missing === 0) {
    const message = buildDailyClientReportMessage({
      date: today,
      totals,
      counts,
      addedClients: [],
      missingClients: [],
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
    return;
  }

  const addedClients = getAddedClients(db, today, yesterday, DISPLAY_LIMIT_PER_SECTION);
  const missingClients = getMissingClients(db, today, yesterday, DISPLAY_LIMIT_PER_SECTION);

  const message = buildDailyClientReportMessage({
    date: today,
    totals,
    counts,
    addedClients,
    missingClients,
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
