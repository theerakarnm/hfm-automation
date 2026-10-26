import { getDb, type DrizzleDb } from "../db/connection";
import { getJobState, setJobState } from "../db/state.repository";
import { resolveNotifyUids } from "../repositories/recipient.repository";
import {
  claimIdleAlerts,
  claimNewMatches,
  clearRecoveredIdleAlerts,
  releaseIdleAlerts,
  releaseMatches,
} from "../repositories/scan-state.repository";
import {
  fetchAllClients,
  fetchClients,
  getDepositThreshold,
  getIdleAlertDays,
  getMatchRule,
} from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import {
  idleWallets,
  joinScanAccounts,
  matchedAccounts,
  type ScanAccount,
} from "../services/scan-rules";
import { logError, logInfo } from "../utils/logger";
import { buildIdleMessage, buildMatchMessage } from "./scan-messages";

export const MATCH_BASELINE_KEY = "deposit_match:baselined";

// Both payloads are about 1.5 MB and /api/clients/ alone takes ~7s. A cron has
// no reply token to protect, so the budget is generous.
const FETCH_TIMEOUT_MS = 60_000;

export interface DailyScanOptions {
  db?: DrizzleDb;
  nowMs?: () => number;
  fetchAllClientsFn?: typeof fetchAllClients;
  fetchClientsFn?: typeof fetchClients;
  getUidsFn?: (db: DrizzleDb) => Promise<string[]>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
}

interface StepDeps {
  db: DrizzleDb;
  getUids: (db: DrizzleDb) => Promise<string[]>;
  pushAll: (uids: string[], text: string) => Promise<void>;
}

// Each scan has its own try: a failure in one must not skip the other.
async function guarded(step: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError(`daily-scan:${step}`, err);
  }
}

/**
 * Daily 00:30 Bangkok. Reads two switches from the tenant's vars:
 * MATCH_RULE=deposits turns on the new-match notification, IDLE_ALERT_DAYS > 0
 * turns on the idle wallet alert. With both off it returns before any HFM call.
 */
export async function runDailyScan(options: DailyScanOptions = {}): Promise<void> {
  const matchOn = getMatchRule() === "deposits";
  const idleDays = getIdleAlertDays();
  if (!matchOn && idleDays === 0) return;

  const db = options.db ?? getDb();
  const fetchPerformance = options.fetchAllClientsFn ?? fetchAllClients;
  const fetchClientRows = options.fetchClientsFn ?? fetchClients;
  const deps: StepDeps = {
    db,
    getUids: options.getUidsFn ?? resolveNotifyUids,
    pushAll: options.pushToAllFn ?? pushToAll,
  };

  // Start both fetches before awaiting either so they run concurrently.
  // Written as two awaited promises, not Promise.all: tests/no-unbounded-fanout
  // bans that API in src/ because Workers allow only 6 outbound connections to
  // wait for response headers. Two fixed fetches are far below that budget.
  const performancePromise = fetchPerformance(FETCH_TIMEOUT_MS);
  const clientsPromise = fetchClientRows(FETCH_TIMEOUT_MS);
  const [performance, clients] = [await performancePromise, await clientsPromise];
  if (!performance.ok || !clients.ok) {
    logError(
      "daily-scan",
      `HFM fetch failed (performance=${performance.ok ? "ok" : performance.reason}, clients=${clients.ok ? "ok" : clients.reason})`,
    );
    return;
  }

  const target = Number(process.env.TARGET_WALLET);
  const accounts = joinScanAccounts(performance.data.clients, clients.data);

  if (matchOn) {
    await guarded("deposit-match", () => runDepositMatch(deps, accounts, target));
  }
  if (idleDays > 0) {
    const nowMs = (options.nowMs ?? Date.now)();
    await guarded("idle-wallets", () =>
      runIdleWallets(deps, accounts, target, nowMs, idleDays),
    );
  }
}

async function runDepositMatch(
  { db, getUids, pushAll }: StepDeps,
  accounts: ScanAccount[],
  target: number,
): Promise<void> {
  const matched = matchedAccounts(accounts, target);
  const ids = matched.map((a) => a.accountId);

  // First run on this database: record who already qualifies, tell nobody.
  if ((await getJobState(db, MATCH_BASELINE_KEY)) === null) {
    await claimNewMatches(db, ids);
    await setJobState(db, MATCH_BASELINE_KEY, "1");
    logInfo("daily-scan", { baselined: ids.length }, "deposit match baseline recorded");
    return;
  }

  const claimed = await claimNewMatches(db, ids);
  if (claimed.length === 0) return;

  const uids = await getUids(db);
  if (uids.length === 0) {
    logInfo("daily-scan", { matches: claimed.length }, "no active recipients, match not announced");
    return;
  }

  const claimedSet = new Set(claimed);
  const fresh = matched.filter((a) => claimedSet.has(a.accountId));
  try {
    await pushAll(uids, buildMatchMessage(fresh, getDepositThreshold("USD")));
  } catch (err) {
    // Give the claim back so tomorrow's run announces these accounts.
    await releaseMatches(db, claimed);
    throw err;
  }
  logInfo("daily-scan", { matches: claimed.length }, "deposit match announced");
}

async function runIdleWallets(
  { db, getUids, pushAll }: StepDeps,
  accounts: ScanAccount[],
  target: number,
  nowMs: number,
  days: number,
): Promise<void> {
  const idle = idleWallets(accounts, target, nowMs, days);
  const ids = idle.map((w) => w.walletId);

  // Wallets that traded again lose their open alert, so a later idle spell
  // alerts again.
  await clearRecoveredIdleAlerts(db, ids);
  const claimed = await claimIdleAlerts(db, ids);
  if (claimed.length === 0) return;

  const uids = await getUids(db);
  if (uids.length === 0) {
    logInfo("daily-scan", { idle: claimed.length }, "no active recipients, idle wallets not announced");
    return;
  }

  const claimedSet = new Set(claimed);
  const fresh = idle.filter((w) => claimedSet.has(w.walletId));
  try {
    await pushAll(uids, buildIdleMessage(fresh, days));
  } catch (err) {
    await releaseIdleAlerts(db, claimed);
    throw err;
  }
  logInfo("daily-scan", { idle: claimed.length }, "idle wallets announced");
}
