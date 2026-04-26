# PRP: Daily Client Snapshot Report Job

## Goal

Build a daily scheduled job inside the existing Bun + Hono server that runs at **05:00 ICT (Asia/Bangkok)**, fetches all HFM client performance rows, stores a local SQLite snapshot, compares today against yesterday by `account_id_client_id`, and pushes a LINE text report to configured admin user IDs.

## Why

- Gives admins a daily confirmation that the HFM client list sync ran.
- Flags client rows that appeared or disappeared without requiring manual API checks.
- Persists 90 days of local history in SQLite so later phases can add richer comparisons without re-querying old API states.

## What

**User-visible behavior:**
1. Server startup registers an in-process Croner job.
2. Every day at 05:00 ICT, the job fetches all client performance rows from HFAffiliates.
3. The job stores a full daily snapshot in `client_snapshots`.
4. The job compares today's composite keys with yesterday's composite keys.
5. The job pushes a LINE plain-text report to every active recipient seeded from `LINE_NOTIFY_UIDS`.
6. The job purges snapshots older than 90 days after a successful insert.

**Success Criteria:**
- [ ] `croner` dependency is added and the job is registered exactly once from `src/index.ts`.
- [ ] Job uses `Asia/Bangkok` timezone and fires at `0 5 * * *`.
- [ ] Job uses the live HFM client performance endpoint, not the aggregate overall-performance endpoint.
- [ ] SQLite schema is created automatically with both required tables and indexes.
- [ ] Snapshot date uses ICT `YYYY-MM-DD`, never UTC `toISOString().slice(0, 10)`.
- [ ] Running twice for the same ICT date is idempotent and does not duplicate snapshot rows.
- [ ] First run stores a baseline and sends the first-run LINE message.
- [ ] No-change run sends the selected no-change format, including total clients.
- [ ] Added/missing run lists changed clients by `account_id_client_id`.
- [ ] LINE messages are capped under the 5,000-character text-message limit.
- [ ] `bun test` and `bunx tsc --noEmit` pass.

---

## All Needed Context

### Documentation & References

```yaml
- url: https://api.hfaffiliates.com/docs#/performance%20reports%20(new)/get_client_performance_api_performance_client_performance_get
  why: >
    HFM client performance endpoint. Use this endpoint for the snapshot because it returns
    { clients, totals }. The OpenAPI path is /api/performance/client-performance.

- url: https://api.hfaffiliates.com/openapi.json
  why: >
    Live OpenAPI schema verified during PRP creation. Critical correction:
    /api/performance/overall-performance returns aggregate overall_performance rows, not clients.
    /api/performance/client-performance returns ClientsPerformanceResponseModel with clients and totals.

- url: https://croner.56k.guru/
  why: Croner supports JavaScript/TypeScript, Bun >= 1.0, async functions, time zones, error handling, and overrun protection.

- url: https://croner.56k.guru/usage/configuration/
  why: Use timezone: "Asia/Bangkok", protect: true, and catch callback in job options.

- url: https://croner.56k.guru/usage/pattern/
  why: Cron pattern fields. Use "0 5 * * *" for 05:00 in the configured timezone.

- url: https://bun.com/docs/runtime/sqlite
  why: >
    Bun-native SQLite driver. Use Database from "bun:sqlite", prepared statements,
    transactions, and PRAGMA journal_mode = WAL for concurrent reads with one writer.

- url: https://hono.dev/docs/getting-started/bun
  why: Existing app uses Hono's Bun export shape: export default { port, fetch: app.fetch }.

- url: https://developers.line.biz/en/docs/messaging-api/sending-messages/
  why: Push message endpoint behavior and request shape for sending messages at any time.

- url: https://developers.line.biz/en/reference/messaging-api/nojs/#text-message
  why: Text message max character limit is 5000; build notification under this limit.

- file: src/index.ts
  why: Existing Hono app entrypoint; add job registration after routes are configured and before export.

- file: src/services/hfm.service.ts
  why: Existing HFM fetch pattern, base URL env, Bearer auth, AbortController timeout, and result-union style.

- file: src/services/line.service.ts
  why: Existing LINE push helper. Add pushToAll by reusing pushText sequentially.

- file: src/types/hfm.types.ts
  why: Existing HFM response types need extension for full_name and snapshot use.

- file: tests/hfm.service.test.ts
  why: Existing Bun test style for mocked global fetch and service-level assertions.

- file: .env.example
  why: Add LINE_NOTIFY_UIDS and SQLITE_PATH using current env-file convention.

- file: docker-compose.yml
  why: Add ./data:/app/data volume so SQLite persists across container restarts.
```

