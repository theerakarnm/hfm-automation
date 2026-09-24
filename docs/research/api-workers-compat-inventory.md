# apps/api Workers-Compatibility Inventory

Read-only fact inventory of `apps/api/src` for a Cloudflare Workers migration.
Scope: every file under `src/`, plus the affected files in `scripts/` and `tests/`.
No design proposals. Facts and citations only.

Repo path: `/Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation/apps/api`.
Runtime today: Bun + Hono + Drizzle (postgres-js) + croner + pino.
Entry point: `src/index.ts` exports `{ port, fetch }` for `Bun.serve` (`src/index.ts:51-54`).

## 1. File-by-file verdict

| File | Lines | Workers blockers | Notes |
| --- | --- | --- | --- |
| `src/index.ts` | 54 | top-level `await initDb(db)` (12); top-level side effects: `getDb()` (11), `registerJobs()` (33), `getLastTradeMap()` warm call (37-41); `process.on` (48-49); `process.exit` (45); `process.env.PORT` (52); Bun server export shape (51-54) | Whole startup sequence is module-load work. See section 5. |
| `src/jobs/index.ts` | 17 | `croner` import (1) and `new Cron("*/5 * * * *", { timezone: "Asia/Bangkok", protect: true }, ...)` (5-15); `console.log` side effect at register time (16) | Only `hfm-healthcheck` is scheduled here. The daily report has no in-process cron. |
| `src/jobs/hfm-healthcheck.ts` | 57 | module-level mutable state `let lastHealthy = true` (13); `process.env.LINE_NOTIFY_UIDS` (23); `getDb()` default (30) | State is per-process; comment at 10-12 admits a restart re-sends the "down" alert. |
| `src/jobs/daily-client-report.ts` | 545 | `process.env.TARGET_WALLET` (26, 29); `process.env.LINE_NOTIFY_UIDS` (485); retry sleeps `setTimeout` 5s/10s (269, 273); `getDb()` (471, 481) | Long wall-clock job. See section 6. |
| `src/db/connection.ts` | 106 | `postgres` (postgres.js) TCP driver (1); pool `postgres(connUrl, { max: 10 })` (15); module-level singletons `_client`, `_db` (8-9); `process.env.DATABASE_URL` (13); `initDb` runs 8 `CREATE TABLE`/`ALTER TABLE` DDL statements at boot (22-92) | `closeDb()` (95-101) and `resetDbForTests()` (103-106) exist only for process/test lifecycle. |
| `src/db/schema.ts` | 125 | none | Pure Drizzle pg schema. |
| `src/routes/webhook.ts` | 706 | `process.env.LINE_CHANNEL_SECRET` (165); `process.env.LAST_TRADE_DEADLINE_MS` (42); fire-and-forget handlers not awaited before the response (235-263, 243, 250, 257, 261) and `return c.text("OK", 200)` (274); `crypto.randomUUID()` (52, available on Workers); unbounded-ish fan-out loop over up to 20 events (190, 205) | Background work after response needs an explicit extension mechanism on Workers. See section 6. |
| `src/routes/internal.ts` | 95 | `process.env.INTERNAL_API_KEY` (16); `process.env.HFM_API_BASE_URL` (35); `process.env.HFM_API_KEY` (38); log routes read the local filesystem through `../utils/logger` (3, 51, 62) | See section 8. |
| `src/services/hfm.service.ts` | 422 | 7 x `process.env.HFM_API_BASE_URL`, 7 x `process.env.HFM_API_KEY`, plus `LOT_DISPLAY_MODE` (69), `DEPOSIT_THRESHOLD_USD`/`USC` (83), `TARGET_WALLET` (114); `setTimeout`-based abort timers (148, 264, 301, 339, 384); `fetchClients` default timeout `120_000` ms (262) | No fs, no node built-ins. `AbortController` and `AbortSignal.timeout` are Workers-safe. |
| `src/services/line.service.ts` | 199 | `Bun.sleep(200)` (167); 5 x `process.env.LINE_CHANNEL_ACCESS_TOKEN` (35, 56, 77, 98, 188); serial push loop `pushToAll` (163-170) | `Bun.sleep` is the only `Bun.*` call in `src/`. |
| `src/services/last-trade.service.ts` | 129 | module-level mutable cache `cache` (17) and `inflight` (18); `setTimeout` sleep/deadline (27, 82-91); background refresh that outlives the request (51-53, 61) | Fully documented in section 7. |
| `src/builders/flex-message.builder.ts` | 710 | module-level mutable `let warnedFlexVersion` (33); `process.env.FLEX_SUMMARY_VERSION` (40) | Otherwise pure formatting, `Intl` + dayjs only. |
| `src/utils/logger.ts` | 116 | `pino` (1); `node:path` (2); `node:fs` `existsSync`, `readdirSync`, `readFileSync` (3); `LOG_DIR = "logs"` relative path (6); module-level logger instance (15-17); `process.env.NODE_ENV` (9), `process.env.LOG_LEVEL` (12); fs reads at 47, 48, 52, 54, 103, 106 | Highest-risk single file. `pino-roll` and `pino-pretty` are in `package.json` but not imported by `src/`; both branches of line 15-17 are identical plain `pino(options)` to stdout. |
| `src/utils/signature.ts` | 16 | `node:crypto` `createHmac` + `timingSafeEqual` (1, 8, 12); `Buffer` (12) | Needs `nodejs_compat` or a WebCrypto rewrite. |
| `src/utils/whitelist.ts` | 52 | 4 env reads (10, 14, 27, 38) | Read per call, not cached. |
| `src/utils/chat-context.ts` | 35 | none | Pure. |
| `src/utils/date.ts` | 71 | none | dayjs tz only. |
| `src/utils/dayjs.ts` | 12 | module-level `dayjs.extend(...)` side effects (6-8) | Harmless plugin registration; still module-load work. |
| `src/utils/mention.ts` | 33 | none | Pure. |
| `src/repositories/line-group.repository.ts` | 84 | none beyond the postgres-js driver reached through `DrizzleDb` | Pure SQL via Drizzle. |
| `src/repositories/line-user.repository.ts` | 49 | same | Pure SQL. |
| `src/repositories/recipient.repository.ts` | 34 | same | `seedFromEnv` takes the env string as an argument (16-26); callers read the env. |
| `src/repositories/report-range.repository.ts` | 63 | same | Not referenced by `src/routes` or `src/jobs`. |
| `src/repositories/request-snapshot.repository.ts` | 105 | same; uses `db.transaction` (21) | Transactions need a driver that supports them over the chosen Workers transport. |
| `src/repositories/snapshot.repository.ts` | 73 | same; chunked insert loop `CHUNK_SIZE = 500` (6, 23-47) | One DB round trip per 500 rows. |
| `src/types/hfm.types.ts` | 115 | none | Types only. |
| `src/types/line.types.ts` | 109 | none | Types and type guards. |

