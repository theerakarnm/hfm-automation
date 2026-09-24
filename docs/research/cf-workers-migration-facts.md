# Cloudflare Workers migration facts (HFM-Automation)

Research date: 2026-09-22.
All facts below come from `developers.cloudflare.com` unless marked otherwise.
Every page is readable as Markdown by appending `index.md` to the URL.
Claims that could not be verified from a primary source are marked **UNVERIFIED**.

Context: Bun + Hono + Drizzle(postgres.js) + croner + pino LINE bot, multi-tenant (`maow`, `simple-trade`), 5-minute cron plus a daily fan-out job, 60s LINE reply-token window, ~7s upstream HFM API.

---

## 1. Multi-tenant config: `env.<name>` vs one config file per tenant

Docs: <https://developers.cloudflare.com/workers/wrangler/environments/>, <https://developers.cloudflare.com/workers/wrangler/configuration/#environments>

### How named environments work

A named environment deploys a **separate Worker** named `<top-level-name>-<environment-name>`.
"When you create an environment, Cloudflare effectively creates a new Worker with the name `<top-level-name>-<environment-name>`."
Source: <https://developers.cloudflare.com/workers/wrangler/environments/>

So `name = "hfm-bot"` plus `[env.maow]` deploys a Worker called `hfm-bot-maow`.
You cannot rename it freely unless you set `name` inside the environment block (`name` is inheritable, so it can be overridden per environment).

### Inheritance: the footgun, exactly