### Live HFM API Correction

`INITIAL.md` names `GET /api/performance/overall_performance` and says it returns `{ clients, totals }`. The live OpenAPI schema contradicts that:

```yaml
WRONG_FOR_THIS_FEATURE:
  path: /api/performance/overall-performance
  operationId: get_overall_performance_api_performance_overall_performance_get
  response: OverallPerformanceResponseModel
  shape: { group_by, overall_performance, totals }
  reason: Does not return client rows.

USE_THIS:
  path: /api/performance/client-performance
  operationId: get_client_performance_api_performance_client_performance_get
  response: ClientsPerformanceResponseModel
  shape: { clients, totals }
  no_query_params: fetches all visible clients for the affiliate token.
```

The existing code already uses this endpoint for wallet lookup:

```typescript
// src/services/hfm.service.ts:42-46
const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
const url = `${baseUrl}/api/performance/client-performance?wallets=${walletNum}`;
const res = await fetch(url, {
  signal: controller.signal,
  headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
});
```

For this feature, add `fetchAllClients()` that calls:

```typescript
const url = `${baseUrl}/api/performance/client-performance`;
```

Do not add query params.

### Current Codebase Tree

```bash
HFM-Automation/
├── CLAUDE.md                 # points to AGNETS.md
├── AGNETS.md                 # Bun-first repo guidance; use bun:sqlite, bun test, no dotenv
├── INITIAL.md                # feature request
├── PRPs/
│   ├── line-hfm-bot.md       # previous PRP style
│   └── templates/prp_base.md # base template
├── package.json              # scripts: dev, start, test, typecheck
├── tsconfig.json             # strict TypeScript, noEmit
├── Dockerfile
├── docker-compose.yml        # currently lacks data volume
├── .env.example              # currently lacks LINE_NOTIFY_UIDS and SQLITE_PATH
├── examples/
│   ├── flex-message.json
│   ├── hfm-response.json
│   └── webhook-payload.json
├── src/
│   ├── index.ts
│   ├── builders/flex-message.builder.ts
│   ├── routes/webhook.ts
│   ├── services/hfm.service.ts
│   ├── services/line.service.ts
│   ├── types/hfm.types.ts
│   ├── types/line.types.ts
│   └── utils/signature.ts
└── tests/
    ├── flex-message.builder.test.ts
    ├── hfm.service.test.ts
    ├── signature.test.ts
    └── webhook.test.ts
```

Baseline verified before writing this PRP:

```bash
bun test
# 41 pass, 0 fail

bunx tsc --noEmit
# passes with no output
```

### Desired Codebase Tree

```bash
src/
├── index.ts                          # register jobs at startup
├── jobs/
│   ├── index.ts                      # registerJobs()
│   └── daily-client-report.ts        # runDailyClientReport()
├── repositories/
│   ├── recipient.repository.ts       # seedFromEnv(), getActiveUids()
│   └── snapshot.repository.ts        # countByDate(), getByDate(), insertMany(), purgeOlderThan()
├── services/
│   ├── hfm.service.ts                # add fetchAllClients()
│   ├── line.service.ts               # add pushToAll()
│   └── sqlite.service.ts             # Bun SQLite connection + schema init
├── types/
│   └── hfm.types.ts                  # extend client fields for snapshot use
└── utils/
    └── date.ts                       # ICT date helpers

tests/
├── daily-client-report.test.ts
├── date.test.ts
├── recipient.repository.test.ts
├── snapshot.repository.test.ts
├── sqlite.service.test.ts
├── hfm.service.test.ts               # extend existing tests for fetchAllClients()
└── line.service.test.ts

examples/
├── hfm-all-clients-response.json
├── notify-message-added-missing.txt
├── notify-message-no-change.txt
└── cron-registration.ts
```

### Known Gotchas

