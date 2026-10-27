import { dayjs, ICT_TIME_ZONE } from "../utils/dayjs";
import type { HFMClientRow } from "../types/hfm.types";

export const DORMANT_AFTER_DAYS = 21;
export const DAY_MS = 24 * 60 * 60 * 1000;

// LINE caps a text message at 5,000 characters. The margin covers the header.
const MAX_MESSAGE_CHARS = 4500;

export interface WalletActivityInput {
  walletId: number;
  name: string | null;
  lastTradeAt: string | null;
  firstFundedAt: string | null;
}

// HFM sends "YYYY-MM-DD HH:mm:ss" or ISO with no documented zone. Read both as
// UTC: against a 21 day threshold a few hours of zone error cannot matter.
// Values read back from Postgres timestamp columns use the same shape.
export function parseHfmTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed.toISOString() : null;
}

// /api/clients/ returns one row per trading account. A wallet is active if any
// of its accounts traded, and it counts as funded from its earliest funding.
// ISO strings from toISOString() compare correctly as plain strings.
export function aggregateWallets(rows: HFMClientRow[]): WalletActivityInput[] {
  const byWallet = new Map<number, WalletActivityInput>();
  for (const row of rows) {
    if (!row.wallet) continue;
    const lastTradeAt = parseHfmTimestamp(row.last_trade);
    const firstFundedAt = parseHfmTimestamp(row.first_funding);
    const name = row.name?.trim() || null;
    const current = byWallet.get(row.wallet);
    if (!current) {
      byWallet.set(row.wallet, { walletId: row.wallet, name, lastTradeAt, firstFundedAt });
      continue;
    }
    current.name ??= name;
    if (lastTradeAt && (!current.lastTradeAt || lastTradeAt > current.lastTradeAt)) {
      current.lastTradeAt = lastTradeAt;
    }
    if (firstFundedAt && (!current.firstFundedAt || firstFundedAt < current.firstFundedAt)) {
      current.firstFundedAt = firstFundedAt;
    }
  }
  return [...byWallet.values()];
}

function formatLine(wallet: WalletActivityInput, now: Date): string {
  const anchor = parseHfmTimestamp(wallet.lastTradeAt ?? wallet.firstFundedAt)!;
  const days = Math.floor((now.getTime() - Date.parse(anchor)) / DAY_MS);
  const date = dayjs.utc(anchor).tz(ICT_TIME_ZONE).format("DD/MM/YY");
  const label = wallet.name ? `WL-${wallet.walletId} ${wallet.name}` : `WL-${wallet.walletId}`;
  const detail = wallet.lastTradeAt
    ? `เทรดล่าสุด ${date}`
    : `เติมเงิน ${date} ยังไม่เคยเทรด`;
  return `• ${label} - ${detail} (${days} วัน)`;
}

// One header per message. A long list is split on line boundaries so no
// wallet line is ever cut in half.
export function buildDormantAlertMessages(
  wallets: WalletActivityInput[],
  now: Date,
): string[] {
  const header = `⏰ วอเล็ทที่ไม่มีการเทรดเกิน ${DORMANT_AFTER_DAYS} วัน (${wallets.length} วอเล็ท)`;
  const budget = MAX_MESSAGE_CHARS - header.length - 20;

  const chunks: string[][] = [[]];
  let size = 0;
  for (const line of wallets.map((w) => formatLine(w, now))) {
    if (size + line.length + 1 > budget && chunks.at(-1)!.length > 0) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)!.push(line);
    size += line.length + 1;
  }

  return chunks.map((lines, i) => {
    const part = chunks.length > 1 ? ` ส่วนที่ ${i + 1}/${chunks.length}` : "";
    return [`${header}${part}`, ...lines].join("\n");
  });
}