## 2. Blocker index by category

| Category | Occurrences (file:line) |
| --- | --- |
| `process.env` reads | 39 reads, 20 distinct names. Full list in section 3. |
| `node:fs` | `src/utils/logger.ts:3` (import), `:47`, `:48`, `:54`, `:103`, `:106` |
| `node:path` | `src/utils/logger.ts:2` (import), `:52` |
| `node:crypto` | `src/utils/signature.ts:1`, `:8`, `:12` (also `Buffer` at `:12`) |
| pino | `src/utils/logger.ts:1`, `:11`, `:15-17`, `:80-81`; `src/builders/flex-message.builder.ts:3,45` uses the logger instance |
| pino-roll / pino-pretty | Declared in `package.json` deps, **not imported anywhere in `src/`** |
| croner | `src/jobs/index.ts:1`, `:5-15` |
| postgres.js pool | `src/db/connection.ts:1`, `:15` (`{ max: 10 }`) |
| Module-level singletons / mutable caches | `src/db/connection.ts:8-9`; `src/services/last-trade.service.ts:17-18`; `src/jobs/hfm-healthcheck.ts:13`; `src/builders/flex-message.builder.ts:33`; `src/utils/logger.ts:15`; `src/routes/webhook.ts:149` and `src/routes/internal.ts:8` (module-level `new Hono()`) |
| Top-level `await` | `src/index.ts:12` (`await initDb(db)`) |
| Top-level side effects | `src/index.ts:11` (`getDb()`), `:33` (`registerJobs()`), `:37-41` (cache warm), `:14-28` (middleware registration), `:30-31` (route mount); `src/utils/dayjs.ts:6-8`; `src/jobs/index.ts:16` (`console.log`) |
| `process.on` | `src/index.ts:48`, `:49` |
| `process.exit` | `src/index.ts:45` (also `scripts/*`) |
| `Bun.*` | `src/services/line.service.ts:167` (`Bun.sleep(200)`) |
| Long `setTimeout` sleeps | `src/jobs/daily-client-report.ts:269,273` (5 s then 10 s); `src/services/last-trade.service.ts:8,119` (1 s then 2 s backoff) |
| `setTimeout` as abort timer | `src/services/hfm.service.ts:148,264,301,339,384`; `src/services/last-trade.service.ts:84` |
| `setInterval` | none in `src/` |
| Long request timeouts | `fetchClients` default `120_000` ms (`src/services/hfm.service.ts:262`), used by the LINE reply path through `generateReportForUser` (`src/jobs/daily-client-report.ts:472,292`) |
| Loops of `fetch` calls | `src/services/line.service.ts:163-170` (one push per recipient, unbounded by row count); `src/jobs/daily-client-report.ts:253-279` (up to 3); `src/services/last-trade.service.ts:105-121` (up to 3); `src/routes/webhook.ts:205-272` (up to 20 events, each fanning out) |
| Work after response | `src/routes/webhook.ts:235,243,250,257,261` then `:274` returns 200 |

