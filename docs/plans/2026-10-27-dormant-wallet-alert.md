# Dormant Wallet Alert Implementation Plan

> **For agentic workers:** Use `/skill:execute-plan` (subagent-driven by default) to implement this plan task by task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a day, push one LINE alert to the notify recipients that lists every wallet with no trade for more than 21 days, and alert each wallet only once per dormant spell.

**Architecture:** A new daily cron job (`dormant-wallet-alert`, 09:00 ICT) fetches HFM `/api/clients/` once, folds the account rows into one row per wallet, and upserts them into a new `wallet_activity` table that keeps `last_trade_at`, `first_funded_at` and `alerted_at`.
The activity anchor is `COALESCE(last_trade_at, first_funded_at)`, so a funded wallet that never traded is measured from its funding date.
A wallet is due when its anchor is older than 21 days and it was not alerted since that anchor (`alerted_at IS NULL OR alerted_at < anchor`), so a new trade re-arms the alert without any reset step.

**Tech Stack:** Bun, TypeScript, Drizzle ORM + PostgreSQL 16, Cloudflare Workers cron triggers, LINE Messaging API push, dayjs.

---

## Context the engineer needs

- The bot never sees a trade happen. HFM is the only source of truth: each row of `GET /api/clients/` is one trading account with `wallet`, `last_trade`, `first_funding` and `name` (`HFMClientRow` in `apps/api/src/types/hfm.types.ts`).
  "Update `last_trade_at` every time a trade happens" therefore means "copy HFM's latest `last_trade` into our table on every sync".
- The sync runs inside the daily job, right before the dormancy check.
  For a 21 day threshold, a daily sync gives the same answer as a 5 minute one, and it keeps the `*/5` cron (30s CPU cap) free of a few thousand upserts per tick.
- `last_trade_at` only moves forward (`GREATEST`) and `first_funded_at` only moves backward (`LEAST`).
  Postgres `GREATEST`/`LEAST` skip NULLs, so an HFM row that briefly reports `last_trade: null` cannot turn a wallet back into "never traded".
- Timestamps are stored in `timestamp` (without time zone) columns as UTC, written as app-generated ISO strings.
  Comparisons use a cutoff computed in JS, never `now()` in SQL, so the database session time zone cannot skew them (same rule as `purgeEventClaims` in `src/db/state.repository.ts`).
- Only wallets seen in today's HFM fetch are checked (`seen_at = run time`), so a wallet that disappeared from HFM (archived, moved partner) is never alerted from stale data.
- Cron triggers are UTC only. `0 2 * * *` UTC is 09:00 ICT.
  Each tenant is its own Worker with its own database. Only `simple-trade` gets the alert, so the new cron string goes into `wrangler.simple-trade.jsonc` only, and the tenant drift test stops requiring identical crons.
  The `maow` Worker ships the same code but never fires the job, because it has no `0 2 * * *` trigger. Its database gets the empty table the next time `migrate:maow` runs, which keeps both migration chains identical.
- Recipients are the existing operator list: `seedFromEnv(LINE_NOTIFY_UIDS)` + `getActiveUids()`, exactly like the HFM health check.
- `alerted_at` is written only after every push succeeded.
  A failed push leaves the wallets due, so tomorrow's run retries them.
  With no recipients, nothing is marked, so the alerts go out once a recipient exists.
- Work directly on the current branch `feat/simple-trade-condition-cron` (no new branch). It carries the Workers code this feature depends on.

## Assumptions to confirm before rollout

1. **First run backlog.** Every wallet that is already dormant today is "due" on the first run, which can be hundreds of lines (sent as several 4,500 character messages to every recipient).
   Default in this plan: send them all once.
   Task 7 runs a dry run first so the count is known before the cron is deployed.
   If the list is too long, the alternative is to mark the existing backlog as alerted without sending (one SQL `UPDATE`, see Task 7 Step 3).
