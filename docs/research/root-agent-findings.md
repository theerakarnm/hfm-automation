# Root-agent findings (raw) - 2026-09-22

## Blockers found by direct reading

1. src/index.ts: module-level `const db = getDb(); await initDb(db);` - top-level await + I/O at
   global scope. Illegal/unsafe on Workers. `initDb` runs raw CREATE TABLE DDL on every boot.
2. src/index.ts: `process.on("SIGTERM"/"SIGINT")` + `process.exit` shutdown. No such lifecycle on Workers.
3. src/index.ts: `getLastTradeMap()` warm at module load (fire-and-forget promise at global scope).
4. src/index.ts exports `{ port, fetch }` (Bun.serve shape). Workers needs
   `export default { fetch(req, env, ctx), scheduled(event, env, ctx) }`.
5. **src/routes/webhook.ts:205-260 returns `c.text("OK", 200)` while event handlers run as FLOATING
   promises** (`processTextEvent(...).catch(...)`, `void notifyRetry(...)`, `recordLineUserRequest(...).catch`).
   On Workers the isolate can be killed once the Response is returned -> replies silently lost.
   MUST be wrapped in `ctx.waitUntil()`. Highest-risk correctness issue in the whole migration.
6. src/jobs/index.ts: croner `new Cron("*/5 * * * *", {timezone:"Asia/Bangkok"})` -> Cron Triggers (UTC only).
7. src/jobs/hfm-healthcheck.ts: module-level `let lastHealthy = true` edge-detection state.
   Isolates are not durable -> duplicate "HFM down" alerts. Must move to DB/KV.
8. src/services/last-trade.service.ts: module-level `cache` + `inflight` singletons, 5min TTL,
   stale-while-revalidate, 3-attempt retry ladder (~48s worst case), 15s fetch timeout.
   Isolate-local only on Workers -> cold isolate = 7s+ blocking hit inside the 60s reply window.
9. src/utils/logger.ts: pino + `node:fs` (existsSync/readdirSync/readFileSync) + `node:path`.
   pino-roll writes to ./logs. No filesystem on Workers.
10. src/routes/internal.ts: GET /logs and GET /logs/:date read log files from disk. Dead on Workers.
11. src/db/connection.ts: module singleton `postgres(url, { max: 10 })`. Needs Hyperdrive +
    per-invocation client, `max` lowered, `fetch_types:false`, `ctx.waitUntil(sql.end())`.
12. src/utils/signature.ts: `node:crypto` createHmac/timingSafeEqual + `Buffer`. Needs nodejs_compat
    or a WebCrypto rewrite.
13. src/jobs/daily-client-report.ts:253-273 retry loop with `setTimeout` sleeps of attempt*5000ms
    (5s+10s+15s...). Burns wall time inside a scheduled invocation.

## Env vars read in src/ (root-agent pass)

SECRETS: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, HFM_API_KEY, INTERNAL_API_KEY, DATABASE_URL
VARS/FLAGS: HFM_API_BASE_URL, TARGET_WALLET, DEPOSIT_THRESHOLD_USD, DEPOSIT_THRESHOLD_USC,
  LINE_WHITELIST_ENABLED, LINE_WHITELIST_UIDS, LINE_GROUP_WHITELIST_ENABLED, LINE_GROUP_WHITELIST_IDS,
  LINE_NOTIFY_UIDS, LAST_TRADE_DEADLINE_MS, FLEX_SUMMARY_VERSION, LOT_DISPLAY_MODE, LOG_LEVEL
DROPPED ON WORKERS: PORT, NODE_ENV
~150 process.env call sites in tests/ - tests mutate process.env directly, so the config layer must
keep a process.env fallback or tests all need rewriting.

## Tenancy
Tenants: maow, simple-trade. Same code, different flag values (FLEX_SUMMARY_VERSION=flex-v1/flex-v2),
different LINE channel, likely different HFM key + DB + TARGET_WALLET + whitelists.
Required commands: `bun run deploy:maow`, `bun run deploy:simple-trade`.
