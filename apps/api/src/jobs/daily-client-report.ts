import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { getDb } from "../db/connection";
import { clientSnapshots } from "../db/schema";
import type { TenantConfig } from "../types/tenant.types";
import type { HFMClientRow, HFMClientsResult } from "../types/hfm.types";
import { countByDate, insertMany, purgeOlderThan, getLatestSnapshotDateBefore } from "../repositories/snapshot.repository";
import {
  insertRequestSnapshot,
  getLatestRequestSnapshotBefore,
  type RequestSnapshotRow,
} from "../repositories/request-snapshot.repository";
import { getActiveUids } from "../repositories/recipient.repository";
import { markDailyReportSent, isDailyReportSent } from "../repositories/daily-notification.repository";
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

// Everything in this job is scoped by ctx: the snapshots it reads and
// writes, the "already notified" guard, and the recipient list all belong
// to one tenant, so two tenants on the same date never see each other's
// numbers or suppress each other's notifications.

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

async function getWalletIdsFromNightlySnapshot(
  db: DrizzleDb,
  tenantId: number,
  date: string,
): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ clientId: clientSnapshots.clientId })
    .from(clientSnapshots)
    .where(
      and(
        eq(clientSnapshots.tenantId, tenantId),
        eq(clientSnapshots.snapshotDate, date),
      ),
    );
  return new Set(rows.map((r) => r.clientId));
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
  db?: DrizzleDb;
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  reportPeriod?: ReportPeriod;
}