2. **HFM time zone.** `last_trade` and `first_funding` arrive as `"YYYY-MM-DD HH:mm:ss"` or ISO strings without a documented zone; they are parsed as UTC. A few hours of error does not matter against 21 days.
3. **Which wallets count.** Every wallet with a trade or a funding date is checked, including wallets that withdrew everything. Wallets that never funded and never traded are ignored.
4. **Threshold.** "More than 3 weeks" is a constant `DORMANT_AFTER_DAYS = 21` (strictly older than 21 x 24h), not an env var.
5. **Only `simple-trade`** gets the job (confirmed by the user 2026-10-27). Staging stays off.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/api/src/db/schema.ts` | Modify | Add the `wallet_activity` table. |
| `apps/api/drizzle/0002_*.sql` + `drizzle/meta/*` | Generate | Migration, produced by `bun run db:generate`, never hand-edited. |
| `apps/api/tests/db-helpers.ts` | Modify | Test copy of the new table DDL + drop. |
| `apps/api/tests/migrations.test.ts` | Modify | Require `wallet_activity` in `drizzle/`. |
| `apps/api/src/services/wallet-dormancy.service.ts` | Create | Pure logic: parse HFM timestamps, fold accounts into wallets, build the alert text. |
| `apps/api/src/repositories/wallet-activity.repository.ts` | Create | All SQL: sync, find due wallets, mark alerted. |
| `apps/api/src/jobs/dormant-wallet-alert.ts` | Create | The job: fetch, sync, find, push, mark. |
| `apps/api/src/jobs/index.ts` | Modify | Register the daily cron and route by job name. |
| `apps/api/wrangler.simple-trade.jsonc` | Modify | Add `0 2 * * *` to `triggers.crons` (simple-trade only). |
| `apps/api/tests/worker.test.ts`, `apps/api/tests/tenant-config.test.ts` | Modify | Expect the new schedule. |
| `apps/api/scripts/trigger-dormant-wallet-alert.ts` + `package.json` | Create / Modify | Manual run with `DRY_RUN=1`. |

---

### Task 1: `wallet_activity` table and migration

**Files:**
- Modify: `apps/api/src/db/schema.ts` (append at the end)
- Modify: `apps/api/tests/db-helpers.ts`
- Modify: `apps/api/tests/migrations.test.ts`
- Generate: `apps/api/drizzle/0002_<random>.sql`, `apps/api/drizzle/meta/_journal.json`, `apps/api/drizzle/meta/0002_snapshot.json`

- [x] **Step 1: Make the migration test require the table (failing test)**

In `apps/api/tests/migrations.test.ts`, add `"wallet_activity"` to `REQUIRED_TABLES`:

```ts
const REQUIRED_TABLES = [
  "client_snapshots",
  "notify_recipients",
  "daily_report_notifications",
  "line_users",
  "line_groups",
  "report_range_snapshots",
  "client_request_snapshots",
  "client_request_snapshot_rows",
  "job_state",
  "wallet_activity",
];
```

- [x] **Step 2: Run it and see it fail**

Run (from `apps/api`): `bun test tests/migrations.test.ts`
Expected: FAIL in "every schema.ts table has a CREATE TABLE in drizzle/" (no match for `wallet_activity`).

- [x] **Step 3: Add the table to `schema.ts`**

Append to `apps/api/src/db/schema.ts`:

```ts
// One row per HFM wallet for the dormant-wallet alert. HFM stays the source of
// truth for trades; the daily job copies its latest last_trade in here so a
// row that briefly comes back null cannot reset a wallet to "never traded",
// and alerted_at lets the alert fire once per dormant spell, not every day.
// All timestamps are UTC written by the app; compare them with a cutoff built
// in JS, never with now(), so the session time zone cannot skew the result.
export const walletActivity = pgTable("wallet_activity", {
  walletId: integer("wallet_id").primaryKey(),
  name: text("name"),
  lastTradeAt: timestamp("last_trade_at", { mode: "string" }),
  firstFundedAt: timestamp("first_funded_at", { mode: "string" }),
  alertedAt: timestamp("alerted_at", { mode: "string" }),
  // Run time of the last sync that saw this wallet in HFM. Only wallets seen
  // by the current run are checked, so a wallet HFM dropped is never alerted.
  seenAt: timestamp("seen_at", { mode: "string" }).notNull(),
});
```

- [x] **Step 4: Generate the migration**

Run (from `apps/api`): `bun run db:generate`
Expected: a new `drizzle/0002_<random>.sql` containing `CREATE TABLE "wallet_activity"` with the six columns, plus an updated `drizzle/meta/_journal.json` and a new `drizzle/meta/0002_snapshot.json`.
Do not edit the SQL by hand.

- [x] **Step 5: Add the table to the test schema**

In `apps/api/tests/db-helpers.ts`, inside `applyTestSchema`, after the `job_state` block:

```sql
    CREATE TABLE IF NOT EXISTS wallet_activity (
      wallet_id       INTEGER PRIMARY KEY,
      name            TEXT,
      last_trade_at   TIMESTAMP,
      first_funded_at TIMESTAMP,
      alerted_at      TIMESTAMP,
      seen_at         TIMESTAMP NOT NULL
    );
```

And in `createTestDb`, add to the `DROP TABLE` list:

```sql
    DROP TABLE IF EXISTS wallet_activity CASCADE;
```

- [x] **Step 6: Run the tests**

Run: `bun test tests/migrations.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [x] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle tests/db-helpers.ts tests/migrations.test.ts
git commit -m "feat: add wallet_activity table"
```

---

### Task 2: Pure dormancy helpers

**Files:**
- Create: `apps/api/src/services/wallet-dormancy.service.ts`
- Test: `apps/api/tests/wallet-dormancy.test.ts`

- [x] **Step 1: Write the failing tests**

Create `apps/api/tests/wallet-dormancy.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  aggregateWallets,
  buildDormantAlertMessages,
  parseHfmTimestamp,
} from "../src/services/wallet-dormancy.service";
import type { HFMClientRow } from "../src/types/hfm.types";

function row(overrides: Partial<HFMClientRow>): HFMClientRow {
  return {
    id: 1,
    wallet: 1001,
    name: null,
    last_trade: null,
    first_funding: null,
    ...overrides,
  } as HFMClientRow;
}

describe("parseHfmTimestamp", () => {
  test("reads the space separated HFM format as UTC", () => {
    expect(parseHfmTimestamp("2026-04-25 10:00:00")).toBe("2026-04-25T10:00:00.000Z");
  });

  test("reads ISO strings", () => {
    expect(parseHfmTimestamp("2026-07-19T10:00:00Z")).toBe("2026-07-19T10:00:00.000Z");
  });

  test("returns null for null, empty and garbage", () => {
    expect(parseHfmTimestamp(null)).toBeNull();
    expect(parseHfmTimestamp("")).toBeNull();
    expect(parseHfmTimestamp("not a date")).toBeNull();
  });
});

describe("aggregateWallets", () => {
  test("keeps the latest trade and the earliest funding across a wallet's accounts", () => {
    const wallets = aggregateWallets([
      row({ id: 1, wallet: 1001, name: " Somchai ", last_trade: "2026-09-01 10:00:00", first_funding: "2026-01-10 08:00:00" }),
      row({ id: 2, wallet: 1001, last_trade: "2026-10-01 10:00:00", first_funding: "2026-02-10 08:00:00" }),
      row({ id: 3, wallet: 1001, last_trade: null, first_funding: null }),
    ]);
    expect(wallets).toEqual([
      {
        walletId: 1001,
        name: "Somchai",
        lastTradeAt: "2026-10-01T10:00:00.000Z",
        firstFundedAt: "2026-01-10T08:00:00.000Z",
      },
    ]);
  });

  test("a wallet with no trade on any account keeps lastTradeAt null", () => {
    const [w] = aggregateWallets([row({ wallet: 2002, first_funding: "2026-09-30 00:00:00" })]);
    expect(w?.lastTradeAt).toBeNull();
    expect(w?.firstFundedAt).toBe("2026-09-30T00:00:00.000Z");
  });

  test("skips rows without a wallet", () => {
    expect(aggregateWallets([row({ wallet: 0 })])).toEqual([]);
  });
});

describe("buildDormantAlertMessages", () => {
  const now = new Date("2026-10-27T02:00:00Z");

  test("lists traded and never-traded wallets with ICT dates and day counts", () => {
    const [text, ...rest] = buildDormantAlertMessages(
      [
        { walletId: 1001, name: "Somchai", lastTradeAt: "2026-10-01 03:00:00", firstFundedAt: "2026-01-10 08:00:00" },
        { walletId: 1003, name: null, lastTradeAt: null, firstFundedAt: "2026-09-30 00:00:00" },
      ],
      now,
    );
    expect(rest).toEqual([]);
    expect(text).toBe(
      [
        "⏰ วอเล็ทที่ไม่มีการเทรดเกิน 21 วัน (2 วอเล็ท)",
        "• WL-1001 Somchai - เทรดล่าสุด 01/10/26 (25 วัน)",
        "• WL-1003 - เติมเงิน 30/09/26 ยังไม่เคยเทรด (27 วัน)",
      ].join("\n"),
    );
  });

  test("splits a long list into numbered messages under the LINE text limit", () => {
    const wallets = Array.from({ length: 200 }, (_, i) => ({
      walletId: 10_000_000 + i,
      name: "ชื่อลูกค้าที่ยาวพอสมควรเพื่อทดสอบการแบ่งข้อความ",
      lastTradeAt: "2026-09-01 00:00:00",
      firstFundedAt: null,
    }));
    const texts = buildDormantAlertMessages(wallets, now);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4500);
    expect(texts[0]).toContain(`(200 วอเล็ท) ส่วนที่ 1/${texts.length}`);
    expect(texts.join("\n").match(/• WL-/g)?.length).toBe(200);
  });
});
```

- [x] **Step 2: Run them and see them fail**

Run: `bun test tests/wallet-dormancy.test.ts`
Expected: FAIL with "Cannot find module ../src/services/wallet-dormancy.service".

- [x] **Step 3: Implement**

Create `apps/api/src/services/wallet-dormancy.service.ts`:

```ts
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
```

- [x] **Step 4: Run the tests**

Run: `bun test tests/wallet-dormancy.test.ts`
Expected: PASS (all 8 tests).

- [x] **Step 5: Commit**

```bash
git add src/services/wallet-dormancy.service.ts tests/wallet-dormancy.test.ts
git commit -m "feat: add wallet dormancy helpers"
```

---

### Task 3: `wallet_activity` repository

**Files:**
- Create: `apps/api/src/repositories/wallet-activity.repository.ts`
- Test: `apps/api/tests/wallet-activity.repository.test.ts`

Needs the test database: `docker compose up -d postgres-test` from the repo root and `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test`.

- [x] **Step 1: Write the failing tests**

Create `apps/api/tests/wallet-activity.repository.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { closeTestDb, createTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import {
  findDormantWallets,
  markWalletsAlerted,
  syncWalletActivity,
} from "../src/repositories/wallet-activity.repository";

const RUN = "2026-10-27T02:00:00.000Z";
const CUTOFF = "2026-10-06T02:00:00.000Z"; // RUN - 21 days

describe("wallet-activity.repository", () => {
  let db: DrizzleDb;
  let client: postgres.Sql;

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db as unknown as DrizzleDb;
    client = created.client;
  });

  afterEach(async () => {
    await closeTestDb(client);
  });

  const ids = async (seenSince = RUN) =>
    (await findDormantWallets(db, { cutoff: CUTOFF, seenSince })).map((w) => w.walletId);

  test("finds wallets whose last trade or funding is older than the cutoff", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: "old trade", lastTradeAt: "2026-10-01T00:00:00.000Z", firstFundedAt: null },
      { walletId: 2, name: "recent trade", lastTradeAt: "2026-10-20T00:00:00.000Z", firstFundedAt: null },
      { walletId: 3, name: "funded, never traded", lastTradeAt: null, firstFundedAt: "2026-09-30T00:00:00.000Z" },
      { walletId: 4, name: "never funded", lastTradeAt: null, firstFundedAt: null },
      { walletId: 5, name: "old funding, recent trade", lastTradeAt: "2026-10-25T00:00:00.000Z", firstFundedAt: "2026-01-01T00:00:00.000Z" },
    ], RUN);

    expect(await ids()).toEqual([3, 1]); // oldest anchor first
  });

  test("last_trade_at never moves backwards and first_funded_at never moves forwards", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: "a", lastTradeAt: "2026-10-20T00:00:00.000Z", firstFundedAt: "2026-01-01T00:00:00.000Z" },
    ], RUN);
    await syncWalletActivity(db, [
      { walletId: 1, name: "b", lastTradeAt: null, firstFundedAt: "2026-05-01T00:00:00.000Z" },
    ], RUN);

    expect(await ids()).toEqual([]); // still active from the 10-20 trade
  });

  test("an alerted wallet is not due again until it trades and goes dormant again", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: null, lastTradeAt: "2026-10-01T00:00:00.000Z", firstFundedAt: null },
    ], RUN);
    await markWalletsAlerted(db, [1], RUN);
    expect(await ids()).toEqual([]);

    const later = "2026-11-20T02:00:00.000Z";
    await syncWalletActivity(db, [
      { walletId: 1, name: null, lastTradeAt: "2026-10-28T00:00:00.000Z", firstFundedAt: null },
    ], later);
    const due = await findDormantWallets(db, {
      cutoff: "2026-10-30T02:00:00.000Z", // later - 21 days
      seenSince: later,
    });
    expect(due.map((w) => w.walletId)).toEqual([1]);
  });

  test("a wallet missing from the current sync is not checked", async () => {
    await syncWalletActivity(db, [
      { walletId: 1, name: null, lastTradeAt: "2026-10-01T00:00:00.000Z", firstFundedAt: null },
    ], "2026-10-26T02:00:00.000Z");

    expect(await ids()).toEqual([]);
  });
});
```

- [x] **Step 2: Run them and see them fail**

Run: `bun test tests/wallet-activity.repository.test.ts`
Expected: FAIL with "Cannot find module ../src/repositories/wallet-activity.repository".

- [x] **Step 3: Implement**

Create `apps/api/src/repositories/wallet-activity.repository.ts`:

```ts
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
```

- [x] **Step 4: Run the tests**

Run: `bun test tests/wallet-activity.repository.test.ts && bun run typecheck`
Expected: PASS (4 tests), no type errors.

- [x] **Step 5: Commit**

```bash
git add src/repositories/wallet-activity.repository.ts tests/wallet-activity.repository.test.ts
git commit -m "feat: add wallet activity repository"
```

---

### Task 4: The `dormant-wallet-alert` job

**Files:**
- Create: `apps/api/src/jobs/dormant-wallet-alert.ts`
- Test: `apps/api/tests/dormant-wallet-alert.test.ts`

- [x] **Step 1: Write the failing tests**

Create `apps/api/tests/dormant-wallet-alert.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { closeTestDb, createTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import { runDormantWalletAlert } from "../src/jobs/dormant-wallet-alert";
import type { HFMClientRow } from "../src/types/hfm.types";

const row = (o: Partial<HFMClientRow>) =>
  ({ id: 1, wallet: 0, name: null, last_trade: null, first_funding: null, ...o }) as HFMClientRow;

const DAY0 = new Date("2026-10-27T02:00:00Z");

const ROWS = [
  row({ id: 11, wallet: 1001, name: "Old", last_trade: "2026-10-01 00:00:00" }),
  row({ id: 12, wallet: 1002, name: "Recent", last_trade: "2026-10-20 00:00:00" }),
  row({ id: 13, wallet: 1003, name: "FundedOnly", first_funding: "2026-09-30 00:00:00" }),
  row({ id: 14, wallet: 1004, name: "Nothing" }),
];

describe("runDormantWalletAlert", () => {
  let db: DrizzleDb;
  let client: postgres.Sql;
  let sent: string[];

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db as unknown as DrizzleDb;
    client = created.client;
    sent = [];
  });

  afterEach(async () => {
    await closeTestDb(client);
  });

  const run = (rows: HFMClientRow[], now: Date, extra: object = {}) =>
    runDormantWalletAlert({
      db,
      now: () => now,
      fetchClientsFn: async () => ({ ok: true, data: rows }),
      getUidsFn: async () => ["Utest"],
      pushToAllFn: async (_uids, text) => {
        sent.push(text);
      },
      ...extra,
    });

  test("alerts the dormant and the funded-never-traded wallets once", async () => {
    await run(ROWS, DAY0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("WL-1001 Old");
    expect(sent[0]).toContain("WL-1003 FundedOnly - เติมเงิน");
    expect(sent[0]).not.toContain("WL-1002");
    expect(sent[0]).not.toContain("WL-1004");

    await run(ROWS, new Date("2026-10-28T02:00:00Z"));
    expect(sent.length).toBe(1); // no repeat the next day
  });

  test("a wallet that trades again is alerted again after another 21 days", async () => {
    await run(ROWS, DAY0);
    const traded = ROWS.map((r) =>
      r.wallet === 1001 ? { ...r, last_trade: "2026-10-28 00:00:00" } : r,
    );
    await run(traded, new Date("2026-11-19T02:00:00Z"));
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain("WL-1001");
    expect(sent[1]).not.toContain("WL-1003"); // still in the same dormant spell
  });

  test("a failed push marks nothing, so the next run retries", async () => {
    await expect(
      run(ROWS, DAY0, {
        pushToAllFn: async () => {
          throw new Error("LINE down");
        },
      }),
    ).rejects.toThrow("LINE down");
    await run(ROWS, new Date("2026-10-28T02:00:00Z"));
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("WL-1001");
  });

  test("with no recipients nothing is marked", async () => {
    await run(ROWS, DAY0, { getUidsFn: async () => [] });
    expect(sent).toEqual([]);
    await run(ROWS, new Date("2026-10-28T02:00:00Z"));
    expect(sent.length).toBe(1);
  });

  test("throws when HFM fails every attempt, so the cron step logs it", async () => {
    await expect(
      run([], DAY0, { fetchClientsFn: async () => ({ ok: false, reason: "timeout" }) }),
    ).rejects.toThrow("timeout");
  });
});
```

- [x] **Step 2: Run them and see them fail**

Run: `bun test tests/dormant-wallet-alert.test.ts`
Expected: FAIL with "Cannot find module ../src/jobs/dormant-wallet-alert".

- [x] **Step 3: Implement**

Create `apps/api/src/jobs/dormant-wallet-alert.ts`:

```ts
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
```

- [x] **Step 4: Run the tests**

Run: `bun test tests/dormant-wallet-alert.test.ts && bun run typecheck`
Expected: PASS (5 tests), no type errors.

- [x] **Step 5: Commit**

```bash
git add src/jobs/dormant-wallet-alert.ts tests/dormant-wallet-alert.test.ts
git commit -m "feat: add dormant wallet alert job"
```

---

### Task 5: Schedule the job (09:00 ICT)

**Files:**
- Modify: `apps/api/src/jobs/index.ts`
- Modify: `apps/api/wrangler.simple-trade.jsonc`
- Modify: `apps/api/tests/worker.test.ts`, `apps/api/tests/tenant-config.test.ts`

- [x] **Step 1: Update the tests first**

In `apps/api/tests/worker.test.ts`, add a test and update the list assertion:

```ts
  test("maps 02:00 UTC (09:00 ICT) to the dormant wallet alert", () => {
    expect(cronJobName("0 2 * * *")).toBe("dormant-wallet-alert");
  });
```

```ts
    expect(Object.values(CRON_JOBS)).toEqual(["hfm-healthcheck", "dormant-wallet-alert"]);
```

In `apps/api/tests/tenant-config.test.ts`, crons are no longer a shared key, because only `simple-trade` runs the dormant wallet alert.
Replace the whole "shared keys have not drifted between tenant files" test with:

```ts
  test("shared keys have not drifted between tenant files", () => {
    const shared = configs.map((c) =>
      [c.cfg.main, c.cfg.compatibility_date].join("|"),
    );
    const first = shared[0]!;
    for (let i = 0; i < configs.length; i++) {
      expect(`${configs[i]!.file}: ${shared[i]}`).toBe(
        `${configs[i]!.file}: ${first}`,
      );
    }
    expect(first).toBe("./src/worker.ts|2026-09-22");
  });

  test("each tenant runs exactly its own cron jobs", () => {
    // The 5 minute job runs everywhere. The 09:00 ICT dormant wallet alert is
    // simple-trade only. The daily report cron was removed on purpose in
    // commit 96e6a0e and must not come back through a tenant config.
    const crons = Object.fromEntries(
      configs.map((c) => [c.file, c.cfg.triggers.crons.join(";")]),
    );
    expect(crons).toEqual({
      "wrangler.maow.jsonc": "*/5 * * * *",
      "wrangler.simple-trade.jsonc": "*/5 * * * *;0 2 * * *",
    });
  });
