# Multi-tenant LINE OA - Shared Contracts (authoritative)

Every plan part MUST use these exact names, types, signatures, and DDL.
Do not invent alternatives.
If something is missing here, follow the existing code style in `apps/api/src` and state the assumption in your part.

## Decisions already made with the user (do not re-open)

| # | Decision |
| --- | --- |
| Q1 | Tenant is resolved from a query string on the webhook URL: `https://host/webhook?oa=<webhookId>`. A path form `/webhook/<webhookId>` is also supported by the same resolver. |
| Q2 | Config is threaded as an explicit first parameter `ctx: TenantConfig` into every function that used to read `process.env`. No AsyncLocalStorage. |
| Q3 | Every existing table gets `tenant_id`, and every unique key / primary key that could collide across tenants is rebuilt to include `tenant_id`. |
| Q4 | Secrets are encrypted at rest with AES-256-GCM using a master key from env `CONFIG_ENCRYPTION_KEY`. The UI is write-only for secrets: it shows a mask, never the plaintext. |
| Q5 | The internal UI is server-rendered with `hono/jsx`, behind a login that accepts `INTERNAL_API_KEY` and sets an httpOnly cookie. Mutating forms carry a CSRF token. |
| Q6 | On boot, if the `tenants` table is empty, one tenant is seeded from the old env vars. After that, per-tenant env vars are never read again. There is no env fallback. |
| Q7 | Scope is `apps/api` only, including `apps/api/scripts`. `apps/hfm-report` is out of scope. |
| Q8 | `tenants.id` is the internal serial primary key. `tenants.webhook_id` is a random UUID used in the public webhook URL and can be rotated on its own. |
| Q9 | Tenant config is cached in memory, invalidated on save, and additionally expires after 60 seconds. |
| Q10 | The last-trade cache becomes per tenant. Startup warm is sequential, never parallel. |
| Q11 | One healthcheck cron loops all active tenants sequentially. Health state lives in the database, not in a module variable. |
| Q12 | Unknown `oa` id returns 404. Bad signature returns 400. Known but inactive tenant returns 200. |
| Q13 | Notify recipients stay in `notify_recipients` with a `tenant_id`. Whitelist uids move to a new `tenant_whitelist_uids` table. `seedFromEnv` is deleted. |
| Q14 | Schema changes are idempotent SQL inside `initDb()`, guarded with `information_schema` checks. No drizzle-kit migration folder in this plan. |
| Q15 | Missing or invalid `CONFIG_ENCRYPTION_KEY` kills the process at boot. `tenants.key_version` exists from day one. A tenant whose secrets fail to decrypt is marked failed and logged loudly, never skipped silently. |
| Q16 | The daily report moves into an in-process cron at 05:00 Asia/Bangkok that loops active tenants sequentially. The manual script stays for repair runs. |
| Q17 | Fix the broken packaging in the same branch: root `docker-compose.yml` must build, and `apps/api/scripts/` must be present in the image. |
| Q18 | `/internal/health` becomes a liveness check (database and process only, no HFM call), because the docker healthcheck uses it. Per-tenant upstream status moves to `/internal/health/tenants`. |
| Q19 | Raise the container memory limit and keep sequential warm at boot. |
| Q20 | The service stays single instance. Anything that must not happen twice (alerts, daily report) is guarded by database state, not by memory state. |
| Q21 | `hfm_api_base_url` is stored per tenant with a default value. |
| Q22 | Resolution order: resolve tenant from `oa` -> verify the LINE signature with that tenant's secret -> only then compare `destination` against the stored bot user id. |
| Q23 | On save, the server calls `GET /v2/bot/info` to fetch and store `userId`, `basicId`, and `displayName`. |
| Q24 | Connection tests are a button, not a gate. Activation is never blocked. The result is stored and shown in the UI, and a tenant that was never tested shows a warning badge. |
| Q25 | Secret rotation replaces the value immediately. No previous-secret grace window. |
| Q26 | LINE webhook redelivery stays off. No event deduplication is built. |
| Q27 | The UI has three views: list, detail/edit, and per-tenant status. (Recommended default, user did not object.) |

