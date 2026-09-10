import { and, eq, sql } from "drizzle-orm";
import { normalizeClientRow } from "../src/services/hfm.service";
import { getDb, initDb, closeDb } from "../src/db/connection";
import { countByDate, insertMany } from "../src/repositories/snapshot.repository";
import { dailyReportNotifications, clientSnapshots } from "../src/db/schema";
import { resolveTenants, parseArgs } from "./lib/resolve-tenant";
import { loadEncryptionKey } from "../src/utils/crypto";
import type { HFMClientRow } from "../src/types/hfm.types";

const SOURCE_FILE = process.env.SOURCE_FILE ?? "output/client_2026-04-30.json";
const FROM_DATE = process.env.FROM_DATE ?? "2026-04-01";
const TO_DATE = process.env.TO_DATE ?? "2026-04-30";
const DRY_RUN = process.env.DRY_RUN === "1";
const MOCK_REPLACE = process.env.MOCK_REPLACE === "1";
const REMOVE_PER_DAY = Number(process.env.REMOVE_PER_DAY ?? 3);
const ADD_PER_DAY = Number(process.env.ADD_PER_DAY ?? 2);

const MOCK_WALLET_ID_BASE = 99_000_000;
const MOCK_ACCOUNT_ID_BASE = 199_000_000;

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function pickWalletsToRemove(
  allRows: HFMClientRow[],
  alreadyRemoved: Set<number>,
  count: number
): number[] {
  const available: number[] = [];
  for (const row of allRows) {
    if (!alreadyRemoved.has(row.wallet)) {
      available.push(row.wallet);
    }
  }
  const shuffled = available.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function createMockClientRows(
  dayIndex: number,
  count: number
): HFMClientRow[] {
  const rows: HFMClientRow[] = [];
  for (let i = 0; i < count; i++) {
    const walletId = MOCK_WALLET_ID_BASE + dayIndex * 100 + i;
    const accountId = MOCK_ACCOUNT_ID_BASE + dayIndex * 100 + i;
    rows.push({
      id: accountId,
      wallet: walletId,
      type: "Standard",
      last_trade: null,
      volume: "0",
      balance: 0,
      commission: 0,
      account_currency: "USD",
      country: "Thailand",
      rebates_paid: 0,
      rebates_unpaid: 0,
      rebates_rejected: 0,
      first_trade: null,
      first_funding: null,
      registration: "2026-04-01T00:00:00Z",
      server: 5,
      platform: "MT4",
      conversion_device: "Desktop Browser",
      deposits: 0,
      withdrawals: 0,
      name: `Mock Client ${walletId}`,
      email: `mock${walletId}@test.com`,
      equity: 0,
      margin: 0,
      free_margin: 0,
    });
  }
  return rows;
}

loadEncryptionKey(); // fail fast

async function main() {
  console.log(`[seed] source: ${SOURCE_FILE}`);
  console.log(`[seed] range : ${FROM_DATE} → ${TO_DATE}`);
  console.log(`[seed] dry_run: ${DRY_RUN}`);
  console.log(`[seed] replace: ${MOCK_REPLACE}`);

  const sourceData = await Bun.file(SOURCE_FILE).json();
  const sourceRows: HFMClientRow[] = sourceData.data;
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
    console.error("[seed] source file has no data array");
    process.exit(1);
  }
  console.log(`[seed] loaded ${sourceRows.length} rows from source`);

  const dates = dateRange(FROM_DATE, TO_DATE);
  if (dates.length === 0) {
    console.error("[seed] no dates in range");
    process.exit(1);
  }
  console.log(`[seed] will seed ${dates.length} snapshot dates`);

  const db = getDb();
  await initDb(db);

  const tenants = await resolveTenants(parseArgs(process.argv));
  if (tenants.length !== 1) {
    // Mock seeding is a repair/test operation; running it against every
    // tenant at once would fabricate snapshots for real customers.
    console.error(
      "seed-mock-client-snapshots expects exactly one tenant. Use --tenant=<id|webhookId|label> or TENANT=, not --all.",
    );
    process.exit(2);
  }
  const tenant = tenants[0]!;
  console.log(`[seed] tenant : ${tenant.id} ("${tenant.label}")`);

  if (MOCK_REPLACE) {
    console.log("[seed] MOCK_REPLACE=1 — deleting existing snapshots in range...");
    await db
      .delete(clientSnapshots)
      .where(
        and(
          eq(clientSnapshots.tenantId, tenant.id),
          sql`${clientSnapshots.snapshotDate} >= ${FROM_DATE} AND ${clientSnapshots.snapshotDate} <= ${TO_DATE}`
        )
      );
    await db
      .delete(dailyReportNotifications)
      .where(
        and(
          eq(dailyReportNotifications.tenantId, tenant.id),
          sql`${dailyReportNotifications.snapshotDate} >= ${FROM_DATE} AND ${dailyReportNotifications.snapshotDate} <= ${TO_DATE}`
        )
      );
  }

  for (const date of dates) {
    const existing = await countByDate(db, tenant.id, date);
    if (existing > 0) {
      console.log(`[seed] ${date}: already has ${existing} rows — skipping`);
      continue;
    }
  }

  const removedWallets = new Set<number>();
  const allMockRows: HFMClientRow[] = [];

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]!;
    const existing = await countByDate(db, tenant.id, date);
    if (existing > 0) continue;

    let dayRows = [...sourceRows];

    const walletsToRemove = pickWalletsToRemove(sourceRows, removedWallets, REMOVE_PER_DAY);
    for (const w of walletsToRemove) {
      removedWallets.add(w);
    }

    dayRows = dayRows.filter((r) => !removedWallets.has(r.wallet));

    const newMockRows = createMockClientRows(di, ADD_PER_DAY);
    allMockRows.push(...newMockRows);
    dayRows.push(...newMockRows);

    const snapshotRows = dayRows.map(normalizeClientRow).map((row) => ({
      snapshotDate: date,
      clientId: row.client_id,
      name: row.full_name ?? null,
      email: row.email ?? null,
    }));

    if (DRY_RUN) {
      const wallets = new Set(snapshotRows.map((r) => r.clientId));
      console.log(
        `[dry-run] ${date}: ${snapshotRows.length} rows, ${wallets.size} distinct wallets (removed ${walletsToRemove.length}, added ${newMockRows.length})`
      );
      continue;
    }

    await insertMany(db, tenant.id, snapshotRows);

    const inserted = await countByDate(db, tenant.id, date);
    const wallets = new Set(snapshotRows.map((r) => r.clientId));
    console.log(
      `[seed] ${date}: ${inserted} rows, ${wallets.size} distinct wallets (removed ${walletsToRemove.length}, added ${newMockRows.length})`
    );
  }

  console.log("\n[seed] summary");
  for (const date of dates) {
    const count = await countByDate(db, tenant.id, date);
    console.log(`  ${date}: ${count} rows`);
  }

  if (!DRY_RUN) {
    await closeDb();
  }

  console.log(`[seed] done`);
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
