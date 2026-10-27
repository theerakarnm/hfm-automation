import { and, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { walletActivity } from "../db/schema";
import type { WalletActivityInput } from "../services/wallet-dormancy.service";

// Keeps every INSERT well under the Postgres limit of 65,535 bind parameters.
const UPSERT_CHUNK = 1000;

// The moment a wallet's dormancy is measured from: its latest trade, or its
// first funding when it never traded.
const anchor = sql`COALESCE(${walletActivity.lastTradeAt}, ${walletActivity.firstFundedAt})`;

export async function syncWalletActivity(
  db: DrizzleDb,
  wallets: WalletActivityInput[],
  seenAt: string,
): Promise<void> {
  for (let i = 0; i < wallets.length; i += UPSERT_CHUNK) {
    const chunk = wallets.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(walletActivity)
      .values(chunk.map((w) => ({ ...w, seenAt })))
      .onConflictDoUpdate({
        target: walletActivity.walletId,
        set: {
          name: sql`COALESCE(excluded.name, "wallet_activity"."name")`,
          // GREATEST and LEAST ignore NULL, so an HFM row that briefly reports
          // no last_trade cannot move a wallet back to "never traded".
          lastTradeAt: sql`GREATEST("wallet_activity"."last_trade_at", excluded.last_trade_at)`,
          firstFundedAt: sql`LEAST("wallet_activity"."first_funded_at", excluded.first_funded_at)`,
          seenAt: sql`excluded.seen_at`,
        },
      });
  }
}

export interface FindDormantWalletsParams {
  // ISO UTC. Wallets whose anchor is strictly older than this are dormant.
  cutoff: string;
  // ISO UTC run time. Only wallets this run saw in HFM are checked.
  seenSince: string;
}

// Due = dormant and not alerted since the anchor. A new trade moves the anchor
// past alerted_at, which re-arms the alert with no separate reset step.
export async function findDormantWallets(
  db: DrizzleDb,
  params: FindDormantWalletsParams,
): Promise<WalletActivityInput[]> {
  return db
    .select({
      walletId: walletActivity.walletId,
      name: walletActivity.name,
      lastTradeAt: walletActivity.lastTradeAt,
      firstFundedAt: walletActivity.firstFundedAt,
    })
    .from(walletActivity)
    .where(
      and(
        gte(walletActivity.seenAt, params.seenSince),
        sql`${anchor} < ${params.cutoff}`,
        or(isNull(walletActivity.alertedAt), sql`${walletActivity.alertedAt} < ${anchor}`),
      ),
    )
    .orderBy(anchor);
}

export async function markWalletsAlerted(
  db: DrizzleDb,
  walletIds: number[],
  alertedAt: string,
): Promise<void> {
  if (walletIds.length === 0) return;
  await db
    .update(walletActivity)
    .set({ alertedAt })
    .where(inArray(walletActivity.walletId, walletIds));
}
