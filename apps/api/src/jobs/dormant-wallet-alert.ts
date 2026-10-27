import { getDb, type DrizzleDb } from "../db/connection";
import { getActiveUids, seedFromEnv } from "../repositories/recipient.repository";
import {
  findDormantWallets,
  markWalletsAlerted,
  syncWalletActivity,
} from "../repositories/wallet-activity.repository";
import { fetchClients } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import {
  aggregateWallets,
  buildDormantAlertMessages,
  DAY_MS,
  DORMANT_AFTER_DAYS,
} from "../services/wallet-dormancy.service";
import type { HFMClientsResult } from "../types/hfm.types";
import { logError, logInfo, logWarn } from "../utils/logger";

// A daily cron gets a 15 minute wall budget, so this can wait far longer than
// the reply path. /api/clients/ takes ~7s when healthy.
const FETCH_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

export interface RunDormantWalletAlertOptions {
  db?: DrizzleDb;
  now?: () => Date;
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  getUidsFn?: (db: DrizzleDb) => Promise<string[]>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  markAlertedFn?: (db: DrizzleDb, walletIds: number[], alertedAt: string) => Promise<void>;
}

async function resolveUids(db: DrizzleDb): Promise<string[]> {
  await seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");
  return getActiveUids(db);
}

export async function runDormantWalletAlert(
  options: RunDormantWalletAlertOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const runAt = (options.now ?? (() => new Date()))();
  const fetchClientsFn = options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));
  const getUids = options.getUidsFn ?? resolveUids;
  const pushAll = options.pushToAllFn ?? pushToAll;
  const markAlerted = options.markAlertedFn ?? markWalletsAlerted;

  let result: HFMClientsResult = { ok: false, reason: "server_error" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await fetchClientsFn();
    if (result.ok) break;
    logError(
      "dormant-wallet",
      `fetchClients attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
    );
  }
  // Throwing lets runStep log the failure. The wallets stay due, so
  // tomorrow's run picks them up.
  if (!result.ok) throw new Error(`HFM fetchClients failed: ${result.reason}`);

  const runIso = runAt.toISOString();
  const wallets = aggregateWallets(result.data);
  await syncWalletActivity(db, wallets, runIso);

  const cutoff = new Date(runAt.getTime() - DORMANT_AFTER_DAYS * DAY_MS).toISOString();
  const due = await findDormantWallets(db, { cutoff, seenSince: runIso });
  logInfo("dormant-wallet", { synced: wallets.length, due: due.length }, "dormant wallets checked");
  if (due.length === 0) return;

  const uids = await getUids(db);
  if (uids.length === 0) {
    // Not marked on purpose: the alert goes out once a recipient exists.
    logWarn("dormant-wallet", { due: due.length }, "no active recipients, alert not sent");
    return;
  }

  for (const text of buildDormantAlertMessages(due, runAt)) {
    await pushAll(uids, text);
  }
  // Marked only after every push succeeded. A failure part-way re-sends the
  // whole list tomorrow, which beats silently losing the unsent part.
  await markAlerted(db, due.map((w) => w.walletId), runIso);
}