## 3. Env var table (every distinct name read by `src/`)

20 distinct names. 5 are secrets. 15 are flags, tuning values, or non-secret config.

| # | Name | Purpose | Secret vs var | Default | Read at (file:line) |
| --- | --- | --- | --- | --- | --- |
| 1 | `DATABASE_URL` | Postgres connection string | **SECRET** | none; throws `DATABASE_URL is not set` | `src/db/connection.ts:13` |
| 2 | `HFM_API_KEY` | Bearer token for HFAffiliates API | **SECRET** | none; sends `Bearer undefined` | `src/routes/internal.ts:38`; `src/services/hfm.service.ts:26,154,270,307,347,395` |
| 3 | `INTERNAL_API_KEY` | Shared key for `/internal/*` (`?key=`) | **SECRET** | none; any request then 401 | `src/routes/internal.ts:16` |
| 4 | `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API bearer | **SECRET** | none | `src/services/line.service.ts:35,56,77,98,188` |
| 5 | `LINE_CHANNEL_SECRET` | LINE webhook HMAC secret | **SECRET** | `""` (`?? ""`) | `src/routes/webhook.ts:165` |
| 6 | `HFM_API_BASE_URL` | HFM API base URL | var | `https://api.hfaffiliates.com` | `src/routes/internal.ts:35`; `src/services/hfm.service.ts:23,150,266,303,341,386` |
| 7 | `PORT` | Bun listen port | var (Workers-irrelevant) | `3000` | `src/index.ts:52` |
| 8 | `NODE_ENV` | Test detection in the logger | var | unset | `src/utils/logger.ts:9` |
| 9 | `LOG_LEVEL` | pino level | var | `"info"` | `src/utils/logger.ts:12` |
| 10 | `TARGET_WALLET` | Partner wallet used by `matchAll` and report labels | var (business config) | `0` / label `"N/A"` | `src/jobs/daily-client-report.ts:26,29`; `src/services/hfm.service.ts:114` |
| 11 | `DEPOSIT_THRESHOLD_USD` | Deposit condition, USD | tuning | `200` | `src/services/hfm.service.ts:83` |
| 12 | `DEPOSIT_THRESHOLD_USC` | Deposit condition, USC cents | tuning | `200_00` | `src/services/hfm.service.ts:83` |
| 13 | `LAST_TRADE_DEADLINE_MS` | Reply-path budget for the last-trade map | tuning | `8_000` | `src/routes/webhook.ts:42` |
| 14 | `LOT_DISPLAY_MODE` | `always` vs `lot_prefix_only` Volume display | FEATURE FLAG | `"always"` | `src/services/hfm.service.ts:69` |
| 15 | `FLEX_SUMMARY_VERSION` | `flex-v1` vs `flex-v2` card | FEATURE FLAG | `"flex-v1"` | `src/builders/flex-message.builder.ts:40` |
| 16 | `LINE_WHITELIST_ENABLED` | Per-UID whitelist on/off | FEATURE FLAG | on unless `false/0/off/no` | `src/utils/whitelist.ts:10` |
| 17 | `LINE_GROUP_WHITELIST_ENABLED` | Group whitelist on/off | FEATURE FLAG | on unless `false/0/off/no` | `src/utils/whitelist.ts:14` |
| 18 | `LINE_WHITELIST_UIDS` | Allowed one-on-one UIDs, comma list | config (PII, not secret) | empty = allow all | `src/utils/whitelist.ts:27` |
| 19 | `LINE_GROUP_WHITELIST_IDS` | Allowed group/room IDs, comma list | config (PII, not secret) | empty = allow all | `src/utils/whitelist.ts:38` |
| 20 | `LINE_NOTIFY_UIDS` | Seed list of push recipients | config (PII, not secret) | `""` | `src/jobs/daily-client-report.ts:485`; `src/jobs/hfm-healthcheck.ts:23` |