```typescript
// CRITICAL: Use Bun-native SQLite. Do not install better-sqlite3, sqlite3, drizzle-orm, or Prisma.
import { Database } from "bun:sqlite";

// CRITICAL: Create ./data before opening ./data/clients.db, or SQLite open can fail.
// Use node:fs mkdirSync only for directory creation; Bun automatically loads .env.

// CRITICAL: Enable WAL once per file-backed connection for concurrent readers/single writer.
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");

// CRITICAL: Bun SQLite named bindings require prefixes by default.
// Prefer strict: true so statements can bind { snapshot_date: today }.
const db = new Database(path, { strict: true });

// CRITICAL: ICT date must be explicit.
// At 05:00 ICT, UTC is still the previous day.
new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });

// CRITICAL: Croner can schedule in the target timezone directly.
// Do not encode 05:00 ICT as a UTC cron unless the timezone option is omitted on purpose.
new Cron("0 5 * * *", { timezone: "Asia/Bangkok", protect: true }, runDailyClientReport);

// CRITICAL: LINE text max is 5000 chars.
// Truncate around 4500 chars to leave room for "... and N more. Check full report."

// CRITICAL: HFM docs expose /api/performance/client-performance with a hyphen.
// Do not use /api/performance/overall_performance or /api/performance/overall-performance for client snapshots.

// CRITICAL: Existing src/types/hfm.types.ts lacks full_name, email, campaign, several numeric fields.
// Extend it without breaking current Flex Message tests.
// The INITIAL.md example includes balance, but the live ClientsPerformanceModel does not require balance.
// Do not depend on balance for this feature; store the whole raw JSON for future use.

// CRITICAL: Current tests mock globalThis.fetch. Restore it in afterEach like existing tests.

// CRITICAL: pushToAll must send sequentially. Do not Promise.all LINE pushes.
for (const uid of uids) {
  await pushText(uid, text);
  await Bun.sleep(200);
}
```

---

## Implementation Blueprint

### Data Models and Structure

Extend existing HFM types rather than replacing them. Keep the current `HFMPerformanceData` name because the Flex builder and existing tests import it.

```typescript
// src/types/hfm.types.ts
export interface HFMPerformanceData {
  client_id: number;
  account_id: number;
  client_registration?: string;
  activity_status: string;
  trades: number;
  volume: number;
  account_type: string;
  deposits: number;
  withdrawals?: number;
  account_currency: string;
  equity: number;
  archived: boolean | null;
  subaffiliate: number;
  account_regdate: string;
  status: string;
  full_name?: string;
  country?: string;
  platform?: string;
  email?: string;
  campaign?: string;
  commission?: number;
  notional_volume?: number;
  margin?: number;
  free_margin?: number;
  unpaid_rebates?: number;
  paid_rebates?: number;
  rejected_rebates?: number;
  tier?: number;
}

export interface HFMClientsPerformanceResponse {
  clients: HFMPerformanceData[];
  totals: {
    clients: number | string;
    accounts: number | string;
    volume: number | string;
    deposits: number | string;
    withdrawals: number | string;
    commission: number | string;
  };
}

export type HFMAllClientsResult =
  | { ok: true; data: HFMClientsPerformanceResponse }
  | { ok: false; reason: "server_error" | "timeout" };
```

SQLite row shape:

```typescript
// src/repositories/snapshot.repository.ts
export interface SnapshotRow {
  id: number;
  snapshot_date: string;
  composite_key: string;
  account_id: number;
  client_id: number;
  full_name: string;
  raw_json: string;
  created_at: string;
}

export interface SnapshotClient {
  composite_key: string;
  account_id: number;
  client_id: number;
  full_name: string;
  raw: HFMPerformanceData;
}
```

Schema:

```sql
CREATE TABLE IF NOT EXISTS client_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date   TEXT NOT NULL,
  composite_key   TEXT NOT NULL,
  account_id      INTEGER NOT NULL,
  client_id       INTEGER NOT NULL,
  full_name       TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, composite_key)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_date
  ON client_snapshots(snapshot_date);

CREATE INDEX IF NOT EXISTS idx_composite_key
  ON client_snapshots(composite_key, snapshot_date);

CREATE TABLE IF NOT EXISTS notify_recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  line_uid   TEXT NOT NULL UNIQUE,
  label      TEXT,
  active     INTEGER DEFAULT 1
);
```

The `UNIQUE(snapshot_date, composite_key)` constraint is not in `INITIAL.md`, but it is required to make idempotency enforceable at the database layer.

### Ordered Tasks