## Facts about the LINE platform that the code must respect

1. The webhook query string survives delivery (verified live), but it is NOT covered by the signature. Only the body is signed. The `oa` value is a routing hint, never an authentication token.
2. `destination` is always present in the webhook body and equals the channel's bot user id.
3. The bot server must answer within 2 seconds, otherwise LINE records `request_timeout`. Tenant resolution must be cache-first.
4. Redelivery is opt-in and off by default, so a non-2xx response does not cause retry storms.
5. Rate limits are per channel, so N tenants on one host do not share a quota.
6. `x-line-signature` header names are case insensitive. Signature = base64(HMAC-SHA256(channelSecret, rawBody)).

## Environment variables after this change

System level, still read from env:

```
DATABASE_URL
TEST_DATABASE_URL
INTERNAL_API_KEY
CONFIG_ENCRYPTION_KEY   # base64, exactly 32 bytes when decoded
PORT
LAST_TRADE_DEADLINE_MS
LOG_LEVEL
```

Read exactly once, only by the bootstrap seed in Task 6, only when the `tenants` table is empty:

```
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
HFM_API_KEY
HFM_API_BASE_URL
TARGET_WALLET
LINE_WHITELIST_ENABLED
LINE_WHITELIST_UIDS
LINE_NOTIFY_UIDS
```

No other code may read these eight variables after this plan is done.
A test asserts this by grepping `apps/api/src`.

## New tables (exact DDL, goes into `initDb()` in `apps/api/src/db/connection.ts`)

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id                            SERIAL PRIMARY KEY,
  webhook_id                    TEXT NOT NULL UNIQUE,
  label                         TEXT NOT NULL,
  active                        INTEGER NOT NULL DEFAULT 0,
  line_channel_access_token_enc TEXT NOT NULL,
  line_channel_secret_enc       TEXT NOT NULL,
  line_bot_user_id              TEXT,
  line_basic_id                 TEXT,
  line_display_name             TEXT,
  hfm_api_key_enc               TEXT NOT NULL,
  hfm_api_base_url              TEXT NOT NULL DEFAULT 'https://api.hfaffiliates.com',
  target_wallet                 INTEGER NOT NULL,
  whitelist_enabled             INTEGER NOT NULL DEFAULT 1,
  key_version                   INTEGER NOT NULL DEFAULT 1,
  last_tested_at                TIMESTAMP,
  last_test_result              TEXT,
  created_at                    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_whitelist_uids (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  line_uid   TEXT NOT NULL,
  label      TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, line_uid)
);

CREATE TABLE IF NOT EXISTS tenant_health_state (
  tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  healthy    INTEGER NOT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT now()
);
```

## Changes to existing tables

| Table | Change |
| --- | --- |
| `client_snapshots` | add `tenant_id`; drop `client_snapshots_snapshot_date_client_id_unique`; add `UNIQUE(tenant_id, snapshot_date, client_id)`; replace `idx_snapshot_date` with `idx_snapshot_tenant_date (tenant_id, snapshot_date)` |
| `notify_recipients` | add `tenant_id`; drop the `line_uid` unique; add `UNIQUE(tenant_id, line_uid)` |
| `daily_report_notifications` | add `tenant_id`; drop the `snapshot_date` primary key; add `PRIMARY KEY (tenant_id, snapshot_date)` |
| `line_users` | add `tenant_id`; drop the `line_uid` primary key; add `PRIMARY KEY (tenant_id, line_uid)` |
| `report_range_snapshots` | add `tenant_id`; drop the old unique; add `UNIQUE(tenant_id, period, from_date, to_date)` |
| `client_request_snapshots` | add `tenant_id`; replace `idx_req_snapshot_date` with `idx_req_snapshot_tenant_date (tenant_id, snapshot_date)` |
| `client_request_snapshot_rows` | no `tenant_id`. It is reached only through `snapshot_id`, and every query joins `client_request_snapshots` which is tenant scoped. |

Backfill rule for every table above: add the column nullable, `UPDATE ... SET tenant_id = <default tenant id>` , then `SET NOT NULL`, then add the foreign key `REFERENCES tenants(id)`.
The default tenant is the row created by the bootstrap seed in Task 6, so the seed runs BEFORE the backfill in `initDb()`.

## Core types (`apps/api/src/types/tenant.types.ts`, created in Task 4)

```ts
export interface TenantTestResult {
  lineOk: boolean;
  hfmOk: boolean;
  walletOk: boolean;
  message: string;
}