```

- [x] **Step 2: Run them and see them fail**

Run: `bun test tests/worker.test.ts tests/tenant-config.test.ts`
Expected: FAIL on the new mapping, the `CRON_JOBS` list, and the simple-trade crons.

- [x] **Step 3: Register and route the job**

In `apps/api/src/jobs/index.ts`, add the import and the schedule:

```ts
import { runDormantWalletAlert } from "./dormant-wallet-alert";
```

```ts
export const CRON_JOBS = {
  // Every 5 minutes. Interval independent of timezone.
  "*/5 * * * *": "hfm-healthcheck",
  // 02:00 UTC = 09:00 ICT, once a day at the start of the working day.
  "0 2 * * *": "dormant-wallet-alert",
} as const;
```

Replace the body of `dispatchCron` after the `if (!name)` guard so each schedule runs only its own work:

```ts
  if (name === "dormant-wallet-alert") {
    await runStep("dormant-wallet-alert", () => runDormantWalletAlert());
    return;
  }

  await runStep("hfm-healthcheck", () => runHfmHealthCheck());
  // (keep the existing last-trade-refresh comment and the two remaining steps unchanged)
  await runStep("last-trade-refresh", () => refreshLastTradeCache());
  await runStep("event-claim-purge", () =>
    purgeEventClaims(getDb(), EVENT_CLAIM_RETENTION_MS),
  );