```yaml
Task 1: Add dependency and examples
  MODIFY package.json/bun.lock:
    - Run: bun add croner
  CREATE examples/hfm-all-clients-response.json:
    - Use INITIAL.md mock response.
    - Keep full_name/account_id/client_id fields.
  CREATE examples/notify-message-added-missing.txt:
    - Use INITIAL.md added/missing text.
  CREATE examples/notify-message-no-change.txt:
    - Use selected format with title, checked no-change line, total clients.
  CREATE examples/cron-registration.ts:
    - Show Croner registration with timezone: "Asia/Bangkok".

Task 2: Extend HFM types and service
  MODIFY src/types/hfm.types.ts:
    - Add full_name and optional live OpenAPI fields.
    - Change archived to boolean | null.
    - Add HFMAllClientsResult.
  MODIFY src/services/hfm.service.ts:
    - Preserve extractWalletNumber(), checkConditions(), fetchPerformance().
    - Add fetchAllClients() using /api/performance/client-performance with no query params.
    - Use same timeout/error style as fetchPerformance().

Task 3: Add ICT date utilities
  CREATE src/utils/date.ts:
    - getIctDateString(date = new Date()): "YYYY-MM-DD".
    - getPreviousIctDateString(date = new Date()): previous ICT calendar date.
    - formatIctDisplayDate(dateString: string): "DD/MM/YYYY".

Task 4: Add SQLite service
  CREATE src/services/sqlite.service.ts:
    - getDatabase(path = env/default), initSqlite(), resetDatabaseForTests().
    - Create parent directory for file-backed DB paths.
    - Use Database(path, { strict: true }).
    - Enable WAL and busy_timeout.
    - Create schema and indexes.

Task 5: Add repositories
  CREATE src/repositories/snapshot.repository.ts:
    - toCompositeKey(), countByDate(), getByDate(), insertMany(), purgeOlderThan().
    - Normalize missing/blank client names as "Unknown Client" before inserting NOT NULL full_name.
    - Use transaction for insertMany().
    - Parse raw_json safely when returning SnapshotClient.
  CREATE src/repositories/recipient.repository.ts:
    - parseNotifyUids(), seedFromEnv(), getActiveUids().
    - Trim whitespace, ignore empty env entries, dedupe UIDs.
    - Seed with INSERT OR IGNORE so labels/active flags are not overwritten.

Task 6: Add LINE multi-recipient helper
  MODIFY src/services/line.service.ts:
    - Export pushToAll(uids: string[], text: string): Promise<void>.
    - Send sequentially using existing pushText().
    - Sleep 200ms between recipients except after the last recipient.

Task 7: Add daily report job
  CREATE src/jobs/daily-client-report.ts:
    - Export buildDailyClientReportMessage(), compareSnapshots(), runDailyClientReport().
    - Main flow: init DB, seed recipients, idempotency check, fetch all clients, insert today, read yesterday, build message, push, purge old rows.
    - First run sends baseline message.
    - No-change message uses selected format.
    - Message builder truncates details under 5000 characters.
  CREATE src/jobs/index.ts:
    - Export registerJobs().
    - Register Cron("0 5 * * *", { timezone: "Asia/Bangkok", protect: true, catch }, async () => ...).

Task 8: Wire startup and deployment config
  MODIFY src/index.ts:
    - import { registerJobs } from "./jobs";
    - call registerJobs() after route setup.
  MODIFY .env.example:
    - add LINE_NOTIFY_UIDS=Uabc123,Udef456
    - add SQLITE_PATH=./data/clients.db
  MODIFY docker-compose.yml:
    - add volumes:
      - ./data:/app/data

Task 9: Add tests
  CREATE/UPDATE tests listed in Test Plan.
  Run bun test and bunx tsc --noEmit until both pass.
```

### Pseudocode

```typescript
// src/services/hfm.service.ts
export async function fetchAllClients(timeoutMs = 10_000): Promise<HFMAllClientsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
    const url = `${baseUrl}/api/performance/client-performance`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
    });

    if (res.status >= 500 || res.status === 401 || res.status === 429 || res.status !== 200) {
      return { ok: false, reason: "server_error" };
    }

    const body = (await res.json()) as HFMClientsPerformanceResponse;
    if (!Array.isArray(body.clients) || body.totals == null) {
      return { ok: false, reason: "server_error" };
    }

    return { ok: true, data: body };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}
```

