import { inArray, notInArray } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { accountMatchState, walletIdleAlerts } from "../db/schema";

// INSERT ... ON CONFLICT DO NOTHING RETURNING is atomic in PostgreSQL, so the
// ids it returns were claimed by this call and by no other. Hyperdrive runs
// with caching disabled, so a cached read cannot hide a row.

export async function claimNewMatches(
  db: DrizzleDb,
  accountIds: number[],
): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .insert(accountMatchState)
    .values(accountIds.map((accountId) => ({ accountId })))
    .onConflictDoNothing()
    .returning({ accountId: accountMatchState.accountId });
  return rows.map((r) => r.accountId);
}

export async function releaseMatches(
  db: DrizzleDb,
  accountIds: number[],
): Promise<void> {
  if (accountIds.length === 0) return;
  await db
    .delete(accountMatchState)
    .where(inArray(accountMatchState.accountId, accountIds));
}

export async function claimIdleAlerts(
  db: DrizzleDb,
  walletIds: number[],
): Promise<number[]> {
  if (walletIds.length === 0) return [];
  const rows = await db
    .insert(walletIdleAlerts)
    .values(walletIds.map((walletId) => ({ walletId })))
    .onConflictDoNothing()
    .returning({ walletId: walletIdleAlerts.walletId });
  return rows.map((r) => r.walletId);
}

export async function releaseIdleAlerts(
  db: DrizzleDb,
  walletIds: number[],
): Promise<void> {
  if (walletIds.length === 0) return;
  await db
    .delete(walletIdleAlerts)
    .where(inArray(walletIdleAlerts.walletId, walletIds));
}

/** Deletes the open alerts of wallets that are no longer idle. Returns how many. */
export async function clearRecoveredIdleAlerts(
  db: DrizzleDb,
  stillIdleWalletIds: number[],
): Promise<number> {
  const rows =
    stillIdleWalletIds.length === 0
      ? await db
          .delete(walletIdleAlerts)
          .returning({ walletId: walletIdleAlerts.walletId })
      : await db
          .delete(walletIdleAlerts)
          .where(notInArray(walletIdleAlerts.walletId, stillIdleWalletIds))
          .returning({ walletId: walletIdleAlerts.walletId });
  return rows.length;
}