Three classes of keys (source: <https://developers.cloudflare.com/workers/wrangler/configuration/#environments>):

**Top-level only** (cannot appear in a named environment):
`keep_vars`, `send_metrics`, `dependencies_instrumentation`, `site` (deprecated).

**Inheritable** (top-level value is used unless the environment overrides it):
`name`, `main`, `compatibility_date`, `account_id`, `compatibility_flags`, `workers_dev`, `preview_urls`, `route`, `routes`, `tsconfig`, `triggers`, `rules`, `build`, `no_bundle`, `find_additional_modules`, `base_dir`, `preserve_file_names`, `minify`, `keep_names`, `logpush`, `limits`, `observability`, `assets`, `exports`, `migrations`, `placement`.

**Non-inheritable** (must be repeated in full inside every environment, otherwise the environment gets nothing):
`define`, `vars`, `durable_objects`, `kv_namespaces`, `r2_buckets`, `ai_search_namespaces`, `ai_search`, `vectorize`, `services`, `queues`, `workflows`, `tail_consumers`, `secrets`, `secrets_store_secrets`.

Critical consequences for this migration:

- `vars` is **non-inheritable**. A top-level `FLEX_SUMMARY_VERSION` is invisible to `env.maow`. Every tenant environment must repeat the whole `vars` map. There is no per-key merge.
- Secrets are per Worker, so they are effectively non-inheritable too: "Like other environment variables, secrets are non-inheritable and must be defined per environment." (<https://developers.cloudflare.com/workers/wrangler/environments/#secrets-for-production>)
- `triggers` (crons) **is** inheritable. If you do not override `triggers` in an environment, every tenant Worker inherits the same cron list. That is usually what you want here, but it also means a top-level cron silently applies to all tenants.
- `route` / `routes` are inheritable, which is dangerous: forgetting `routes` in `env.maow` makes the tenant Worker inherit the top-level route and two Workers fight for the same hostname. The docs state explicitly: "If you are deploying to a Custom Domain or route, you must provide a `route` or `routes` key for each environment." (<https://developers.cloudflare.com/workers/wrangler/environments/#examples>)
- `hyperdrive` is **not listed** in either the inheritable or the non-inheritable enumeration, but the prose says "Bindings, such as `vars` or `kv_namespaces`, are not inheritable and need to be defined explicitly". Treat `hyperdrive` as non-inheritable and always declare it inside each environment. The gap in the enumerated list is **UNVERIFIED**; do not rely on inheritance either way.
- Service bindings that target an environment must use the suffixed name: `service = "worker-a-staging"`. (<https://developers.cloudflare.com/workers/wrangler/environments/#service-bindings>)

### Option (a): one config file, `env.<tenant>` blocks

```jsonc
// wrangler.jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "hfm-bot",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-09-22",
  "observability": { "enabled": true },
  "limits": { "cpu_ms": 300000 },
  "triggers": { "crons": ["*/5 * * * *", "0 1 * * *"] },
  "env": {
    "maow": {
      "name": "hfm-bot-maow",
      "routes": [{ "pattern": "maow-bot.example.com", "custom_domain": true }],
      "vars": {
        "FLEX_SUMMARY_VERSION": "flex-v1",
        "LOT_DISPLAY_MODE": "always",
        "LAST_TRADE_DEADLINE_MS": "8000"
      },
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<MAOW_HYPERDRIVE_ID>" }],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<MAOW_KV_ID>" }]
    },
    "simple-trade": {
      "name": "hfm-bot-simple-trade",
      "routes": [{ "pattern": "simple-bot.example.com", "custom_domain": true }],
      "vars": {
        "FLEX_SUMMARY_VERSION": "flex-v2",
        "LOT_DISPLAY_MODE": "lot_prefix_only",
        "LAST_TRADE_DEADLINE_MS": "8000"
      },
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<SIMPLE_HYPERDRIVE_ID>" }],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<SIMPLE_KV_ID>" }]
    }
  }
}
```

Pros: one file, shared `compatibility_date` / `limits` / `observability` / `triggers` by inheritance, `--env` selects the tenant.
Cons: the non-inheritable set must be duplicated per tenant; a missed key fails silently at runtime (binding is `undefined`), not at deploy time (except `secrets.required`, see Q8).

### Option (b): one config file per tenant, `-c`

```sh
npx wrangler deploy -c wrangler.maow.jsonc
npx wrangler deploy -c wrangler.simple-trade.jsonc
```

`--config` / `-c` is a documented global flag: "Path to Wrangler configuration file" (<https://developers.cloudflare.com/workers/wrangler/commands/general/>).

Pros: zero inheritance surprises; each file is a complete, readable, greppable tenant spec; `name` is fully controlled; diffing two tenants is trivial.
Cons: shared keys (`compatibility_date`, `main`, `limits`) are duplicated and can drift. Mitigate by generating the per-tenant files from one template in a build step, or by keeping a short checklist in code review.

**Recommendation: option (b), one file per tenant** for this migration, because the dangerous keys here (`vars` with feature flags, `hyperdrive`, secrets) are exactly the non-inheritable ones, so option (a) buys almost no reuse while adding a silent-failure mode. If you prefer option (a), add a deploy-time assertion that every expected `vars` key is present.

### Exact CLI syntax

```sh
# deploy (named environment)
npx wrangler deploy --env maow
npx wrangler deploy -e maow
CLOUDFLARE_ENV=maow npx wrangler deploy          # --env takes precedence over CLOUDFLARE_ENV

# deploy (per-tenant config file)
npx wrangler deploy -c wrangler.maow.jsonc

# dry run + bundle size, no upload
npx wrangler deploy --dry-run --outdir bundled/ --env maow

# secrets (per environment == per Worker)
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env maow
echo "$VALUE" | npx wrangler secret put HFM_API_KEY --env maow     # piped input is supported
npx wrangler secret list --env maow
npx wrangler secret delete OLD_KEY --env maow
npx wrangler secret bulk ./secrets.json --env maow

# local dev against one tenant
npx wrangler dev --env maow
npx wrangler dev --env maow --test-scheduled
npx wrangler dev --remote --env maow

# live logs
npx wrangler tail --env maow
npx wrangler tail -c wrangler.maow.jsonc
```

`--env` is documented as a global flag ("Environment to use for operations, and for selecting .env and .dev.vars files"), so it applies to `secret put`, `tail`, `dev`, and `deploy` alike.
Source: <https://developers.cloudflare.com/workers/wrangler/commands/general/> and <https://developers.cloudflare.com/workers/wrangler/commands/workers/>.

`package.json` scripts keep the existing ergonomics:

```json
{
  "scripts": {
    "deploy:maow": "wrangler deploy -c wrangler.maow.jsonc",
    "deploy:simple-trade": "wrangler deploy -c wrangler.simple-trade.jsonc",
    "tail:maow": "wrangler tail -c wrangler.maow.jsonc"
  }
}
```

Note: the repo uses Bun, and `bun run deploy:maow` works, but Wrangler itself is a Node CLI. Whether Wrangler runs correctly under `bun x` in all cases is **UNVERIFIED**; `bun run <script>` that shells out to `wrangler` is the safe form.

Local dev secrets per tenant: put them in `.dev.vars.maow` or `.env.maow`.
"To set different secrets for each Cloudflare environment, create files named `.dev.vars.<environment-name>` or `.env.<environment-name>`."
With `.dev.vars.<env>` only that file is loaded; with `.env` files all matching files merge with precedence `.env.<env>.local` > `.env.local` > `.env.<env>` > `.env`.
Source: <https://developers.cloudflare.com/workers/wrangler/environments/#secrets-in-local-development>

---

## 2. Cron Triggers

Docs: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>, <https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/>

- **Timezone: UTC only.** "Cron Triggers execute on UTC time." There is no timezone option. Asia/Bangkok (UTC+7) schedules must be converted by hand: ICT 08:00 becomes `0 1 * * *`, and the every-5-minutes job is timezone independent (`*/5 * * * *`).
  Any date math inside the handler must convert to ICT in code (for example with `Intl.DateTimeFormat` and `timeZone: "Asia/Bangkok"`).
- **Syntax**: five fields (minute, hour, day-of-month, month, weekday) with Quartz-like extensions `L`, `W`, `#`.
  Weekdays are `1 = Sunday` to `7 = Saturday`, which differs from standard cron. Prefer `MON`, `FRI` style abbreviations.
- **Per environment: yes.** `triggers` is inheritable, and you can override it per environment:

```jsonc
{
  "triggers": { "crons": ["*/5 * * * *", "0 1 * * *"] },
  "env": {
    "maow": { "triggers": { "crons": ["*/5 * * * *", "0 1 * * *"] } },
    "simple-trade": { "triggers": { "crons": ["*/10 * * * *"] } }
  }
}
```

- **Deploy replaces the trigger set.** "When deploying a Worker with Wrangler any previous Cron Triggers are replaced." Propagation of a trigger change can take up to 15 minutes.
- **Handler signature**:

```ts
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // controller.cron         -> the exact cron string, character-for-character
    // controller.type         -> always "scheduled"
    // controller.scheduledTime-> ms since epoch (UTC)
  },
} satisfies ExportedHandler<Env>;
```

Dispatch multiple schedules with `switch (controller.cron)`.
`ctx` here exposes `waitUntil`.
Source: <https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/>

- **CPU and wall time for scheduled events** (<https://developers.cloudflare.com/workers/platform/limits/>):

| Aspect | Value |
| --- | --- |
| Wall time per Cron Trigger invocation | 15 min |
| CPU time per Cron Trigger, interval < 1 hour | 30 seconds (Paid); 10 ms (Free) |
| CPU time per Cron Trigger, interval >= 1 hour | 15 min (Paid) |

So the `*/5 * * * *` job gets 30s CPU; the daily job gets 15 min CPU. Both get 15 min wall time.
Note a docs inconsistency: the pricing page states a flat "Max of 15 minutes of CPU time per Cron Trigger" (<https://developers.cloudflare.com/workers/platform/pricing/#workers>) while the limits page splits by interval. Assume the stricter limits-page value (30s CPU for the 5-minute job) until measured. Whether `limits.cpu_ms` raises the cron CPU limit is **UNVERIFIED**.

- **Local testing**:

```sh
npx wrangler dev --test-scheduled --env maow
curl "http://localhost:8787/cdn-cgi/local/scheduled"
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&time=1745856238000"
```

The documented route is `/cdn-cgi/local/scheduled`.
The older `/__scheduled` path is **not** in current docs; do not use it.
`?format=json` returns `{"outcome":"ok","noRetry":false}`.

- **History**: Cron Events keeps only the 100 most recent invocations; Workers Logs keeps longer (see Q6). Events can take up to 30 minutes to appear for a new or renamed Worker.

---

## 3. Limits that matter

All from <https://developers.cloudflare.com/workers/platform/limits/> unless noted.

| Limit | Workers Free | Workers Paid (Standard) |
| --- | --- | --- |
| CPU time per HTTP request | 10 ms | 5 min max, default 30s |
| CPU time per Cron Trigger | 10 ms | 30s (< 1h interval), 15 min (>= 1h interval) |
| Wall time, HTTP request | no limit | no limit |
| Wall time, Cron Trigger / DO alarm / Queue consumer | 15 min | 15 min |
| Subrequests per invocation | 50 | 10,000 default, configurable up to 10,000,000 |
| Simultaneous open connections | 6 | 6 |
| Memory per isolate | 128 MB | 128 MB |
| `waitUntil` after invocation end | 30s | 30s |
| Worker bundle size (uncompressed) | 64 MiB | 64 MiB |
| Env vars + secrets per Worker | 64 | 128 |
| Variable size | 5 KB | 5 KB |
| Log data per request | 256 KB | 256 KB |
| Cache API calls per request | 50 | 1,000 (shares the subrequest quota) |

Key behaviours:

- **CPU time excludes network wait.** "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time." A 7s upstream call costs ~0 CPU. Billing is per request plus CPU ms, with "No charge or limit for duration" (<https://developers.cloudflare.com/workers/platform/pricing/#workers>). A slow upstream is cheap on Workers.
- **Raise CPU explicitly if needed**:

```jsonc
{ "limits": { "cpu_ms": 300000, "subrequests": 10000 } }
```

`limits` is inheritable and is only enforced on the deployed Worker, not in local dev (<https://developers.cloudflare.com/workers/wrangler/configuration/#limits>).

- **Six simultaneous open connections is the real fan-out constraint.** The limit counts connections "waiting for response headers"; once headers arrive the connection stops counting. A seventh is queued, not failed. `fetch()`, KV get/put/list/delete, Cache API put/match/delete, R2, Queues send, and `connect()` TCP sockets all count. Outbound WebSockets count too.
  Practical effect: the daily fan-out cannot exceed ~6 concurrent in-flight HFM calls while waiting for headers. Set your batch concurrency to 6 or less and do not expect more parallelism from a bigger `Promise.all`.
- **Isolate eviction**: "it is generally advised that you not store mutable state in your global scope unless you have accounted for this contingency" (<https://developers.cloudflare.com/workers/reference/how-workers-works/>). Isolates are evicted for resource pressure at any time.
- **Cross-request state is unsafe**: module-level mutable state causes stale data and "Cannot perform I/O on behalf of a different request" errors (`~/.agents/skills/workers-best-practices/references/runtime-patterns.md`).
- **`ctx.waitUntil`**:
  - Accepts a Promise; the runtime keeps executing it after the response is returned.
  - 30-second budget after invocation end, shared across all `waitUntil()` calls in that invocation. Unsettled promises are cancelled and a warning is logged: `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.`
  - Do not destructure `ctx` (`const { waitUntil } = ctx` throws "Illegal invocation").
  - Work that is neither awaited nor in `waitUntil()` can be cancelled silently when the invocation ends.
  - If work cannot fit in 30s, use Queues.
  Source: <https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil>
- **Handler returns before `waitUntil` finishes**: the response is already sent to the client; the promise keeps running for at most 30 more seconds and is then cancelled. There is no way to send anything more to the original HTTP client.
- **`setTimeout` does not really sleep.** "timers are limited to returning the time of the last I/O. This means that while `setTimeout`, `setInterval`, and `setImmediate` will defer your function execution until after other events have run, they will not delay them for the full time specified." (<https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/>)
  This directly breaks any "sleep N ms between HFM batches" logic copied from the Bun service. The exact runtime behaviour when the Worker is doing real I/O is **UNVERIFIED**; do not rely on `setTimeout` as a rate limiter. Use Queues `delaySeconds` (up to 24h, <https://developers.cloudflare.com/queues/configuration/batching-retries/#delay-messages>) or Workflows `step.sleep` (<https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>) instead.

---

## 4. PostgreSQL from Workers

Docs: <https://developers.cloudflare.com/hyperdrive/>, <https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/>

### What Hyperdrive is

A Cloudflare-managed regional connection pool plus optional query cache in front of your existing Postgres.
It removes per-request TCP + TLS + auth setup cost and keeps a warm pool to the origin database.
Workers connect over the Workers TCP socket API; Hyperdrive gives the Worker a dynamic connection string on the binding.

### Config and binding

```sh
npx wrangler hyperdrive create hfm-maow --connection-string="postgres://user:pass@host:5432/db"
npx wrangler hyperdrive create hfm-maow-fresh --connection-string="..." --caching-disabled
npx wrangler hyperdrive list
npx wrangler hyperdrive update <ID> --caching-disabled
```

```jsonc
{
  "compatibility_date": "2026-09-22",
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_ID>" }
  ]
}
```

Per-tenant separate databases: **yes**. Create one Hyperdrive config per tenant database and bind a different `id` inside each tenant environment or tenant config file. The binding name can stay `HYPERDRIVE` in all tenants so the code never branches.
Limit: 10 Hyperdrive configs per account on Free, 25 on Paid (<https://developers.cloudflare.com/hyperdrive/platform/limits/>).

### Drizzle + postgres.js on Workers

Supported. The driver table lists Postgres.js (minimum `postgres@3.4.4`, the example installs `postgres@>3.4.5`) and Drizzle (minimum `0.26.2`) as supported with Hyperdrive.
`pg` (node-postgres, minimum `8.16.3` for Hyperdrive) is called out as the **recommended** driver: "It has the best compatibility with Hyperdrive's caching". Postgres.js is explicitly "also supported".
Source: <https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/#supported-drivers>

Recommendation: keep `drizzle-orm` but consider moving the driver from `postgres-js` to `node-postgres` (`drizzle-orm/node-postgres`) for best Hyperdrive cache behaviour. Staying on `drizzle-orm/postgres-js` is supported and is the smaller diff.

Required Postgres.js options inside a Worker:

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

// Create the client per request. Hyperdrive owns the real pool.
const sql = postgres(env.HYPERDRIVE.connectionString, {
  max: 5,            // Workers cap concurrent external connections at 6
  fetch_types: false, // saves a round trip when you do not use array types
  prepare: true,      // keep true, otherwise Hyperdrive cannot cache prepared statements
});
const db = drizzle(sql);
```

Source of the option comments: <https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/#postgresjs>

`max: 5` matters because of the six-connection limit in Q3.

### Compatibility flags for the driver

- Compatibility date **>= 2026-08-04**: `nodejs_compat` and `nodejs_compat_v2` are on by default; do not add them.
- Compatibility date **2024-09-23 .. 2026-08-03**: add `"compatibility_flags": ["nodejs_compat"]`.
Source: <https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/#database-drivers-and-nodejs-compatibility>

### Local dev

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:pass@localhost:5432/hfm"
npx wrangler dev --env maow
```

Env var form: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING_NAME>`, and it beats `localConnectionString` in the config file.
With `localConnectionString`, pooling and query caching do **not** apply; the Worker talks to the database directly.
`npx wrangler dev --remote` runs on Cloudflare and does use the deployed Hyperdrive config (pooling and caching active).
Source: <https://developers.cloudflare.com/hyperdrive/configuration/local-development/>

### Pricing tier

Hyperdrive is included in Free and Paid Workers plans. Free is capped at 100,000 database queries per day (reset 00:00 UTC), Paid is unlimited. Pooling and query caching cost nothing extra. Cached queries still count as queries.
Source: <https://developers.cloudflare.com/hyperdrive/platform/pricing/>

### Query caching (read this before enabling)

- On by default. Defaults: `max_age` 60s, `stale_while_revalidate` 15s, `max_age` max 1 hour.
- Hyperdrive does **not** invalidate on write. "A later matching `SELECT` can return the cached result until the configured `max_age` expires."
- `NOW()`, `CURRENT_DATE`, `CURRENT_TIMESTAMP`, `RANDOM()`, `LASTVAL()` and other STABLE/VOLATILE functions make a query uncacheable. Only IMMUTABLE functions are cacheable. Move `NOW()` into application code and pass a parameter.
- SQL comments containing names like `NOW()` also make a query uncacheable; comments otherwise do not change the cache key, so two queries differing only by comment text share one cache entry.
- For reads that must be fresh (auth, whitelist checks, post-write reads), create a second `--caching-disabled` Hyperdrive config and bind it separately.
Source: <https://developers.cloudflare.com/hyperdrive/concepts/query-caching/>

### Hyperdrive limits

| Limit | Free | Paid |
| --- | --- | --- |
| Configs per account | 10 | 25 |
| Initial connection timeout | 15s | 15s |
| Idle connection timeout | 10 min | 10 min |
| Origin connections per config | ~20 | ~100 |
| Max query duration | 60s | 60s |
| Max cached response size | 50 MB | 50 MB |

Source: <https://developers.cloudflare.com/hyperdrive/platform/limits/>

Identify Hyperdrive connections on the origin with `SELECT DISTINCT usename, application_name FROM pg_stat_activity WHERE application_name = 'Cloudflare Hyperdrive'`.

---

## 5. Node compatibility

Docs: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>, <https://developers.cloudflare.com/workers/configuration/compatibility-flags/#nodejs-compatibility-flag>

- **Recommended `compatibility_date`**: today's date for a new project. "When you start your project, you should always set `compatibility_date` to the current date." (<https://developers.cloudflare.com/workers/configuration/compatibility-dates/#setting-compatibility-date>) Cloudflare's own Hyperdrive examples repeat this and show `"compatibility_date": "2026-09-22"`.
- **`nodejs_compat`**: for compatibility dates **>= 2026-08-04**, `nodejs_compat` and `nodejs_compat_v2` are enabled by default and the flags are ignored. "Omit them from new configurations."
  For dates 2024-09-23 .. 2026-08-03, you must add `"compatibility_flags": ["nodejs_compat"]`.
  To disable entirely on a modern date you add both `no_nodejs_compat` and `no_nodejs_compat_v2`.
- **`node:crypto`**: "All `node:crypto` APIs are fully supported in Workers" with these exceptions: `generateKeyPair`/`generateKeyPairSync` do not support DSA or DH, `argon2`/`argon2Sync` unsupported, `ed448`/`x448` curves unsupported, FIPS mode cannot be toggled.
  So `createHmac("sha256", secret)` and `timingSafeEqual` both work for LINE signature validation.
  Source: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/>
  WebCrypto (`crypto.subtle`) is also available without any flag, and `crypto.subtle.timingSafeEqual` is the Workers-native alternative. The best-practices skill recommends hashing both values to a fixed size before a constant-time compare so you do not leak length.
- **`node:fs` DOES work, contrary to the assumption in the task.** "You can use `node:fs` to access a virtual file system in Workers." With `nodejs_compat` and compatibility date `2025-09-01` or later it is on by default. It exposes `/bundle` (read-only, your bundled modules), `/tmp` (writable, in-memory, not durable) and `/dev/null|random|full|zero`.
  Correction to the brief: `node:fs` is available but it is a **memory-backed virtual FS**, not the host disk. There is no real persistent disk. Anything written to `/tmp` dies with the isolate.
  Source: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/>
- **`process.env`**: with `nodejs_compat_populate_process_env` (default for compatibility dates on or after **2025-04-01**), `process.env` is auto-populated with the Worker's vars, secrets and version metadata. Without it, `process.env` starts as an empty object that you can write to, and values persist for the whole isolate (shared across requests).
  `process.env.NODE_ENV` is **statically replaced at build time** by Wrangler and the Vite plugin, so it is not a runtime value.
  Setting a value on `process.env` coerces it to a string. Never replace the whole `process.env` object.
  Source: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/#processenv>
  Recommended: use the `env` handler argument, or `import { env } from "cloudflare:workers"` for module-level access, instead of `process.env`. The current code's `process.env` reads will technically work, but per-tenant config is clearer through `env`.
- **Other supported Node APIs relevant here**: `assert`, `async_hooks`/AsyncLocalStorage, `buffer`, `crypto`, `events`, `http`, `https`, `net`, `path`, `process`, `stream`, `timers`, `url`, `util`, `zlib` are "supported"; `console`, `dns`, `os`, `perf_hooks`, `tls`, `module`, `test` are "partially supported".

---

## 6. Logging and observability

Docs: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>

- **Workers Logs** collects `console.log` output plus invocation logs into your account and gives you a filter/query UI per Worker. New Workers have it enabled by default.
- **Config block** (inheritable, so it applies to every tenant environment unless overridden):

```jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

Per environment:

```jsonc
{ "env": { "maow": { "observability": { "enabled": true, "head_sampling_rate": 1 } } } }
```

Minimum Wrangler version for `observability`: 3.78.6.
Source: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/#enable-workers-logs>, <https://developers.cloudflare.com/workers/wrangler/configuration/#observability>

- **Structured JSON is the recommended pattern.** `console.log({user_id: 123})` produces an indexed field `user_id`; `console.log("user_id: " + 123)` produces an unqueryable message string. Workers Logs extracts and indexes JSON fields with unlimited cardinality.
- **Limits and cost**: 7 day max retention (Paid) / 3 days (Free), 5 billion logs per account per day, 256 KB max single log (truncated with `$cloudflare.truncated = true`), 256 KB total log data per request. Paid includes 20 million log events per month, then $0.60 per additional million.
- **Tail Workers**: a separate Worker with a `tail(events)` handler that receives `console.log` data, exceptions, outcome, and CPU/wall time after each producer invocation. Paid and Enterprise only, billed by CPU time. Configured with the non-inheritable `tail_consumers` key, so declare it per tenant environment.
  Cloudflare now suggests OpenTelemetry export (<https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/>) instead of Tail Workers for Sentry/Grafana/Honeycomb, and calls Tail Workers "the advanced-mode option".
  Source: <https://developers.cloudflare.com/workers/observability/logs/tail-workers/>
- **Logpush**: `"logpush": true` (inheritable) opts a Worker into Workers Trace Events Logpush jobs for the account. Default `false`.
  Source: <https://developers.cloudflare.com/workers/observability/logs/logpush/>, key listed at <https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys>
- **Live tail**: `npx wrangler tail --env maow`.

### Does pino work on Workers?

Effectively no. The pino maintainers state: "We are not testing against Cloudflare Workers, so this is essentially unsupported right now on that platform." (<https://github.com/pinojs/pino/issues/2035>).
pino targets Node streams and `process.stdout`; the browser build may partly work but is not supported by either project.
Cloudflare docs never list pino as supported. Treat any working pino-on-Workers setup as **UNVERIFIED** and unsupported.

**Recommended replacement pattern**: a tiny logger that emits one JSON object per line via `console.log` / `console.error`, keeping the pino-like call shape so the call sites do not change.

```ts
type Level = "debug" | "info" | "warn" | "error";

export function createLogger(base: Record<string, unknown>) {
  const emit = (level: Level, obj: Record<string, unknown>, msg?: string) => {
    const line = { level, time: Date.now(), ...base, ...obj, ...(msg ? { msg } : {}) };
    (level === "error" || level === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (o: Record<string, unknown>, m?: string) => emit("debug", o, m),
    info:  (o: Record<string, unknown>, m?: string) => emit("info", o, m),
    warn:  (o: Record<string, unknown>, m?: string) => emit("warn", o, m),
    error: (o: Record<string, unknown>, m?: string) => emit("error", o, m),
    child: (extra: Record<string, unknown>) => createLogger({ ...base, ...extra }),
  };
}

// per request: const log = createLogger({ tenant: env.TENANT, reqId: crypto.randomUUID() });
```

Keep the logger request-scoped, not module-scoped, so tenant/request fields never leak between requests.
Budget: 256 KB of log data per request; a full HFM payload dump will be truncated.

---

## 7. Replacing the warm in-memory last-trade map

The current design (an in-process map warmed at startup) has no direct equivalent, because:

- Every colo runs its own isolates, and isolates are created and evicted at any time (<https://developers.cloudflare.com/workers/reference/how-workers-works/>).
- There is no startup hook that can do I/O for a long warm-up; module-level mutable state is explicitly discouraged.
- A cron run in one colo cannot warm an isolate serving a webhook in another colo.

Options for a seconds-to-minutes TTL map shared across isolates:

| Option | Read latency | Consistency | Write cost / limits | Fit |
| --- | --- | --- | --- | --- |
| **Module-global map** (best-effort L1) | ~0 | per isolate, unshared | none | Good only as a short in-isolate memo in front of one of the options below. Never the source of truth. |
| **Workers KV** | low after a hot read (cached at the colo) | eventually consistent, up to 60s or more across colos | 1 write per second **per key**; unlimited writes/day on Paid, 1,000/day on Free; 1,000 KV ops per Worker invocation; value <= 25 MiB; `cacheTtl` minimum 30s (default 60s) | Good fit for a whole-map blob refreshed by the 5-minute cron. |
| **Cache API** (`caches.default`) | lowest of the shared options | per-colo only, not replicated | 50 (Free) / 1,000 (Paid) calls per request, shared with the subrequest quota; 512 MB max object | Good as a per-colo cache in front of KV or the DB. Not shared globally. Does not work in the dashboard editor or Playground, or behind Cloudflare Access. |
| **Durable Object** | one network hop to the DO's home colo | strong, single-threaded | no eventual-consistency window; adds latency from distant colos | Use only if you need read-after-write or coordination. Overkill for a TTL map. |
| **Hyperdrive query cache** | Hyperdrive pool latency | `max_age` default 60s, no write invalidation | free with Hyperdrive | Simplest option if the map is just a query result: let Hyperdrive cache the SELECT. |

Key KV facts (<https://developers.cloudflare.com/kv/platform/limits/>, <https://developers.cloudflare.com/kv/concepts/how-kv-works/>):

- "Changes may take up to 60 seconds or more to be visible in other global network locations as their cached versions of the data time out."
- Negative lookups are cached too, so a newly written key can appear missing elsewhere for the same window.
- "Writes to same key: 1 per second" on both plans. A per-account or per-key hot write loop is the wrong shape for KV.
- Default read `cacheTtl` is 60s; minimum settable is 30s.
- KV is described as unsuitable for write-heavy, same-key, tens-to-hundreds-per-second workloads; use Durable Objects for that.

**Recommendation for the last-trade map**: write one JSON blob per tenant from the 5-minute `scheduled()` handler into KV (`await env.CACHE.put("last-trade", json, { expirationTtl: 900 })`), read it in the webhook with `env.CACHE.get("last-trade", { type: "json", cacheTtl: 60 })`, and keep an in-isolate memo of the parsed object for the life of the isolate with an explicit timestamp check.
That matches the existing 5-minute refresh cadence, stays inside the 1-write-per-second-per-key rule, and the up-to-60s eventual consistency is within the existing staleness budget of a 5-minute refresh.
If the map must never be stale, read it from Postgres through a `--caching-disabled` Hyperdrive binding instead.

---

## 8. `vars` vs secrets vs Secrets Store

| Mechanism | Where it lives | Visible? | Per environment? | Use for |
| --- | --- | --- | --- | --- |
| `vars` | plaintext in the Wrangler config file, committed to git, shown in the dashboard | yes, plaintext | **non-inheritable**, repeat per env | feature flags and non-secret tuning: `FLEX_SUMMARY_VERSION`, `LOT_DISPLAY_MODE`, `LAST_TRADE_DEADLINE_MS`, `DEPOSIT_THRESHOLD_*`, `HFM_API_BASE_URL`, whitelist toggles |
| Worker secrets (`wrangler secret put`) | encrypted, per Worker, never shown again after upload | no | per Worker, so per environment | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `HFM_API_KEY`, `INTERNAL_API_KEY`, and the database URL if you are not using a Hyperdrive binding |
| Secrets Store | account-level store, bound per Worker via `secrets_store_secrets` | no | binding is non-inheritable | a secret shared by many Workers or many tenants, managed centrally with its own RBAC |

Docs: <https://developers.cloudflare.com/workers/configuration/secrets/>, <https://developers.cloudflare.com/workers/configuration/environment-variables/>, <https://developers.cloudflare.com/secrets-store/integrations/workers/>

Explicit docs warning: "Do not use `vars` to store sensitive information in your Worker's Wrangler configuration file. Use secrets instead."

Secrets Store binding and access:

```jsonc
{
  "secrets_store_secrets": [
    { "binding": "HFM_API_KEY", "store_id": "<STORE_ID>", "secret_name": "HFM_API_KEY_MAOW" }
  ]
}
```

```sh
npx wrangler secrets-store store create hfm --remote
npx wrangler secrets-store secret create <STORE_ID> --name HFM_API_KEY_MAOW --scopes workers --remote
```

Secrets Store values are read asynchronously: `const key = await env.HFM_API_KEY.get();`.
You cannot read production Secrets Store values from local dev; drop `--remote` for local secrets.

Declare required secrets so a misconfigured tenant fails at deploy time instead of at runtime:

```jsonc
{
  "secrets": { "required": ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "HFM_API_KEY", "INTERNAL_API_KEY"] }
}
```

`secrets` is non-inheritable, so repeat it per tenant environment. When defined, only the listed keys are loaded from `.dev.vars` / `.env`, extra keys are ignored, and missing keys warn.
Source: <https://developers.cloudflare.com/workers/wrangler/configuration/#non-inheritable-keys>

Budget check: 128 variables (vars + secrets) per Worker on Paid, 5 KB per value. The current `.env.example` has roughly 20 keys, so there is plenty of room.

**Recommendation**: feature flags and thresholds in `vars` inside each tenant config; all tokens and API keys as per-Worker secrets; move to Secrets Store only if the same credential must be shared by several tenants and rotated centrally.

---

## 9. Custom domains and routes per tenant

Docs: <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>, <https://developers.cloudflare.com/workers/configuration/routing/routes/>, <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>

Each tenant needs its own LINE webhook URL, so each tenant Worker needs its own hostname.

| Option | What it is | Fit for a LINE webhook |
| --- | --- | --- |
| **Custom Domain** | Cloudflare creates the DNS record and the certificate; the Worker **is** the origin; all paths of the hostname go to the Worker | **Recommended.** `maow-bot.example.com` and `simple-bot.example.com`, one per tenant. |
| **Route** | a URL pattern on an existing proxied hostname; the Worker sits in front of an origin | Use only if an existing origin must stay on the same hostname. Routes cannot be the target of a same-zone `fetch()`. |
| **`workers.dev`** | `<worker-name>.<account-subdomain>.workers.dev`, free automatically | Fine for staging. Cloudflare says: "It's recommended to run production Workers on a Workers route or custom domain, rather than on your `workers.dev` subdomain. Your `workers.dev` subdomain is treated as a Free website and is intended for personal or hobby projects that aren't business-critical." |

Per-environment config (remember `routes` is inheritable, so always set it explicitly per tenant):

```jsonc
{
  "workers_dev": false,
  "env": {
    "maow": {
      "routes": [{ "pattern": "maow-bot.example.com", "custom_domain": true }]
    },
    "simple-trade": {
      "routes": [{ "pattern": "simple-bot.example.com", "custom_domain": true }]
    }
  }
}
```

Route forms (all under `routes`): `{ "pattern": "...", "custom_domain": true }`, `{ "pattern": "sub.example.com/*", "zone_id": "..." }`, `{ "pattern": "sub.example.com/*", "zone_name": "example.com" }`.
Restrictions: a Custom Domain cannot be created on a hostname that already has a CNAME record, or on a zone you do not own. Above roughly 100 custom domains per zone the docs suggest a wildcard route instead.
Custom Domains can be invoked by `fetch()` from within the same zone; routes cannot.
Set `"workers_dev": false` on production tenants so the `*.workers.dev` URL does not become a second, unauthenticated webhook entry point. `workers_dev` and `preview_urls` are inheritable.

The `/internal/*` admin routes ride on the same hostname and stay protected by `INTERNAL_API_KEY`. If you want them unreachable from the public Internet, put them behind Cloudflare Access (note: the Cache API is not available for Workers fronted by Access).

---

## 10. Gotchas for the 60s LINE reply deadline with a ~7s upstream

Ranked by how likely each is to break the migration.

1. **`waitUntil` gives you 30s, not 60s.** The LINE reply token is valid for 60s, but any work moved after the response is capped at 30 seconds total across all `waitUntil()` calls, then cancelled with a logged warning.
   If the design is "ACK the webhook with 200 immediately, then call HFM and push the reply", your real budget is 30s, not 60s, and a slow HFM day (7s plus retries) can silently lose replies.
   Mitigation A: do the work inline inside `fetch()` and return 200 at the end. HTTP-triggered Workers have **no wall-time limit** and network wait costs no CPU time, so a 7-10s inline handler is legal and cheap. The risk moves to LINE's own webhook timeout (see 2).
   Mitigation B: `env.QUEUE.send(...)` in the webhook (one subrequest, milliseconds), return 200, and let a queue consumer call HFM and the LINE reply API. The consumer gets 15 min wall time. Keep the end-to-end path under the 60s reply-token window or fall back to push messages.
   Docs: <https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil>, <https://developers.cloudflare.com/workers/platform/limits/#duration>
2. **LINE's webhook timeout, not Cloudflare's, is the binding constraint on inline work.** Cloudflare imposes no HTTP wall-time limit, so the ceiling comes from LINE. The exact LINE webhook response timeout is **UNVERIFIED** here (not a Cloudflare fact); check the LINE docs before choosing mitigation A. The existing `LAST_TRADE_DEADLINE_MS=8000` budget suggests the current design already assumes a fast ACK.
3. **Only six concurrent connections can wait for response headers.** The daily fan-out and any parallel HFM calls inside the reply path are throttled to 6 in-flight. A `Promise.all` over 20 HFM calls silently serialises into batches of 6. Size batches accordingly and keep `postgres({ max: 5 })`.
   Docs: <https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections>
4. **`setTimeout` is not a reliable sleep.** The documented behaviour is that timers return the time of the last I/O and "will not delay them for the full time specified". The existing "delay between batches" pacing must move to Queues `delaySeconds` or Workflows `step.sleep`.
   Docs: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/>
5. **There is no warm startup cache.** The last-trade map must come from KV, Cache API, a DO, or Hyperdrive's query cache on the first request of every new isolate. Budget one extra round trip in the reply path and keep it inside the deadline. See Q7.
6. **Cron CPU limit for the 5-minute job is 30s, not 15 min.** Wall time is 15 min, but CPU is 30s for intervals under 1 hour. The daily job (interval >= 1 hour) gets 15 min CPU. JSON parsing of large HFM payloads is real CPU. Measure with Workers Logs (`CPU time` appears in invocation logs).
7. **Cron is UTC only.** Convert all Asia/Bangkok schedules by hand and convert dates in code with `timeZone: "Asia/Bangkok"`. A report labelled "today" must compute the ICT day, not the UTC day.
8. **Hyperdrive caches reads for 60s by default and never invalidates on write.** Any read-after-write in the webhook path (for example a whitelist or a state flag just written) can return a stale row. Route those reads through a second `--caching-disabled` Hyperdrive binding.
   Docs: <https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#read-after-write-behavior>
9. **Hyperdrive kills any query over 60s** and the pool can be exhausted by long transactions (`Failed to acquire a connection from the pool.`). Keep the reply path's queries short.
10. **Do not keep request state in module scope.** Isolates are shared across requests and tenants of the same Worker. Cross-request mutable state causes "Cannot perform I/O on behalf of a different request" and data leaks between LINE users.
11. **Cron trigger changes take up to 15 minutes to propagate**, and `wrangler deploy` replaces the whole trigger set. A deploy that omits `triggers` for a tenant removes that tenant's crons.
12. **Log volume**: 256 KB of log data per request. Dumping full HFM responses truncates the log and loses the tail. Log identifiers and durations, not payloads.

---

## Quick verification checklist before the first tenant deploy

```sh
npx wrangler --version                                   # record the version the project pins
npx wrangler deploy --dry-run --outdir bundled/ -c wrangler.maow.jsonc   # bundle size, no upload
npx wrangler dev --test-scheduled -c wrangler.maow.jsonc
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*"
npx wrangler secret list -c wrangler.maow.jsonc
npx wrangler tail -c wrangler.maow.jsonc
```

Wrangler is not currently a dependency of `apps/api` (checked: no `wrangler` in `node_modules`), so the version to pin is **UNVERIFIED**. Install it locally per <https://developers.cloudflare.com/workers/wrangler/install-and-update/> and use the project-local binary rather than a global one.

## Sources

Primary pages used (all readable as Markdown with a trailing `index.md`):

- <https://developers.cloudflare.com/workers/wrangler/environments/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/>
- <https://developers.cloudflare.com/workers/wrangler/commands/workers/>
- <https://developers.cloudflare.com/workers/wrangler/commands/general/>
- <https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/>
- <https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/>
- <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- <https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/>
- <https://developers.cloudflare.com/workers/runtime-apis/context/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/>
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/>
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/>
- <https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/>
- <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- <https://developers.cloudflare.com/workers/configuration/compatibility-flags/>
- <https://developers.cloudflare.com/workers/configuration/secrets/>
- <https://developers.cloudflare.com/workers/configuration/environment-variables/>
- <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
- <https://developers.cloudflare.com/workers/configuration/routing/routes/>
- <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>
- <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- <https://developers.cloudflare.com/workers/observability/logs/tail-workers/>
- <https://developers.cloudflare.com/workers/observability/logs/logpush/>
- <https://developers.cloudflare.com/workers/runtime-apis/cache/>
- <https://developers.cloudflare.com/workers/reference/how-workers-works/>
- <https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/>
- <https://developers.cloudflare.com/hyperdrive/concepts/query-caching/>
- <https://developers.cloudflare.com/hyperdrive/configuration/local-development/>
- <https://developers.cloudflare.com/hyperdrive/platform/limits/>
- <https://developers.cloudflare.com/hyperdrive/platform/pricing/>
- <https://developers.cloudflare.com/kv/platform/limits/>
- <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
- <https://developers.cloudflare.com/queues/configuration/batching-retries/>
- <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>
- <https://developers.cloudflare.com/secrets-store/integrations/workers/>
- <https://github.com/pinojs/pino/issues/2035> (pino on Workers is unsupported)
- Local skill: `~/.agents/skills/workers-best-practices/references/runtime-patterns.md`