// Fully resolved, decrypted, ready to use. This is what every service receives.
export interface TenantConfig {
  id: number;
  webhookId: string;
  label: string;
  active: boolean;
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  lineBotUserId: string | null;
  lineBasicId: string | null;
  lineDisplayName: string | null;
  hfmApiKey: string;
  hfmApiBaseUrl: string;
  targetWallet: number;
  whitelistEnabled: boolean;
  whitelistUids: string[];
  lastTestedAt: string | null;
  lastTestResult: TenantTestResult | null;
}

// Row shape as stored, secrets still encrypted. Repository layer only.
export interface TenantRow {
  id: number;
  webhookId: string;
  label: string;
  active: number;
  lineChannelAccessTokenEnc: string;
  lineChannelSecretEnc: string;
  lineBotUserId: string | null;
  lineBasicId: string | null;
  lineDisplayName: string | null;
  hfmApiKeyEnc: string;
  hfmApiBaseUrl: string;
  targetWallet: number;
  whitelistEnabled: number;
  keyVersion: number;
  lastTestedAt: string | null;
  lastTestResult: string | null;
}

// Plaintext input used by the UI and the bootstrap seed.
export interface TenantInput {
  label: string;
  active: boolean;
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  hfmApiKey: string;
  hfmApiBaseUrl: string;
  targetWallet: number;
  whitelistEnabled: boolean;
}
```

`whitelistUids` is part of `TenantConfig` on purpose: the whitelist check is on the 2-second hot path, so it is loaded and cached together with the config.
Notify uids are NOT in `TenantConfig`; they are loaded per job from `notify_recipients`.

## Module contracts

### `apps/api/src/utils/crypto.ts` (Task 1)

```ts
export const CURRENT_KEY_VERSION = 1;
export function loadEncryptionKey(): Buffer;      // throws if env missing or not 32 bytes
export function encryptSecret(plain: string): string;   // "<ivB64>.<tagB64>.<ctB64>"
export function decryptSecret(encoded: string): string; // throws on tamper or wrong key
export function maskSecret(plain: string): string;      // "abcd...wxyz", never full value
```

### `apps/api/src/repositories/tenant.repository.ts` (Task 4)

```ts
export async function listTenantRows(db: DrizzleDb): Promise<TenantRow[]>;
export async function getTenantRowById(db: DrizzleDb, id: number): Promise<TenantRow | null>;
export async function getTenantRowByWebhookId(db: DrizzleDb, webhookId: string): Promise<TenantRow | null>;
export async function insertTenantRow(db: DrizzleDb, input: TenantInput): Promise<number>;
export async function updateTenantRow(db: DrizzleDb, id: number, input: Partial<TenantInput>): Promise<void>;
export async function updateTenantLineIdentity(db: DrizzleDb, id: number, identity: { userId: string; basicId: string | null; displayName: string | null }): Promise<void>;
export async function updateTenantTestResult(db: DrizzleDb, id: number, result: TenantTestResult): Promise<void>;
export async function rotateWebhookId(db: DrizzleDb, id: number): Promise<string>;
export async function countTenants(db: DrizzleDb): Promise<number>;
export async function listWhitelistUids(db: DrizzleDb, tenantId: number): Promise<string[]>;
export async function addWhitelistUid(db: DrizzleDb, tenantId: number, lineUid: string, label: string | null): Promise<void>;
export async function removeWhitelistUid(db: DrizzleDb, tenantId: number, lineUid: string): Promise<void>;
```

The repository never encrypts or decrypts. It stores and returns `*_enc` strings as they are.

### `apps/api/src/services/tenant-config.service.ts` (Task 5)

```ts
export const TENANT_CACHE_TTL_MS = 60_000;
export async function getTenantByWebhookId(webhookId: string): Promise<TenantConfig | null>;
export async function getTenantById(id: number): Promise<TenantConfig | null>;
export async function listActiveTenants(): Promise<TenantConfig[]>;
export function invalidateTenantCache(tenantId?: number): void; // no arg clears everything
export async function saveTenant(input: TenantInput, id?: number): Promise<number>; // encrypts, writes, invalidates
```

This service is the only place that calls `encryptSecret` / `decryptSecret`.

### Services that gain `ctx: TenantConfig` as first parameter

```ts
// apps/api/src/services/hfm.service.ts
export async function checkHfmApiHealthy(ctx: TenantConfig): Promise<boolean>;
export function checkConditions(ctx: TenantConfig, data: HFMPerformanceData): ConditionCheck;
export async function fetchPerformance(ctx: TenantConfig, lookup: PerformanceLookup): Promise<HFMApiResult>;
export async function resolveLinkedAccounts(ctx: TenantConfig, accountId: number): Promise<HFMApiResult>;
export async function fetchClients(ctx: TenantConfig, timeoutMs?: number): Promise<HFMClientsResult>;
export async function fetchAllClients(ctx: TenantConfig, timeoutMs?: number): Promise<HFMAllClientsResult>;
export async function fetchClientsByRange(ctx: TenantConfig, fromDate: string, toDate: string, timeoutMs?: number): Promise<HFMAllClientsResult>;
// unchanged, pure: extractWalletNumber, parsePerformanceLookup, normalizeClientRow