Env names outside `src/`:
`TEST_DATABASE_URL` (tests only, e.g. `tests/db-helpers.ts:7`, `tests/webhook.test.ts:17`) and the script-only knobs `DRY_RUN`, `FORCE`, `FROM_DATE`, `TO_DATE`, `OUTPUT`, `PREV_FILE`, `CURR_FILE`, `SOURCE_FILE`, `MOCK_REPLACE`, `REMOVE_PER_DAY`, `ADD_PER_DAY`.

Read timing matters: every env read in `src/` happens **inside a function call**, except `src/index.ts:52` (`PORT`), `src/utils/logger.ts:9,12` (`NODE_ENV`, `LOG_LEVEL`, read at module load).
The per-call reads are deliberate; three comments say so explicitly (`src/services/hfm.service.ts:64-65,77-78`, `src/routes/webhook.ts:39-40`).

## 4. Local filesystem access

| Operation | file:line | Detail |
| --- | --- | --- |
| Read dir existence | `src/utils/logger.ts:47` | `existsSync(LOG_DIR)` inside `readLog` |
| List dir | `src/utils/logger.ts:48` | `readdirSync(LOG_DIR)`, filters `log.<date>*.log` |
| Path join | `src/utils/logger.ts:52` | `join(LOG_DIR, ...)` |
| Read file | `src/utils/logger.ts:54-58` | `readFileSync`, tail-truncated to `MAX_LOG_READ_BYTES = 512 * 1024` (`:7`) |
| Read dir existence | `src/utils/logger.ts:103` | `existsSync(LOG_DIR)` inside `listLogDates` |
| List dir | `src/utils/logger.ts:106-111` | `readdirSync(LOG_DIR)`, extracts `YYYYMMDD` |
| Log dir constant | `src/utils/logger.ts:6` | `const LOG_DIR = "logs"`, relative to the process CWD |

No file **writes** exist in `src/`.
pino is constructed without a transport (`src/utils/logger.ts:11-17`), so log output goes to stdout; the `logs/` directory that `readLog`/`listLogDates` expect is produced outside the application code.
Script-level filesystem use (not `src/`): `scripts/fetch-client-performance-range.ts:30-31` (`Bun.file`, `Bun.write` to `./output/...`), `scripts/playground.ts:6` (`Bun.file(...).json()`), `scripts/compare-client-performance-files.ts:29-30`, `scripts/seed-mock-client-snapshots.ts:90`.
A `data/` directory exists at `apps/api/data` but nothing in `src/` reads or writes it.

## 5. `src/index.ts` startup sequence, step by step

