import type { Database } from "bun:sqlite";
import type { SnapshotClient } from "../repositories/snapshot.repository";
import type { HFMClientsPerformanceResponse, HFMAllClientsResult } from "../types/hfm.types";
import { getDatabase, initSqlite } from "../services/sqlite.service";
import { countByDate, getByDate, insertMany, purgeOlderThan } from "../repositories/snapshot.repository";
import { seedFromEnv, getActiveUids } from "../repositories/recipient.repository";
import { fetchAllClients } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import { getIctDateString, getPreviousIctDateString } from "../utils/date";

const LINE_SAFE_LIMIT = 4500;

export function compareSnapshots(today: SnapshotClient[], yesterday: SnapshotClient[]) {
  const todayKeys = new Set(today.map((c) => c.composite_key));
  const yesterdayKeys = new Set(yesterday.map((c) => c.composite_key));

  return {
    added: today.filter((c) => !yesterdayKeys.has(c.composite_key)),
    missing: yesterday.filter((c) => !todayKeys.has(c.composite_key)),
  };
}

export function buildDailyClientReportMessage(options: {
  date: string;
  today: SnapshotClient[];
  yesterday: SnapshotClient[];
  totals: HFMClientsPerformanceResponse["totals"];
}): string {
  const { date, today, yesterday, totals } = options;
  const displayDate = formatDate(date);
  const totalClients = Number(totals.clients);

  const header = `📅 Daily Client Report — ${displayDate}`;

  if (yesterday.length === 0) {
    return `${header}\n🔔 First run — baseline snapshot saved.\n📊 Total Clients Today: ${totalClients}`;
  }

  const diff = compareSnapshots(today, yesterday);

  if (diff.added.length === 0 && diff.missing.length === 0) {
    return `${header}\n✅ No changes detected.\n📊 Total Clients Today: ${totalClients}`;
  }

  const totalLine = `📊 Total Clients Today: ${totalClients}`;

  let message = `${header}\n\n`;

  message += buildSection("✅ New Clients", diff.added);
  message += buildSection("❌ Missing Clients", diff.missing);
  message += `\n${totalLine}`;

  if (message.length <= LINE_SAFE_LIMIT) {
    return message;
  }

  return truncateReport(header, diff, totalLine);
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

function buildSection(title: string, clients: SnapshotClient[]): string {
  const sep = "━━━━━━━━━━━━━━━━━━━━";
  let section = `${title} (${clients.length})\n${sep}\n`;
  for (const c of clients) {
    section += clientBlock(c);
  }
  return section;
}

function clientBlock(c: SnapshotClient): string {
  return `• ${c.full_name}\n  Client ID : ${c.client_id}\n  Account ID: ${c.account_id}\n\n`;
}

function truncateReport(
  header: string,
  diff: { added: SnapshotClient[]; missing: SnapshotClient[] },
  totalLine: string
): string {
  const sep = "━━━━━━━━━━━━━━━━━━━━";
  let message = `${header}\n\n`;

  const allClients: Array<{ client: SnapshotClient; section: "new" | "missing" }> = [
    ...diff.added.map((c) => ({ client: c, section: "new" as const })),
    ...diff.missing.map((c) => ({ client: c, section: "missing" as const })),
  ];

  let addedNewHeader = false;
  let addedMissingHeader = false;
  let remaining = 0;
  let fitCount = 0;

  for (const item of allClients) {
    if (item.section === "new" && !addedNewHeader) {
      message += `✅ New Clients (${diff.added.length})\n${sep}\n`;
      addedNewHeader = true;
    }
    if (item.section === "missing" && !addedMissingHeader) {
      message += `\n❌ Missing Clients (${diff.missing.length})\n${sep}\n`;
      addedMissingHeader = true;
    }

    const block = clientBlock(item.client);
    const truncationLine = `... and ${allClients.length - fitCount} more. Check full report.\n\n${totalLine}`;

    if (message.length + block.length + truncationLine.length > LINE_SAFE_LIMIT) {
      remaining = allClients.length - fitCount;
      break;
    }

    message += block;
    fitCount++;
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

function totalsFromSnapshotRows(rows: SnapshotClient[]): HFMClientsPerformanceResponse["totals"] {
  return {
    clients: rows.length,
    accounts: rows.length,
    volume: 0,
    deposits: 0,
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
  let todayRows: SnapshotClient[];
  let totals: HFMClientsPerformanceResponse["totals"];

  if (existingTodayCount > 0) {
    if (hasDailyReportNotificationSent(db, today)) {
      console.warn(`[cron] daily-client-report snapshot and notification already exist for ${today}; skipping`);
      return;
    }
    todayRows = getByDate(db, today);
    totals = totalsFromSnapshotRows(todayRows);
  } else {
    const result = await fetchAll();
    if (!result.ok) throw new Error(`HFM fetchAllClients failed: ${result.reason}`);

    insertMany(db, today, result.data.clients);
    todayRows = getByDate(db, today);
    totals = result.data.totals;
  }

  const yesterdayRows = getByDate(db, yesterday);
  const message = buildDailyClientReportMessage({
    date: today,
    today: todayRows,
    yesterday: yesterdayRows,
    totals,
  });

  const uids = getActiveUids(db);
  if (uids.length === 0) {
    console.warn("[cron] daily-client-report has no active LINE recipients");
  } else {
    await pushAll(uids, message);
    markDailyReportNotificationSent(db, today);
  }

  purgeOlderThan(db, 90, today);
}