```typescript
// src/utils/date.ts
export function getIctDateString(date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

export function getPreviousIctDateString(date = new Date()): string {
  const ictDate = getIctDateString(date);
  const [yearText, monthText, dayText] = ictDate.split("-");
  if (!yearText || !monthText || !dayText) {
    throw new Error(`Invalid ICT date string: ${ictDate}`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  utcNoon.setUTCDate(utcNoon.getUTCDate() - 1);
  return utcNoon.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

export function formatIctDisplayDate(dateString: string): string {
  const [year, month, day] = dateString.split("-");
  if (!year || !month || !day) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
  return `${day}/${month}/${year}`;
}
```

```typescript
// src/jobs/daily-client-report.ts
interface RunDailyClientReportOptions {
  now?: Date;
  db?: Database;
  fetchAllClientsFn?: typeof fetchAllClients;
  pushToAllFn?: typeof pushToAll;
}

export async function runDailyClientReport(options: RunDailyClientReportOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDatabase();
  const fetchAllClientsForRun = options.fetchAllClientsFn ?? fetchAllClients;
  const pushToAllForRun = options.pushToAllFn ?? pushToAll;

  initSqlite(db);
  seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");

  const today = getIctDateString(now);
  const yesterday = getPreviousIctDateString(now);

  if (countByDate(db, today) > 0) {
    console.warn(`[cron] daily-client-report snapshot already exists for ${today}; skipping`);
    return;
  }

  const result = await fetchAllClientsForRun();
  if (!result.ok) throw new Error(`HFM fetchAllClients failed: ${result.reason}`);

  insertMany(db, today, result.data.clients);

  const todayRows = getByDate(db, today);
  const yesterdayRows = getByDate(db, yesterday);
  const message = buildDailyClientReportMessage({
    date: today,
    today: todayRows,
    yesterday: yesterdayRows,
    totals: result.data.totals,
  });

  const uids = getActiveUids(db);
  if (uids.length === 0) {
    console.warn("[cron] daily-client-report has no active LINE recipients");
  } else {
    await pushToAllForRun(uids, message);
  }

  purgeOlderThan(db, 90, today);
}
```

```typescript
// compare snapshots in O(n)
export function compareSnapshots(today: SnapshotClient[], yesterday: SnapshotClient[]) {
  const todayKeys = new Set(today.map((c) => c.composite_key));
  const yesterdayKeys = new Set(yesterday.map((c) => c.composite_key));

  return {
    added: today.filter((c) => !yesterdayKeys.has(c.composite_key)),
    missing: yesterday.filter((c) => !todayKeys.has(c.composite_key)),
  };
}
```

```typescript
// selected no-change format
`📅 Daily Client Report — ${displayDate}
✅ No changes detected.
📊 Total Clients Today: ${totalClients}`;
```

### Notification Rules

Use these exact formats.

First run:

```text
📅 Daily Client Report — 26/04/2026
🔔 First run — baseline snapshot saved.
📊 Total Clients Today: 45
```

No changes:

```text
📅 Daily Client Report — 26/04/2026
✅ No changes detected.
📊 Total Clients Today: 45
```

Added/missing:

```text
📅 Daily Client Report — 26/04/2026

✅ New Clients (2)
━━━━━━━━━━━━━━━━━━━━
• Malee Srisuk
  Client ID : 10024
  Account ID: 99001234

• Preecha Wongsuk
  Client ID : 10031
  Account ID: 88123456

❌ Missing Clients (1)
━━━━━━━━━━━━━━━━━━━━
• Somchai Jaidee
  Client ID : 10023
  Account ID: 78451293

📊 Total Clients Today: 45
```

For change reports, include both "New Clients" and "Missing Clients" sections with their counts. If a section has count `0`, include the header and separator with no bullet rows.

Truncation:

```typescript
const LINE_SAFE_LIMIT = 4500;
// If full message exceeds LINE_SAFE_LIMIT, keep header/section headers/total,
// add as many client bullet blocks as fit, then append:
`... and ${remaining} more. Check full report.`;
```

### Integration Points

```yaml
DEPENDENCIES:
  - add: croner
  - command: bun add croner

CONFIG:
  - .env.example:
      LINE_NOTIFY_UIDS: comma-separated LINE user IDs, e.g. Uabc123,Udef456
      SQLITE_PATH: ./data/clients.db
  - Bun loads .env automatically; do not add dotenv.

DATABASE:
  - local SQLite file defaults to ./data/clients.db
  - docker-compose.yml must mount ./data:/app/data
  - schema is created by initSqlite(); no migration tool needed.

STARTUP:
  - src/index.ts imports registerJobs from ./jobs
  - call registerJobs() once when module loads.

LINE:
  - reuse pushText(userId, text)
  - pushToAll sends to active UIDs one by one with 200ms gap.
```