| Step | Line | What happens | Workers relevance |
| --- | --- | --- | --- |
| 1 | 1-7 | Imports `hono`, both route modules, `registerJobs`, logger, `getLastTradeMap`, db helpers. Importing `./routes/webhook` and `./routes/internal` constructs their module-level `Hono()` instances (`webhook.ts:149`, `internal.ts:8`) and `./utils/logger` constructs the pino instance (`logger.ts:15`) | module-load side effects |
| 2 | 9 | `const app = new Hono()` | fine |
| 3 | 11 | `const db = getDb()` - creates the postgres.js pool (`max: 10`) and reads `DATABASE_URL`; throws at import time when unset | env read + TCP pool at module load |
| 4 | 12 | `await initDb(db)` - **top-level await**, runs the full DDL block (`connection.ts:22-92`) against Postgres on every boot | top-level await + boot-time DDL |
| 5 | 14-28 | Registers a global request logger middleware that logs method/path before and status/duration after `next()` | fine |
| 6 | 30-31 | Mounts `/webhook` and `/internal` | fine |
| 7 | 33 | `registerJobs()` - installs the croner 5-minute `hfm-healthcheck` job in-process and logs | croner |
| 8 | 37-41 | Fires `getLastTradeMap()` without awaiting, to warm the last-trade cache; logs size on success, `logError("startup-warm", ...)` on failure. Comment at 35-36: avoids paying the ~7 s `/api/clients/` round trip on the first customer lookup | background fetch at boot; up to 3 HFM calls |
| 9 | 43-46 | Defines `shutdown()`: logs, `closeDb()`, then `process.exit(0)` | `process.exit` |
| 10 | 48-49 | `process.on("SIGTERM"|"SIGINT")` -> `shutdown` | `process.on` |
| 11 | 51-54 | Default export `{ port: Number(process.env.PORT) || 3000, fetch: app.fetch }` for `Bun.serve` | export shape differs from a Workers module |

## 6. Subrequest counts per invocation

"Subrequest" = one outbound `fetch()`. Postgres traffic goes over a TCP socket, not `fetch`, and is counted separately.

### 6a. Daily report job - `src/jobs/daily-client-report.ts`

`runDailyClientReport` (479-545):

| Stage | Line | Fetches | Notes |
| --- | --- | --- | --- |
| `seedFromEnv` | 485 | 0 | 1 DB insert |
| `ensureTodaySnapshot` | 489 -> 244-281 | **1 to 3** HFM `GET /api/clients/` | `for (let attempt = 1; attempt <= maxRetries; attempt++)` with `maxRetries = 3` (248, 253); skipped entirely if `countByDate(db, today) > 0` (250-251) |
| retry delay | 269, 273 | 0 | `const delayMs = attempt * 5_000;` then `await new Promise((resolve) => setTimeout(resolve, delayMs));` -> 5 s + 10 s = **15 s of sleeping** |
| notification guard | 491 | 0 | `hasDailyReportNotificationSent` |
| baseline lookups | 500-524 | 0 | 3-5 DB queries |
| `pushAll(uids, message)` | 538 -> `line.service.ts:163-170` | **N** = number of active recipients, one LINE push each | `await Bun.sleep(200)` between pushes (167), so N pushes cost `200 * (N-1)` ms |
| `purgeOlderThan` | 544 | 0 | 1 DB delete |

Worst case fetches: **3 + N** where N is `getActiveUids(db).length` (518) and is unbounded by code.
Worst-case wall clock: 3 x `fetchClients` at the default `120_000` ms timeout (`hfm.service.ts:262`) + 15 s of sleeps + `0.2 * (N-1)` s, i.e. **> 6 minutes** before the first push.
`runDailyClientReport` is not scheduled by croner; only `scripts/trigger-daily-client-report.ts` calls it. `src/jobs/index.ts:5-6` registers only `hfm-healthcheck` (`*/5 * * * *`, `Asia/Bangkok`).

`generateReportForUser` (469-477), the path used by the LINE `report` command, makes exactly **1** HFM fetch (`const result = await fetchCurrent();` at 292) plus 2-4 DB queries, and that fetch uses the `120_000` ms default timeout.

`runHfmHealthCheck` (`src/jobs/hfm-healthcheck.ts:27-52`): **1** HFM probe (35) plus **N** LINE pushes (50) only on an up/down transition.

### 6b. LINE webhook - `src/routes/webhook.ts`

Per HTTP POST the loop processes up to `MAX_WEBHOOK_EVENTS = 20` events:
`const MAX_WEBHOOK_EVENTS = 20;` (33), `const eventsToProcess = events.slice(0, MAX_WEBHOOK_EVENTS);` (190), `for (const event of eventsToProcess) {` (205).
Text and postback handlers are launched **without `await`** (243, 250, 257, 261) and the route returns `c.text("OK", 200)` at 274 while they are still running.

Per single text-lookup event (`handleLookupAndReply`, 494-606):