// apps/api/src/services/line.service.ts
export const pushText: (ctx: TenantConfig, userId: string, text: string) => Promise<void>;
export const pushFlex: (ctx: TenantConfig, userId: string, altText: string, contents: object) => Promise<void>;
export const replyText: (ctx: TenantConfig, replyToken: string, text: string) => Promise<void>;
export const replyTexts: (ctx: TenantConfig, replyToken: string, texts: string[]) => Promise<void>;
export const replyOrPushText: (ctx: TenantConfig, replyToken: string, userId: string, text: string) => Promise<void>;
export const replyOrPushFlex: (ctx: TenantConfig, replyToken: string, userId: string, altText: string, contents: object) => Promise<void>;
export async function showLoading(ctx: TenantConfig, chatId: string, loadingSeconds?: number): Promise<void>;
export async function pushToAll(ctx: TenantConfig, uids: string[], text: string): Promise<void>;
export async function fetchBotInfo(accessToken: string): Promise<{ userId: string; basicId: string | null; displayName: string | null } | null>;

// apps/api/src/utils/whitelist.ts
export function isWhitelisted(ctx: TenantConfig, userId: string): boolean;

// apps/api/src/services/last-trade.service.ts
export async function getLastTradeMap(ctx: TenantConfig, options?: GetLastTradeMapOptions): Promise<LastTradeMap | null>;
export async function getLastTradeMapWithin(ctx: TenantConfig, deadlineMs: number, options?: GetLastTradeMapOptions): Promise<LastTradeMap | null>;
export function resetLastTradeCache(tenantId?: number): void; // no arg clears every tenant

// apps/api/src/jobs/daily-client-report.ts
export async function generateReportForUser(ctx: TenantConfig, options?: RunDailyClientReportOptions): Promise<string[]>;
export async function runDailyClientReport(ctx: TenantConfig, options?: RunDailyClientReportOptions): Promise<void>;