async function ensureTodaySnapshot(
  db: DrizzleDb,
  tenantId: number,
  today: string,
  fetchCurrent: () => Promise<HFMClientsResult>,
  maxRetries = 3,
): Promise<boolean> {
  const existingTodayCount = await countByDate(db, tenantId, today);
  if (existingTodayCount > 0) return true;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await fetchCurrent();
    let reason: string;
    if (result.ok) {
      const normalized = dedupeByCompositeKey(result.data).map(normalizeClientRow);
      // Never mark the day as done on an empty fetch - return false so the
      // notification stays unmarked and a later run can retry this date.
      if (normalized.length > 0) {
        await insertMany(
          db,
          tenantId,
          normalized.map((row) => ({
            snapshotDate: today,
            clientId: row.client_id,
            name: row.full_name ?? null,
            email: row.email ?? null,
          })),
        );
        return true;
      }
      reason = "empty client list";
    } else {
      reason = result.reason;
    }
    if (attempt < maxRetries) {
      const delayMs = attempt * 5_000;
      console.warn(
        `[cron] ensureTodaySnapshot attempt ${attempt}/${maxRetries} failed (${reason}), retrying in ${delayMs / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } else {
      console.error(
        `[cron] ensureTodaySnapshot failed after ${maxRetries} attempts: ${reason}`,
      );
    }
  }
  return false;
}

async function buildReportMessages(
  ctx: TenantConfig,
  db: DrizzleDb,
  now: Date,
  today: string,
  fetchCurrent: () => Promise<HFMClientsResult>,
  period: ReportPeriod,
): Promise<string[]> {
  const targetLabel = String(ctx.targetWallet);

  const result = await fetchCurrent();

  if (!result.ok) throw new Error(`HFM fetchClients failed: ${result.reason}`);
  const currentRows = dedupeByCompositeKey(result.data);
  const currentWalletIds = extractWalletIds(currentRows);
  const currCount = currentWalletIds.size;

  const messages: string[] = [];

  if (period === "day") {
    const yesterday = getPreviousIctDateString(now);
    const yesterdayExists = (await countByDate(db, ctx.id, yesterday)) > 0;

    if (!yesterdayExists) {
      await insertRequestSnapshot(db, ctx.id, today, currentRows);
      return [`The report of yesterday (${formatShortDate(yesterday)}) was not found.`];
    }

    const yesterdayWalletIds = await getWalletIdsFromNightlySnapshot(db, ctx.id, yesterday);
    if (yesterdayWalletIds.size === 0) {
      await insertRequestSnapshot(db, ctx.id, today, currentRows);
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

    const prevRequest = await getLatestRequestSnapshotBefore(db, ctx.id, today);
    if (prevRequest) {
      const prevMissing = findMissingFromRequestSnapshots(prevRequest.rows, currentWalletIds);
      const prevNew = findNewFromRequestSnapshots(prevRequest.rows, currentWalletIds);
      messages.push(
        buildComparisonReportMessage({
          title: "Since Last Request",
          prevLabel: "Last request",
          prevDate: prevRequest.snapshotDate,
          prevCount: countDistinctInSnapshots(prevRequest.rows),
          currLabel: "Current",
          currCount,
          targetWalletLabel: targetLabel,
          missingIds: prevMissing,
          newIds: prevNew,
        }),
      );
    }

    await insertRequestSnapshot(db, ctx.id, today, currentRows);
    return messages;
  }

  if (period === "week") {
    const lastWeek = getLastWeekRange(now);
    const lastWeekSunday = lastWeek.to;
    const lastWeekExists = (await countByDate(db, ctx.id, lastWeekSunday)) > 0;

    if (!lastWeekExists) {
      await insertRequestSnapshot(db, ctx.id, today, currentRows);
      return [`The report of last week (${formatShortDate(lastWeekSunday)}) was not found.`];
    }

    const lastWeekWalletIds = await getWalletIdsFromNightlySnapshot(db, ctx.id, lastWeekSunday);
    if (lastWeekWalletIds.size === 0) {
      await insertRequestSnapshot(db, ctx.id, today, currentRows);
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

    const prevRequest = await getLatestRequestSnapshotBefore(db, ctx.id, today);
    if (prevRequest) {
      const prevMissing = findMissingFromRequestSnapshots(prevRequest.rows, currentWalletIds);
      const prevNew = findNewFromRequestSnapshots(prevRequest.rows, currentWalletIds);
      messages.push(
        buildComparisonReportMessage({
          title: "Since Last Request",
          prevLabel: "Last request",
          prevDate: prevRequest.snapshotDate,
          prevCount: countDistinctInSnapshots(prevRequest.rows),
          currLabel: "Current",
          currCount,
          targetWalletLabel: targetLabel,
          missingIds: prevMissing,
          newIds: prevNew,
        }),
      );
    }

    await insertRequestSnapshot(db, ctx.id, today, currentRows);
    return messages;
  }

  if (period === "month") {
    const lastMonth = getLastMonthRange(now);
    const lastMonthEnd = lastMonth.to;
    const lastMonthExists = (await countByDate(db, ctx.id, lastMonthEnd)) > 0;

    if (!lastMonthExists) {
      await insertRequestSnapshot(db, ctx.id, today, currentRows);
      return [`The report of last month (${formatShortDate(lastMonthEnd)}) was not found.`];
    }

    const lastMonthWalletIds = await getWalletIdsFromNightlySnapshot(db, ctx.id, lastMonthEnd);
    if (lastMonthWalletIds.size === 0) {
      await insertRequestSnapshot(db, ctx.id, today, currentRows);
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

    const prevRequest = await getLatestRequestSnapshotBefore(db, ctx.id, today);
    if (prevRequest) {
      const prevMissing = findMissingFromRequestSnapshots(prevRequest.rows, currentWalletIds);
      const prevNew = findNewFromRequestSnapshots(prevRequest.rows, currentWalletIds);
      messages.push(
        buildComparisonReportMessage({
          title: "Since Last Request",
          prevLabel: "Last request",
          prevDate: prevRequest.snapshotDate,
          prevCount: countDistinctInSnapshots(prevRequest.rows),
          currLabel: "Current",
          currCount,
          targetWalletLabel: targetLabel,
          missingIds: prevMissing,
          newIds: prevNew,
        }),
      );
    }

    await insertRequestSnapshot(db, ctx.id, today, currentRows);
    return messages;
  }

  throw new Error(`Unknown report period: ${period}`);
}

export async function generateReportForUser(
  ctx: TenantConfig,
  options: RunDailyClientReportOptions = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const fetchCurrent = options.fetchClientsFn ?? (() => fetchClients(ctx));
  const period = options.reportPeriod ?? "day";

  const today = getIctDateString(now);
  return await buildReportMessages(ctx, db, now, today, fetchCurrent, period);
}

export async function runDailyClientReport(
  ctx: TenantConfig,
  options: RunDailyClientReportOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const fetchCurrent = options.fetchClientsFn ?? (() => fetchClients(ctx));
  const pushAll = options.pushToAllFn ?? ((uids: string[], text: string) => pushToAll(ctx, uids, text));

  const today = getIctDateString(now);

  const snapshotOk = await ensureTodaySnapshot(db, ctx.id, today, fetchCurrent);

  if (await isDailyReportSent(db, ctx.id, today)) {
    console.warn(`[cron] daily-client-report notification already sent for tenant ${ctx.id} on ${today}; skipping`);
    return;
  }

  const yesterday = getPreviousIctDateString(now);
  let baselineDate = yesterday;
  let baselineLabel = "Yesterday";

  const yesterdayExists = (await countByDate(db, ctx.id, yesterday)) > 0;
  if (!yesterdayExists) {
    const fallbackDate = await getLatestSnapshotDateBefore(db, ctx.id, today);
    if (fallbackDate) {
      baselineDate = fallbackDate;
      baselineLabel = `Baseline (${formatShortDate(fallbackDate)})`;
      console.warn(
        `[cron] daily-client-report: no yesterday snapshot for ${yesterday}, using fallback ${fallbackDate}`,
      );
    } else {
      console.warn(
        `[cron] daily-client-report: no baseline snapshot found before ${today}, skipping notification`,
      );
      await purgeOlderThan(db, ctx.id, 90, today);
      return;
    }
  }

  // Recipients live in notify_recipients per tenant; there is no env seed.
  const uids = await getActiveUids(db, ctx.id);
  if (uids.length === 0) {
    console.warn("[cron] daily-client-report has no active LINE recipients");
  } else if (snapshotOk) {
    const targetLabel = String(ctx.targetWallet);
    const todayWalletIds = await getWalletIdsFromNightlySnapshot(db, ctx.id, today);
    const baselineWalletIds = await getWalletIdsFromNightlySnapshot(db, ctx.id, baselineDate);
    const todayCount = todayWalletIds.size;
    const baselineCount = baselineWalletIds.size;
    const missing = findMissingFromSets(baselineWalletIds, todayWalletIds);
    const newW = findNewFromSets(baselineWalletIds, todayWalletIds);
    const message = buildDayReportMessage({
      baselineLabel,
      baselineDate,
      baselineCount,
      currentCount: todayCount,
      targetWalletLabel: targetLabel,
      missingIds: missing,
      newIds: newW,
    });
    await pushAll(uids, message);
    await markDailyReportSent(db, ctx.id, today);
  } else {
    console.warn(`[cron] daily-client-report: today snapshot failed, skipping notification`);
  }

  await purgeOlderThan(db, ctx.id, 90, today);
}
