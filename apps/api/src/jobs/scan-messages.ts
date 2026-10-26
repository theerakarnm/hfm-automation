import type { IdleWallet, ScanAccount } from "../services/scan-rules";

// One LINE text is limited to 5,000 characters. 30 lines of about 60
// characters stay far below that, and the footer says what was cut.
const MAX_LINES = 30;

// USC deposits arrive in cents.
function formatDeposits(deposits: number, currency: string): string {
  const value = currency === "USC" ? deposits / 100 : deposits;
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function buildMatchMessage(
  accounts: ScanAccount[],
  thresholdUsd: number,
): string {
  const lines = accounts
    .slice(0, MAX_LINES)
    .map(
      (a) =>
        `• T${a.accountId} (wallet ${a.walletId}) ฝากสะสม ${formatDeposits(a.deposits, a.currency)}`,
    );
  const more = accounts.length - lines.length;
  return [
    `✅ Match ใหม่ ${accounts.length} บัญชี (ยอดฝากสะสมเกิน ${thresholdUsd} USD)`,
    ...lines,
    ...(more > 0 ? [`และอีก ${more} บัญชี`] : []),
  ].join("\n");
}

export function buildIdleMessage(wallets: IdleWallet[], days: number): string {
  const lines = wallets.slice(0, MAX_LINES).map((w) => {
    const date = w.lastActivityAt.slice(0, 10);
    return w.basis === "last_trade"
      ? `• ${w.walletId} - เทรดล่าสุด ${date} (${w.idleDays} วัน)`
      : `• ${w.walletId} - เติมเงินครั้งแรก ${date} ยังไม่เคยเทรด (${w.idleDays} วัน)`;
  });
  const more = wallets.length - lines.length;
  return [
    `⚠️ ${wallets.length} wallet ไม่เทรดเกิน ${days} วัน`,
    ...lines,
    ...(more > 0 ? [`และอีก ${more} wallet`] : []),
  ].join("\n");
}