// apps/api/src/jobs/hfm-healthcheck.ts
export async function runHfmHealthCheckForTenant(ctx: TenantConfig, options?: RunHfmHealthCheckOptions): Promise<void>;
export async function runHfmHealthCheckAll(options?: RunHfmHealthCheckOptions): Promise<void>;
// `lastHealthy` module variable and `__resetHealthState` are deleted; state lives in tenant_health_state
```

### Repositories that gain `tenantId`

Every function in `snapshot.repository.ts`, `recipient.repository.ts`, `request-snapshot.repository.ts`, `report-range.repository.ts`, and `line-user.repository.ts` takes `tenantId: number` as the second parameter, right after `db`.
Example: `recordLineUserRequest(db, tenantId, lineUid, eventType)`, `getActiveUids(db, tenantId)`, `countByDate(db, tenantId, date)`.
`seedFromEnv` and `parseNotifyUids` are deleted from `recipient.repository.ts`; add `addRecipient(db, tenantId, lineUid, label)` and `removeRecipient(db, tenantId, lineUid)` for the UI.

### Webhook route contract (`apps/api/src/routes/webhook.ts`)

Both `POST /webhook?oa=<webhookId>` and `POST /webhook/<webhookId>` resolve the same way.

```
1. webhookId = c.req.query("oa") ?? c.req.param("webhookId")
   missing            -> 404 "Not Found"
2. ctx = await getTenantByWebhookId(webhookId)
   null               -> 404 "Not Found"        (log warn with the id)
3. ctx.active === false -> 200 "OK"             (log info, no processing)
4. verifyLineSignature(rawBody, sig, ctx.lineChannelSecret) false -> 400 "Unauthorized"
5. parse JSON, then if ctx.lineBotUserId and body.destination !== ctx.lineBotUserId
                     -> 400 "Wrong channel"     (log error: webhook URL used by another OA)
6. process events with ctx, return 200
```

### Internal routes

```
GET  /internal/login                 login form (no auth)
POST /internal/login                 body key=<INTERNAL_API_KEY>, sets httpOnly cookie `hfm_admin`, redirects to /internal/config
POST /internal/logout                clears the cookie
GET  /internal/config                tenant list
GET  /internal/config/new            create form
GET  /internal/config/:id            edit form (secrets shown masked only)
POST /internal/config/:id            save (CSRF protected)
POST /internal/config/:id/test       run connection test, store result, redirect back
POST /internal/config/:id/rotate     rotate webhook_id
GET  /internal/config/:id/status     per-tenant status page
GET  /internal/health                liveness: database + process only
GET  /internal/health/tenants        per-tenant status as JSON, read from tenant_health_state
GET  /internal/logs, /internal/logs/:date, /internal/line-uids   unchanged apart from tenant scoping
```

The existing `?key=` middleware stays valid for the machine-readable routes (`/internal/health`, `/internal/logs*`, `/internal/line-uids`) because the docker healthcheck uses it.
The cookie is accepted as an alternative on those routes and is the only accepted credential on `/internal/config*`.

## Repository conventions the plan must follow

- Runtime is Bun. Never write `npm`, `yarn`, or `node` commands. Tests are `bun test`, run from `apps/api`.
- Tests live in `apps/api/tests/*.test.ts` and use `bun:test` (`test`, `expect`, `describe`, `beforeEach`, `afterEach`).
- Database tests use a real PostgreSQL at `TEST_DATABASE_URL`, started with `docker compose up -d postgres-test` from the repo root. `apps/api/tests/db-helpers.ts` drops and recreates tables. Any new table must be added to the drop list and to the create block in `db-helpers.ts`.
- Never hand-edit generated files. There is no `apps/api/drizzle/` folder and this plan does not create one.
- Commits are conventional and short: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, subject under 50 characters, imperative, no co-author lines.
- Never use the em dash character in any file you write. Use a plain dash.
- In Markdown files, put each full sentence on its own line.
- Keep the existing explanatory comments about timing budgets and upstream API quirks. Update them when the reason changes, never delete them.
- Run `bun test` and `bun run typecheck` from `apps/api` before every commit.