---

## Validation Loop

### Level 1: Dependency, Syntax, Typecheck

```bash
# Add required scheduler dependency
bun add croner

# TypeScript validation
bunx tsc --noEmit
```

Expected: no TypeScript errors.

### Level 2: Unit Tests

Add focused tests before or alongside implementation. Use `bun:test` and the existing mock patterns.

```typescript
// tests/date.test.ts
import { expect, test } from "bun:test";
import { getIctDateString, getPreviousIctDateString, formatIctDisplayDate } from "../src/utils/date";

test("ICT date uses Asia/Bangkok instead of UTC", () => {
  const utcPreviousDay = new Date("2026-04-25T22:00:00.000Z"); // 2026-04-26 05:00 ICT
  expect(getIctDateString(utcPreviousDay)).toBe("2026-04-26");
});

test("previous ICT date subtracts one local calendar day", () => {
  const runTime = new Date("2026-04-25T22:00:00.000Z");
  expect(getPreviousIctDateString(runTime)).toBe("2026-04-25");
});

test("display date is DD/MM/YYYY", () => {
  expect(formatIctDisplayDate("2026-04-26")).toBe("26/04/2026");
});
```

```typescript
// tests/hfm.service.test.ts additions
test("fetchAllClients calls client-performance with no query params", async () => {
  let calledUrl = "";
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calledUrl = String(url);
    return new Response(JSON.stringify(mockHfmResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const result = await fetchAllClients();
  expect(result.ok).toBe(true);
  expect(calledUrl).toBe("https://api.hfaffiliates.com/api/performance/client-performance");
  expect(calledUrl.includes("?")).toBe(false);
});

test("fetchAllClients timeout returns timeout", async () => {
  globalThis.fetch = (async (_url, init) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
    throw new Error("unreachable");
  }) as unknown as typeof globalThis.fetch;

  const result = await fetchAllClients(5);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("timeout");
});
```

```typescript
// tests/snapshot.repository.test.ts
test("insertMany stores composite key and raw json", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-04-26", [clientA]);
  const rows = getByDate(db, "2026-04-26");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.composite_key).toBe("78451293_10023");
  expect(rows[0]!.full_name).toBe("Somchai Jaidee");
  expect(rows[0]!.raw.client_id).toBe(10023);
});

test("insertMany is protected by unique snapshot date and composite key", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-04-26", [clientA]);
  expect(() => insertMany(db, "2026-04-26", [clientA])).toThrow();
});

test("purgeOlderThan removes rows older than retention window", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  insertMany(db, "2026-01-01", [clientA]);
  insertMany(db, "2026-04-26", [clientB]);
  purgeOlderThan(db, 90, "2026-04-26");
  expect(countByDate(db, "2026-01-01")).toBe(0);
  expect(countByDate(db, "2026-04-26")).toBe(1);
});
```

```typescript
// tests/recipient.repository.test.ts
test("parseNotifyUids trims and dedupes comma separated env", () => {
  expect(parseNotifyUids(" Uabc123, Udef456, Uabc123, ")).toEqual(["Uabc123", "Udef456"]);
});

test("seedFromEnv inserts recipients without overwriting active flag", () => {
  const db = new Database(":memory:", { strict: true });
  initSqlite(db);
  seedFromEnv(db, "Uabc123,Udef456");
  db.query("UPDATE notify_recipients SET active = 0 WHERE line_uid = $line_uid").run({ line_uid: "Uabc123" });
  seedFromEnv(db, "Uabc123,Udef456");
  expect(getActiveUids(db)).toEqual(["Udef456"]);
});
```