```

At 02:00 UTC both crons fire as two separate invocations; the `*/5` one keeps doing its usual steps.

- [x] **Step 4: Add the trigger to the simple-trade tenant file**

In `apps/api/wrangler.simple-trade.jsonc` only:

```jsonc
  // UTC only. */5 = health check + last-trade refresh; 0 2 = 09:00 ICT
  // dormant wallet alert (this tenant only). The daily report cron was
  // removed on purpose (commit 96e6a0e); run it by hand with
  // `bun run trigger:daily-client-report`.
  "triggers": { "crons": ["*/5 * * * *", "0 2 * * *"] },
```

Leave `wrangler.maow.jsonc` and `staging/wrangler.maow-staging.jsonc` alone.

- [x] **Step 5: Run the tests**

Run: `bun test tests/worker.test.ts tests/tenant-config.test.ts && bun run typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/jobs/index.ts wrangler.simple-trade.jsonc tests/worker.test.ts tests/tenant-config.test.ts
git commit -m "feat: schedule dormant wallet alert at 09:00"
```

---

### Task 6: Manual trigger script with dry run

**Files:**
- Create: `apps/api/scripts/trigger-dormant-wallet-alert.ts`
- Modify: `apps/api/package.json` (`scripts`)

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/trigger-dormant-wallet-alert.ts`:

```ts
import { runDormantWalletAlert } from "../src/jobs/dormant-wallet-alert";
import { closeDb } from "../src/db/connection";

// DRY_RUN=1 prints the messages instead of pushing them and does not mark any
// wallet as alerted, so the real cron still sends them. The wallet_activity
// sync itself does run: it only copies HFM data.
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  console.log(`[trigger] dormant-wallet-alert starting (DRY_RUN=${DRY_RUN})`);
  try {
    await runDormantWalletAlert(
      DRY_RUN
        ? {
            pushToAllFn: async (uids, text) => {
              console.log(`[dry-run] would push to ${uids.length} recipient(s):`);
              console.log(`---\n${text}\n---`);
            },
            markAlertedFn: async (_db, walletIds) => {
              console.log(`[dry-run] would mark ${walletIds.length} wallet(s) as alerted`);
            },
          }
        : {},
    );
    console.log("[trigger] dormant-wallet-alert completed");
  } catch (e) {
    console.error("[trigger] dormant-wallet-alert failed:", e);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main();
```

- [ ] **Step 2: Register it**

In `apps/api/package.json` `scripts`, after `trigger:hfm-healthcheck`:

```json
    "trigger:dormant-wallet-alert": "bun run scripts/trigger-dormant-wallet-alert.ts",
```