| Call | Line | Fetches |
| --- | --- | --- |
| `showLoadingForChat(ctx)` | 503 | 1 (one-on-one chats only; `line.service.ts:175-178`) |
| `fetchPerformance(lookup)` (wallet) | 509 | 1 |
| `resolveLinkedAccounts(lookup.id)` (account, `T...`) | 510 -> `hfm.service.ts:207,222` | **2** chained |
| `getLastTradeMapWithin(lastTradeDeadlineMs())` | 532 | 0 on a warm cache; up to **3** on a cold or stale cache (`last-trade.service.ts:105-121`) |
| `fetchMonthlyVolumeMap(...)` | 544-545 | 1, only when `FLEX_SUMMARY_VERSION === "flex-v2"` |
| `replyOrPushFlex(...)` | 568-587 -> `line.service.ts:141-147` | 1 reply, plus 1 push fallback when the reply fails = up to **2** |
| error branch `replyOrPushText` | 603-604 | up to 2 (alternative to the flex reply) |
| `notifyRetry` after a thrown handler | 243-245, 294-317 | up to 2 more (reply, then push for one-on-one) |

Worst case for one account lookup event: 1 + 2 + 3 + 1 + 2 + 2 = **11 subrequests**.
Warm-cache worst case: **8**.
The 3 last-trade retries are shared by concurrent events inside one process because of the single-flight guard (`last-trade.service.ts:50-54`), so a full 20-event batch is not 20 x 3.

Worst case per webhook POST, same isolate, cold cache, every event an account lookup with flex-v2 and failing replies:
20 x 8 + 3 = **163 subrequests**; if each event triggered its own retry ladder instead, 20 x 11 = **220**.
Realistic single-event batch (1 wallet lookup, warm cache, flex-v1, successful reply): **3** (loading + performance + reply).

Other event paths:
`report` command (358-393): 1 loading + 1 HFM `fetchClients` + 1 reply, plus up to 2 on the error and retry branches = up to **5**.
`join` (628-672): 1 `fetchGroupSummary` (676) + 1 reply = **2**.
`leave` (685-704): **0** fetches, 1 DB write.
Not-allowed or unparsed text: **1** reply.

## 7. `src/services/last-trade.service.ts` in full

| Item | Line | Value / behaviour |
| --- | --- | --- |
| Cached data | 10, 108-110 | `Map<number, string \| null>` - HFM `account id -> last_trade` built from `fetchClients()` rows (`row.id -> row.last_trade`) |
| Module-level var `cache` | 17 | `CacheEntry \| null` = `{ map, fetchedAt }` (12-15) |
| Module-level var `inflight` | 18 | `Promise<LastTradeMap \| null> \| null`, the single-flight refresh handle |
| TTL | 5, 45 | `FRESH_TTL_MS = 5 * 60 * 1000`; a cache newer than 5 min is returned directly |
| Fetch timeout | 6, 43 | `FETCH_TIMEOUT_MS = 15_000` passed to `fetchClients(...)` (overrides the 120 s default) |
| Retry ladder | 7, 8, 105-121 | `MAX_ATTEMPTS = 3`, `BACKOFF_MS = [1000, 2000]`; worst case 3 x 15 s + 3 s = ~48 s (comment at 68-72) |
| In-flight dedup | 49-54 | `if (!inflight) { inflight = refresh(...).finally(() => { inflight = null; }); }` - concurrent callers share one refresh |
| Stale-while-revalidate | 56-65 | With any cache present, the stale map is returned immediately and the refresh continues in the background with `refreshing.catch(...)` (61). Only a completely cold cache awaits the refresh (65) |
| Deadline variant | 73-98 | `getLastTradeMapWithin(deadlineMs)` races the refresh against a `setTimeout` (84-90). On timeout it logs and resolves `cache?.map ?? null` (89), leaving the refresh running in the background. `clearTimeout` in `finally` (96) |
| Failure semantics | 123-128 | After 3 failed attempts: serve stale cache if any, else `null` |
| Cache write | 111 | `cache = { map, fetchedAt: now() }` - only on a successful fetch |
| Test hook | 29-32 | `resetLastTradeCache()` sets both `cache` and `inflight` to `null` |
| Injection points | 20-24, 40-43 | `fetchClientsFn`, `sleepFn`, `nowMs` options; defaults are the real `fetchClients`, a `setTimeout` sleep (26-27) and `Date.now` |