```typescript
// tests/daily-client-report.test.ts
test("compareSnapshots detects added and missing clients", () => {
  const today = [snapshotClient("78451293_10023"), snapshotClient("99001234_10024")];
  const yesterday = [snapshotClient("78451293_10023"), snapshotClient("88123456_10031")];
  const diff = compareSnapshots(today, yesterday);
  expect(diff.added.map((c) => c.composite_key)).toEqual(["99001234_10024"]);
  expect(diff.missing.map((c) => c.composite_key)).toEqual(["88123456_10031"]);
});

test("build message handles first run", () => {
  const message = buildDailyClientReportMessage({
    date: "2026-04-26",
    today: [snapshotClient("78451293_10023")],
    yesterday: [],
    totals: { clients: 1, accounts: 1, volume: 0, deposits: 0, withdrawals: 0, commission: 0 },
  });
  expect(message).toContain("🔔 First run — baseline snapshot saved.");
  expect(message).toContain("📊 Total Clients Today: 1");
});

test("build message handles no changes with selected format", () => {
  const rows = [snapshotClient("78451293_10023")];
  const message = buildDailyClientReportMessage({
    date: "2026-04-26",
    today: rows,
    yesterday: rows,
    totals: { clients: 1, accounts: 1, volume: 0, deposits: 0, withdrawals: 0, commission: 0 },
  });
  expect(message).toBe("📅 Daily Client Report — 26/04/2026\n✅ No changes detected.\n📊 Total Clients Today: 1");
});

test("build message truncates long reports under LINE limit", () => {
  const today = Array.from({ length: 500 }, (_, i) => snapshotClient(`9000_${i}`, `Client ${i}`));
  const message = buildDailyClientReportMessage({
    date: "2026-04-26",
    today,
    yesterday: [],
    totals: { clients: 500, accounts: 500, volume: 0, deposits: 0, withdrawals: 0, commission: 0 },
  });
  expect(message.length).toBeLessThanOrEqual(5000);
  expect(message).toContain("Check full report.");
});
```

### Level 3: Full Validation

```bash
# Run all tests
bun test

# Typecheck the whole project
bunx tsc --noEmit
```

Expected:
- `bun test`: all tests pass.
- `bunx tsc --noEmit`: exits 0 with no output.

### Level 4: Manual Smoke Test

Use a temporary SQLite file and mocked env values:

```bash
SQLITE_PATH=/tmp/hfm-daily-client-report-test.db \
LINE_NOTIFY_UIDS=Utest123 \
HFM_API_BASE_URL=https://api.hfaffiliates.com \
bun test tests/daily-client-report.test.ts tests/snapshot.repository.test.ts tests/recipient.repository.test.ts
```

Expected:
- tests pass
- no tracked files are modified
- temporary DB can be deleted manually after inspection

## Final Validation Checklist

- [ ] `croner` appears in `package.json` dependencies and `bun.lock`.
- [ ] `src/index.ts` calls `registerJobs()` once.
- [ ] `fetchAllClients()` calls `/api/performance/client-performance` without query params.
- [ ] SQLite parent directory is created before opening file DB.
- [ ] WAL and busy timeout pragmas are set.
- [ ] Schema includes `UNIQUE(snapshot_date, composite_key)`.
- [ ] Env seeding is `INSERT OR IGNORE` and does not reactivate disabled rows.
- [ ] Date helpers pass the 05:00 ICT boundary test.
- [ ] LINE no-change message matches the selected format exactly.
- [ ] Message truncation keeps text under 5,000 characters.
- [ ] Docker Compose mounts `./data:/app/data`.
- [ ] `bun test` passes.
- [ ] `bunx tsc --noEmit` passes.

---

## Anti-Patterns to Avoid

- Do not use `/api/performance/overall_performance`; it is not in the live OpenAPI schema.
- Do not use `/api/performance/overall-performance` for this feature; it returns aggregates, not clients.
- Do not install an ORM or third-party SQLite driver.
- Do not derive snapshot dates from `toISOString()`.
- Do not send LINE pushes with `Promise.all`.
- Do not skip no-change notifications.
- Do not purge old snapshots before the new snapshot insert succeeds.
- Do not overwrite manually disabled `notify_recipients.active = 0` rows when seeding from env.
- Do not let tests hit the real HFM or LINE APIs.

## Confidence Score

**9/10** for one-pass implementation with Claude Code.

Reasoning: the PRP includes verified live API correction, exact repo integration points, executable validation gates, known library quirks, and test scenarios. The remaining risk is whether HFM production data ever omits fields the OpenAPI marks required; implementation should keep snapshot storage tolerant by only requiring `account_id` and `client_id`, using `full_name ?? "Unknown Client"` for report rows, and preserving the full raw JSON.