- [ ] **Step 3: Smoke-test against the local test database**

Run (from `apps/api`, test DB up, real `HFM_API_KEY` in `.env`):
`DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test DRY_RUN=1 bun run trigger:dormant-wallet-alert`
Expected: either `[dry-run] would push ...` with the wallet list, or only `dormant wallets checked` with `due: 0`; then `[trigger] dormant-wallet-alert completed`.
Check the output by eye: Thai text renders, dates are `DD/MM/YY`, day counts look right against HFM.
(Run `bun test tests/wallet-activity.repository.test.ts` once first so the table exists in `hfm_test`.)

- [ ] **Step 4: Full check and commit**

Run: `bun test && bun run typecheck`
Expected: all green.

```bash
git add scripts/trigger-dormant-wallet-alert.ts package.json
git commit -m "feat: add dormant wallet alert trigger script"
```

---

### Task 7: Rollout (simple-trade, migration before deploy)

The cron must never run against a database without `wallet_activity`, so migrate first.
These steps touch the production database and Worker, so they run only after the user approves.

- [ ] **Step 1: Migrate the simple-trade database**

Run (from `apps/api`): `bun run migrate:simple-trade`
Expected: `[migrate] migrations applied to simple-trade`.

- [ ] **Step 2: Dry run to size the first-run backlog**