Workers relevance: both module-level variables are per-isolate, so cache hit rate depends on isolate reuse, and the background refresh started at 51 or left running at 89 outlives the request that created it.

## 8. `/internal` routes

All routes sit behind one middleware: `internal.use("*", ...)` compares `c.req.query("key")` with `process.env.INTERNAL_API_KEY` and returns 401 on mismatch (`src/routes/internal.ts:14-20`).

| Route | Line | What it does | Reads disk? |
| --- | --- | --- | --- |
| `GET /internal/health` | 22-48 | `SELECT 1` through Drizzle (26-27), then `GET {HFM_API_BASE_URL}/api/wallet/balance` with a 5 s `AbortSignal.timeout` (36-40). Returns `{status, checks}` with 200 or 503 (46-47) | no |
| `GET /internal/logs` | 50-53 | `listLogDates()` -> `readdirSync("logs")` | **yes** (`logger.ts:103-111`) |
| `GET /internal/logs/:date` | 55-68 | `readLog(date)` -> `readFileSync` of the newest `log.<date>*.log`, then `parseLog(content, limit)`; limit capped by `MAX_LOG_ENTRIES = 200` (10, 58-61); 404 when no file | **yes** (`logger.ts:46-62`) |
| `GET /internal/line-uids` | 70-80 | `listLineUsers(db)`, truncated at `MAX_LINE_UIDS = 500` (11) | no |
| `GET /internal/line-groups` | 84-93 | `listLineGroups(db)`, truncated at `MAX_LINE_GROUPS = 200` (12). Comment 82-83: the group ID is invisible in the LINE app and is needed for `LINE_GROUP_WHITELIST_IDS` | no |

Subrequests: `/internal/health` makes exactly 1 fetch; the others make 0.

## 9. Test suite shape

24 `*.test.ts` files plus one helper, `tests/db-helpers.ts`.
**No test imports `src/index.ts`.** Every HTTP test builds its own `new Hono()` and mounts the route module directly.

| Test file | Lines | Boots a Hono app | Hits real Postgres | Mutates `process.env` |
| --- | --- | --- | --- | --- |
| `tests/webhook.test.ts` | 2249 | yes - `new Hono()` + `app.route("/webhook", webhookMod.default)` in `importWebhook()` (`:2236-2249`) | yes - `postgres(TEST_DATABASE_URL, { max: 1 })` (`:41`), drops and recreates tables (`:43-53`) | 26 assignments (e.g. `:61-65`, `:2237-2241`), deletions in `afterEach` (`:73-79`) |
| `tests/webhook-logging.test.ts` | 614 | yes (`:115-116`) | yes | 16; also `mock.module("../src/utils/logger", ...)` (`:30`) |
| `tests/line-uids.test.ts` | 316 | yes (4 x `new Hono()`) | yes | 10 |
| `tests/line-groups-endpoint.test.ts` | 81 | yes | yes | 2 |
| `tests/health.test.ts` | 112 | yes - mounts `src/routes/internal` (`:48-50`) | yes (`:20-33`) | 4 (`:16-18`, `:46`) |
| `tests/daily-client-report.test.ts` | 562 | no | yes (`TEST_DATABASE_URL`) | 14 |
| `tests/snapshot.repository.test.ts` | 117 | no | yes | 0 |
| `tests/line-group.repository.test.ts` | 96 | no | yes (via `./db-helpers`) | 0 |
| `tests/line-user.repository.test.ts` | 62 | no | yes | 0 |
| `tests/recipient.repository.test.ts` | 61 | no | yes | 0 |
| `tests/sqlite.service.test.ts` | 81 | no | yes (Postgres despite the name) | 0 |
| `tests/hfm.service.test.ts` | 678 | no | no (stubs `globalThis.fetch`) | 13 |
| `tests/flex-message.builder.test.ts` | 546 | no | no | 8 |
| `tests/whitelist.test.ts` | 193 | no | no | 48 |
| `tests/last-trade.service.test.ts` | 199 | no | no | 0 (injects `fetchClientsFn`, `sleepFn`, `nowMs`) |
| `tests/line.service.test.ts` | 195 | no | no | 0 |
| `tests/hfm-healthcheck.test.ts` | 76 | no | no (injects `db`, `checkHealthyFn`, `pushToAllFn`) | 0 |
| `tests/line-types.test.ts`, `tests/mention.test.ts`, `tests/date.test.ts`, `tests/chat-context.test.ts`, `tests/signature.test.ts`, `tests/rank-tier.test.ts`, `tests/logger.test.ts` | 28-112 each | no | no | 0 |

