import { depositsExceedThreshold, extractWalletNumber } from "./hfm.service";
import type { HFMClientRow, HFMPerformanceData } from "../types/hfm.types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One HFM account with the fields both daily scans need. */
export interface ScanAccount {
  accountId: number;
  /** The client wallet (HFM `client_id` / `wallet`). */
  walletId: number;
  /** The partner the account sits under, compared with TARGET_WALLET. */
  partnerId: number | null;
  currency: string;
  deposits: number;
  lastTrade: string | null;
  firstFunding: string | null;
}

export interface IdleWallet {
  walletId: number;
  lastActivityAt: string;
  basis: "last_trade" | "first_funding";
  idleDays: number;
}

// HFM sends "YYYY-MM-DD HH:mm:ss" without a zone. Read as UTC: a few hours of
// error does not matter against a 21 day limit.
export function parseHfmTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.trim().replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Joins the two HFM payloads on the account id. The performance endpoint is
 * the source of partner, currency and deposits, so the daily scan and the
 * lookup card judge the same numbers. /api/clients/ adds the trade dates the
 * performance endpoint does not carry.
 */
export function joinScanAccounts(
  performance: HFMPerformanceData[],
  clients: HFMClientRow[],
): ScanAccount[] {
  const byId = new Map(clients.map((c) => [c.id, c]));
  return performance
    .filter((p) => !p.archived)
    .map((p) => {
      const row = byId.get(p.account_id);
      return {
        accountId: p.account_id,
        walletId: p.client_id,
        partnerId: extractWalletNumber(String(p.subaffiliate)),
        currency: p.account_currency,
        deposits: Number(p.deposits ?? 0) || 0,
        lastTrade: row?.last_trade ?? null,
        firstFunding: row?.first_funding ?? null,
      };
    });
}

export function matchedAccounts(
  accounts: ScanAccount[],
  targetPartner: number,
): ScanAccount[] {
  return accounts.filter(
    (a) =>
      a.partnerId === targetPartner &&
      depositsExceedThreshold(a.deposits, a.currency),
  );
}

function latest(values: (string | null)[]): { ms: number; text: string } | null {
  let best: { ms: number; text: string } | null = null;
  for (const text of values) {
    const ms = parseHfmTime(text);
    if (ms !== null && text !== null && (best === null || ms > best.ms)) {
      best = { ms, text };
    }
  }
  return best;
}

/**
 * Wallets under the target partner whose last activity is more than `days`
 * days old. Activity is the latest last_trade over the wallet's accounts.
 * A wallet that never traded counts from its first funding. A wallet with
 * neither is skipped. Longest idle first.
 */
export function idleWallets(
  accounts: ScanAccount[],
  targetPartner: number,
  nowMs: number,
  days: number,
): IdleWallet[] {
  const wallets = new Map<number, ScanAccount[]>();
  for (const a of accounts) {
    if (a.partnerId !== targetPartner) continue;
    const list = wallets.get(a.walletId);
    if (list) list.push(a);
    else wallets.set(a.walletId, [a]);
  }

  const out: IdleWallet[] = [];
  for (const [walletId, list] of wallets) {
    const trade = latest(list.map((a) => a.lastTrade));
    const found = trade ?? latest(list.map((a) => a.firstFunding));
    if (!found) continue;
    const idleMs = nowMs - found.ms;
    if (idleMs <= days * DAY_MS) continue;
    out.push({
      walletId,
      lastActivityAt: found.text,
      basis: trade ? "last_trade" : "first_funding",
      idleDays: Math.floor(idleMs / DAY_MS),
    });
  }
  return out.sort((a, b) => b.idleDays - a.idleDays);
}