Run with the tenant's direct origin URL and HFM key (from `.env.simple-trade.admin`):
`DATABASE_URL=$DATABASE_URL_SIMPLE_TRADE DRY_RUN=1 bun --env-file=.env.simple-trade.admin run scripts/trigger-dormant-wallet-alert.ts`
Note the `due` count and the number of message parts.

- [ ] **Step 3: Decide on the backlog (only if the list is too long)**

If the operator does not want the first-run list, mark today's backlog as already alerted in the simple-trade database:

```sql
UPDATE wallet_activity
SET alerted_at = now() AT TIME ZONE 'UTC'
WHERE COALESCE(last_trade_at, first_funded_at) < (now() AT TIME ZONE 'UTC') - interval '21 days';
```

Wallets that go dormant after today are still alerted normally.

- [ ] **Step 4: Deploy**

Run: `bun run check:bundle:simple-trade`, then `bun run deploy:simple-trade`.
Expected: wrangler lists two schedules for `hfm-bot-simple-trade`: `*/5 * * * *` and `0 2 * * *`.

- [ ] **Step 5: Verify the first real run**

At 09:00 ICT the next day, run `bun run tail:simple-trade`.
Expected: a `cron step finished` line with `step: "dormant-wallet-alert"`, a `dormant wallets checked` line with the counts, and the alert in the operators' LINE chat.
On the following day, `due: 0` unless new wallets crossed 21 days.

- [ ] **Step 6: Write the verification note**

Add `docs/plans/2026-10-<dd>-dormant-wallet-alert-verification.md` with the counts, the backlog decision, and a screenshot of the LINE message.

---

## Self-review

- Store `last_trade_at` per wallet and update it on every trade: Task 1 table, Task 3 `syncWalletActivity` (monotonic `GREATEST`), run daily from HFM (see Context).
- Daily cron finds wallets with `now - last_trade_at > 21 days`: Task 4 cutoff + Task 3 `findDormantWallets`, scheduled in Task 5.
- Alert once per spell and record `alerted_at`: Task 3 `alerted_at < anchor` rule, Task 4 marks after a successful push; covered by "no repeat the next day" and "alerted again after another 21 days" tests.
- Funded but never traded counts from the funding date: `COALESCE(last_trade_at, first_funded_at)` in Task 3, `เติมเงิน ... ยังไม่เคยเทรด` line in Task 2, tests in Tasks 2-4.