Counts: **5** test files boot a Hono app; **11** test files talk to a real Postgres (plus the `tests/db-helpers.ts` helper); **0** import `src/index.ts`.

What breaks if env access moves from `process.env` to a Hono context binding:

| Breakage | Evidence |
| --- | --- |
| 141 `process.env.X = ...` assignments across 9 test files would no longer influence the code under test. Heaviest: `tests/whitelist.test.ts` (48), `tests/webhook.test.ts` (26), `tests/webhook-logging.test.ts` (16), `tests/daily-client-report.test.ts` (14), `tests/hfm.service.test.ts` (13), `tests/line-uids.test.ts` (10) | grep of `process.env.\w+\s*=` in `tests/` |
| Pure unit tests that call env-reading functions with no request context would need a new seam: `isWhitelisted`/`isGroupAllowed` (`src/utils/whitelist.ts:27,38`), `getLotDisplayMode` and `getDepositThreshold` (`src/services/hfm.service.ts:69,83`), `getFlexSummaryVersion` (`src/builders/flex-message.builder.ts:40`), `checkConditions` (`:114`) | `tests/whitelist.test.ts`, `tests/hfm.service.test.ts`, `tests/flex-message.builder.test.ts`, `tests/rank-tier.test.ts` |
| `tests/webhook.test.ts:2236-2249` and `tests/health.test.ts:48-50` rely on `await import(...)` after setting env, because the modules read env per call. A context binding changes that contract | those lines |
| `getDb()` resolves `DATABASE_URL` itself (`src/db/connection.ts:13`) while tests set `process.env.DATABASE_URL` then call `resetDbForTests()` (`tests/webhook.test.ts:61,80`). A binding-provided connection needs a different injection path | those lines |
| `src/services/line.service.ts` and `src/services/hfm.service.ts` are plain module functions with no context parameter; every caller signature changes (`line.service.ts:27,48,69,90,163,183`; `hfm.service.ts:20,141,262,299,333,378`) | those lines |
| Jobs read env directly (`daily-client-report.ts:26,29,485`; `hfm-healthcheck.ts:23`) and are invoked from both the webhook and CLI scripts, so they need env from two different sources | those lines |

## 10. Scripts affected

| Script | Workers-relevant content |
| --- | --- |
| `scripts/trigger-daily-client-report.ts` | Calls `runDailyClientReport` (`:22`), `closeDb()` (`:25,27`), `process.exit(1)` (`:25`), `DRY_RUN` env (`:4`) |
| `scripts/trigger-hfm-healthcheck.ts` | `__resetHealthState()` (`:33`), `closeDb()`, `process.exit(1)` (`:42`), `FORCE`/`DRY_RUN` env (`:6-7`) |
| `scripts/fetch-client-performance-range.ts` | `Bun.file`/`Bun.write` to `./output/...` (`:30-31`), `process.exit(1)` (`:16`) |
| `scripts/compare-client-performance-files.ts` | `Bun.file(...).json()` (`:29-30`), file paths from env (`:2-6`) |
| `scripts/seed-mock-client-snapshots.ts` | `Bun.file(...).json()` (`:90`), `getDb()`, `process.exit(1)` (`:94,101,185`) |
| `scripts/playground.ts` | `Bun.file(...).json()` (`:6`) |

## 11. Deployment facts

`Dockerfile` runs `bun run src/index.ts` under `tini` on `oven/bun:1-alpine`, exposes 3000, and copies only `package.json`, `bun.lock`, `tsconfig.json`, `src/`.
`nginx.conf` sits in front of the app.
`package.json` declares `croner`, `pino`, `pino-pretty`, `pino-roll`, `postgres`, `drizzle-orm`, `hono`, `dayjs`; `pino-pretty` and `pino-roll` have no import anywhere in `src/`, `scripts/`, or `tests/`.
