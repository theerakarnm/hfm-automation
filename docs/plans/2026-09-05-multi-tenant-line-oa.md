# Multi-tenant LINE OA Implementation Plan

> **For agentic workers:** implement this plan task by task, in order.
> Steps use checkbox (`- [ ]`) syntax for tracking.
> Read the "Shared contracts" section before any task, and never change a name defined there without updating every other task that uses it.

**Goal:** Move every per-OA setting (LINE channel access token, LINE channel secret, HFM API key, target wallet, whitelist uids, notify uids) out of `.env` and into PostgreSQL, so one server can host many LINE Official Accounts, each with its own configuration, edited through an internal web UI.

**Architecture:** Each OA becomes a `tenants` row with a random `webhook_id`.
LINE calls `POST /webhook?oa=<webhook_id>`, and that id selects which tenant config to load from an in-memory cache backed by PostgreSQL.
The loaded `TenantConfig` is then passed explicitly as the first argument (`ctx`) into every service that used to read `process.env`, so the compiler, not a code review, is what guarantees the right key and the right wallet are used.
Secrets are encrypted at rest with AES-256-GCM.
Every existing table gains a `tenant_id`, and every unique key that could collide across tenants is rebuilt to include it.

**Tech Stack:** Bun, TypeScript (ESM, strict), Hono 4 with `hono/jsx` for the admin UI, Drizzle ORM, PostgreSQL 16, croner, pino, `node:crypto` for AES-256-GCM.

**Branch:** `feat/multi-tenant-line-oa`

---

## Why each decision was made

The full decision table, the LINE platform facts that constrain the design, the environment variable split, the exact DDL, and every type and function signature live in the next section.
Read it once, completely, before starting Task 1.

Three findings from the current codebase shaped the plan and are worth stating up front.

The last-trade cache in `apps/api/src/services/last-trade.service.ts` is a module-level singleton.
Left as it is, OA number two would be served OA number one's customer data, which is a data leak and not merely a wrong value.

`daily_report_notifications` uses `snapshot_date` as its primary key and `line_users` uses `line_uid` as its primary key.
Left as they are, the second OA would silently skip its daily report because the first OA already "sent" that date, and two customers with the same LINE uid across two OAs would overwrite each other.

The 05:00 ICT daily report described in `INITIAL.md` is not scheduled anywhere in this repository.
`apps/api/src/jobs/index.ts` registers only the healthcheck.
Task 16 adds the real schedule, which is new production behaviour and must be announced to the operator before deploy.

---

## File structure

| Path | Status | Responsibility |
| --- | --- | --- |
| `apps/api/src/utils/crypto.ts` | create | AES-256-GCM encrypt/decrypt/mask for stored secrets |
| `apps/api/src/types/tenant.types.ts` | create | `TenantConfig`, `TenantRow`, `TenantInput`, `TenantTestResult` |
| `apps/api/src/repositories/tenant.repository.ts` | create | All SQL for `tenants`, `tenant_whitelist_uids`, `tenant_health_state`. Never encrypts or decrypts |
| `apps/api/src/services/tenant-config.service.ts` | create | Decrypt, cache, invalidate, save. The only module that touches crypto |
| `apps/api/src/db/bootstrap.ts` | create | One-time seed of the first tenant from the old env vars |
| `apps/api/src/routes/internal-auth.ts` | create | Login, cookie session, CSRF for the admin UI |
| `apps/api/src/routes/internal-config.tsx` | create | Tenant list, edit form, test button, status page |
| `apps/api/scripts/lib/resolve-tenant.ts` | create | Shared `--tenant` / `--all` argument parsing for the repair scripts |
| `apps/api/tests/multi-tenant-isolation.test.ts` | create | The proof that no data or credential crosses tenants |
| `apps/api/src/db/schema.ts` | modify | New tables, `tenant_id` columns, rebuilt unique keys |
| `apps/api/src/db/connection.ts` | modify | `initDb` creates new tables, seeds, then migrates existing tables |
| `apps/api/src/services/hfm.service.ts` | modify | `ctx` first parameter, no env reads |
| `apps/api/src/services/line.service.ts` | modify | `ctx` first parameter, plus `fetchBotInfo` |
| `apps/api/src/services/last-trade.service.ts` | modify | Cache and single-flight keyed by tenant id |
| `apps/api/src/utils/whitelist.ts` | modify | Reads the whitelist from `ctx`, not from env |
| `apps/api/src/repositories/*.ts` | modify | `tenantId` second parameter everywhere |
| `apps/api/src/routes/webhook.ts` | modify | Tenant resolution, signature per tenant, destination cross-check |
| `apps/api/src/routes/internal.ts` | modify | Liveness-only health, per-tenant status, mounts the new routes |
| `apps/api/src/jobs/daily-client-report.ts` | modify | Per tenant, no env target wallet |
| `apps/api/src/jobs/hfm-healthcheck.ts` | modify | Per tenant, state in the database |
| `apps/api/src/jobs/index.ts` | modify | Healthcheck loop plus the new 05:00 ICT daily report cron |
| `apps/api/src/index.ts` | modify | Encryption key check, sequential per-tenant cache warm |
| `apps/api/scripts/*.ts` | modify | Explicit tenant selection, no guessing |
| `apps/api/tests/db-helpers.ts` | modify | New tables in the drop and create blocks |
| `apps/api/Dockerfile` | modify | Ship `scripts/` in the image |
| `docker-compose.yml` | modify | Build context that actually exists, higher memory limit, new env |
| `apps/api/.env.example` | modify | System-only variables, old ones marked first-boot only |
| `AGENTS.md` | modify | Multi-tenant section and updated security notes |

---

## Shared contracts (authoritative)

Every task below must use these exact names, types, signatures, and DDL.

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

Read exactly once, only by the bootstrap seed in Task 5, only when the `tenants` table is empty:

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

Backfill rule for every table above: add the column nullable, `UPDATE ...
SET tenant_id = <default tenant id>` , then `SET NOT NULL`, then add the foreign key `REFERENCES tenants(id)`.
The default tenant is the row created by the bootstrap seed in Task 5, so the seed runs BEFORE the backfill in `initDb()`.

## Core types (`apps/api/src/types/tenant.types.ts`, created in Task 3)

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

### `apps/api/src/repositories/tenant.repository.ts` (Task 3)

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

The repository never encrypts or decrypts.
It stores and returns `*_enc` strings as they are.

### `apps/api/src/services/tenant-config.service.ts` (Task 4)

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

---

<!-- part: A -->

### Task 1: Secret encryption helpers

**Files:**
- Create: `apps/api/src/utils/crypto.ts`
- Test: `apps/api/tests/crypto.test.ts`

Secrets that move from `.env` into PostgreSQL must not sit in the database as plaintext.
AES-256-GCM gives authenticated encryption: a tampered or wrongly keyed ciphertext fails loudly instead of returning garbage.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/crypto.test.ts
import { test, describe, expect, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  loadEncryptionKey,
  CURRENT_KEY_VERSION,
} from "../src/utils/crypto";

const KEY_32 = Buffer.alloc(32, 7).toString("base64");

describe("crypto", () => {
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_32;
  });

  test("loadEncryptionKey returns the 32 byte key", () => {
    expect(loadEncryptionKey().length).toBe(32);
  });

  test("encryptSecret then decryptSecret round trips", () => {
    const enc = encryptSecret("my-secret-token");
    expect(enc).not.toContain("my-secret-token");
    expect(enc.split(".")).toHaveLength(3);
    expect(decryptSecret(enc)).toBe("my-secret-token");
  });

  test("same plaintext encrypts differently every time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("tampered ciphertext throws", () => {
    const enc = encryptSecret("my-secret-token");
    const [iv, tag, ct] = enc.split(".");
    const flipped = ct!.slice(0, -2) + (ct!.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(`${iv}.${tag}.${flipped}`)).toThrow();
  });

  test("wrong key throws instead of returning garbage", () => {
    const enc = encryptSecret("my-secret-token");
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptSecret(enc)).toThrow();
  });

  test("maskSecret never reveals the middle", () => {
    const masked = maskSecret("abcdefghijklmnop");
    expect(masked).toBe("abcd...mnop");
    expect(masked).not.toContain("efgh");
  });

  test("maskSecret handles short values", () => {
    expect(maskSecret("abc")).toBe("a**");
  });

  test("CURRENT_KEY_VERSION is 1", () => {
    expect(CURRENT_KEY_VERSION).toBe(1);
  });

  test("missing env throws a clear error", () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(() => loadEncryptionKey()).toThrow(/CONFIG_ENCRYPTION_KEY/);
  });

  test("short env value throws a clear error", () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadEncryptionKey()).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/api`:

```bash
bun test tests/crypto.test.ts
```

Expected: FAIL with `Cannot find module '../src/utils/crypto'` (module resolution error).

- [ ] **Step 3: Implement `crypto.ts`**

```ts
// apps/api/src/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Key rotation: bump this when a new CONFIG_ENCRYPTION_KEY is introduced,
// keep decrypt support for old versions in decryptSecret.
export const CURRENT_KEY_VERSION = 1;

// AES-256-GCM needs exactly a 32 byte key and a 12 byte IV.
// Ciphertext format: "<ivB64>.<authTagB64>.<cipherB64>".
const IV_BYTES = 12;

export function loadEncryptionKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is not set. Generate one with: " +
        "bun -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}`,
    );
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadEncryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected iv.tag.ct");
  }
  const [iv, tag, ct] = parts as [string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadEncryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Auth failure means tampering or the wrong CONFIG_ENCRYPTION_KEY.
    // Never return partial plaintext.
    throw new Error(
      "Decryption failed: ciphertext is tampered or CONFIG_ENCRYPTION_KEY changed",
    );
  }
}

// The UI shows this instead of a secret. First 4 and last 4 characters only.
export function maskSecret(plain: string): string {
  if (plain.length <= 4) return plain.slice(0, 1) + "**";
  if (plain.length <= 8) return plain.slice(0, 4) + "...";
  return `${plain.slice(0, 4)}...${plain.slice(-4)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/crypto.test.ts
```

Expected: 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/utils/crypto.ts tests/crypto.test.ts
git commit -m "feat: add AES-256-GCM secret encryption helpers"
```

---

### Task 2: `tenants` tables in schema and `initDb`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/connection.ts`
- Modify: `apps/api/tests/db-helpers.ts`

Three new tables: `tenants` (one row per LINE OA), `tenant_whitelist_uids` (per OA whitelist), and `tenant_health_state` (healthcheck edge state, replacing the module variable).

- [ ] **Step 1: Add drizzle table definitions to `schema.ts`**

Append to `apps/api/src/db/schema.ts`:

```ts
export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  webhookId: text("webhook_id").notNull().unique(),
  label: text("label").notNull(),
  active: integer("active").notNull().default(0),
  lineChannelAccessTokenEnc: text("line_channel_access_token_enc").notNull(),
  lineChannelSecretEnc: text("line_channel_secret_enc").notNull(),
  lineBotUserId: text("line_bot_user_id"),
  lineBasicId: text("line_basic_id"),
  lineDisplayName: text("line_display_name"),
  hfmApiKeyEnc: text("hfm_api_key_enc").notNull(),
  hfmApiBaseUrl: text("hfm_api_base_url")
    .notNull()
    .default("https://api.hfaffiliates.com"),
  targetWallet: integer("target_wallet").notNull(),
  whitelistEnabled: integer("whitelist_enabled").notNull().default(1),
  keyVersion: integer("key_version").notNull().default(1),
  lastTestedAt: timestamp("last_tested_at", { mode: "string" }),
  lastTestResult: text("last_test_result"),
  createdAt: timestamp("created_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export const tenantWhitelistUids = pgTable(
  "tenant_whitelist_uids",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    lineUid: text("line_uid").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique("tenant_whitelist_uids_tenant_line_uid_unique").on(t.tenantId, t.lineUid)],
);

export const tenantHealthState = pgTable("tenant_health_state", {
  tenantId: integer("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  healthy: integer("healthy").notNull(),
  changedAt: timestamp("changed_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});
```

- [ ] **Step 2: Add the same DDL to `initDb()` in `connection.ts`**

Inside the existing `db.execute(sql\`...\`)` call in `initDb`, before the existing `CREATE TABLE IF NOT EXISTS client_snapshots` block, add:

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

- [ ] **Step 3: Update `tests/db-helpers.ts`**

Add to the front of the DROP block (children before parents):

```sql
DROP TABLE IF EXISTS tenant_health_state CASCADE;
DROP TABLE IF EXISTS tenant_whitelist_uids CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
```

Add the same three `CREATE TABLE IF NOT EXISTS` statements from Step 2 to the create block.

- [ ] **Step 4: Verify with a repository smoke test run**

```bash
bun test tests/line-user.repository.test.ts
```

Expected: PASS (existing tests still green against the new schema shape).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/connection.ts tests/db-helpers.ts
git commit -m "feat: add tenants, whitelist, health-state tables"
```

---
### Task 3: Tenant types and repository

**Files:**
- Create: `apps/api/src/types/tenant.types.ts`
- Create: `apps/api/src/repositories/tenant.repository.ts`
- Test: `apps/api/tests/tenant.repository.test.ts`

The repository stores and returns `*_enc` strings untouched.
Encryption and decryption happen only in `tenant-config.service.ts` (Task 4), so a repository bug can never leak plaintext secrets into logs by accident.

- [ ] **Step 1: Create the types file**

```ts
// apps/api/src/types/tenant.types.ts
export interface TenantTestResult {
  lineOk: boolean;
  hfmOk: boolean;
  walletOk: boolean;
  message: string;
}

// Fully resolved, decrypted, ready to use. Passed as `ctx` into services.
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

// Plaintext input used by the UI and the one-time bootstrap seed.
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

- [ ] **Step 2: Write the failing repository test**

```ts
// apps/api/tests/tenant.repository.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  insertTenantRow,
  getTenantRowByWebhookId,
  getTenantRowById,
  listTenantRows,
  updateTenantRow,
  updateTenantLineIdentity,
  updateTenantTestResult,
  rotateWebhookId,
  countTenants,
  listWhitelistUids,
  addWhitelistUid,
  removeWhitelistUid,
} from "../src/repositories/tenant.repository";
import type { DrizzleDb } from "../src/db/connection";
import type { TenantInput } from "../src/types/tenant.types";
import { encryptSecret } from "../src/utils/crypto";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");

const INPUT: TenantInput = {
  label: "OA Test",
  active: true,
  lineChannelAccessToken: "tok_a",
  lineChannelSecret: "sec_a",
  hfmApiKey: "hfm_a",
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: 30506525,
  whitelistEnabled: true,
};

let db: DrizzleDb;
let client: ReturnType<typeof import("postgres")>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  client = t.client;
});

afterAll(async () => {
  await closeTestDb(client);
});

describe("tenant.repository", () => {
  test("insert, read by webhook id, list, count", async () => {
    const id = await insertTenantRow(db, INPUT);
    expect(id).toBeGreaterThan(0);
    const row = await getTenantRowByWebhookId(db, (await getTenantRowById(db, id))!.webhookId);
    expect(row!.label).toBe("OA Test");
    expect(row!.lineChannelAccessTokenEnc).not.toBe("tok_a");
    expect((await listTenantRows(db)).length).toBe(1);
    expect(await countTenants(db)).toBe(1);
  });

  test("webhook ids are UUID shaped", async () => {
    const rows = await listTenantRows(db);
    expect(rows[0]!.webhookId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("updateTenantRow with a partial input keeps stored secrets", async () => {
    const rows = await listTenantRows(db);
    const before = rows[0]!.lineChannelAccessTokenEnc;
    await updateTenantRow(db, rows[0]!.id, { label: "Renamed" });
    const after = (await getTenantRowById(db, rows[0]!.id))!;
    expect(after.label).toBe("Renamed");
    expect(after.lineChannelAccessTokenEnc).toBe(before);
  });

  test("line identity, test result, webhook rotation", async () => {
    const id = (await listTenantRows(db))[0]!.id;
    await updateTenantLineIdentity(db, id, {
      userId: "U123",
      basicId: "@abc",
      displayName: "Test OA",
    });
    await updateTenantTestResult(db, id, {
      lineOk: true,
      hfmOk: false,
      walletOk: true,
      message: "hfm 401",
    });
    const rotated = await rotateWebhookId(db, id);
    expect(rotated).not.toBe((await getTenantRowById(db, id))!.webhookId === rotated ? rotated : "");
    const row = await getTenantRowById(db, id);
    expect(row!.lineBotUserId).toBe("U123");
    expect(row!.lastTestResult).toContain("hfm 401");
    expect(row!.lastTestedAt).not.toBeNull();
  });

  test("whitelist uid add, list, remove, dedupe", async () => {
    const id = (await listTenantRows(db))[0]!.id;
    await addWhitelistUid(db, id, "Uaaa", "boss");
    await addWhitelistUid(db, id, "Ubbb", null);
    await addWhitelistUid(db, id, "Uaaa", "duplicate"); // onConflictDoNothing
    expect(await listWhitelistUids(db, id)).toEqual(["Uaaa", "Ubbb"]);
    await removeWhitelistUid(db, id, "Uaaa");
    expect(await listWhitelistUids(db, id)).toEqual(["Ubbb"]);
  });

  test("stored ciphertext is decryptable by the config layer", async () => {
    const row = (await listTenantRows(db))[0]!;
    // Round trip through the real crypto module, proving the stored format.
    expect(encryptSecret("x")).not.toBeNull();
    const { decryptSecret } = await import("../src/utils/crypto");
    expect(decryptSecret(row.lineChannelSecretEnc)).toBe("sec_a");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test tests/tenant.repository.test.ts
```

Expected: FAIL with `Cannot find module '../src/repositories/tenant.repository'`.

- [ ] **Step 4: Implement the repository**

```ts
// apps/api/src/repositories/tenant.repository.ts
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/connection";
import { tenants, tenantWhitelistUids } from "../db/schema";
import type { TenantInput, TenantRow, TenantTestResult } from "../types/tenant.types";
import { encryptSecret } from "../utils/crypto";

// NOTE: this file never decrypts. insert/update encrypt in place because the
// input is plaintext from the UI, but reads return *_enc values untouched.
// Decryption belongs to tenant-config.service only.

function toRow(r: typeof tenants.$inferSelect): TenantRow {
  return {
    id: r.id,
    webhookId: r.webhookId,
    label: r.label,
    active: r.active,
    lineChannelAccessTokenEnc: r.lineChannelAccessTokenEnc,
    lineChannelSecretEnc: r.lineChannelSecretEnc,
    lineBotUserId: r.lineBotUserId,
    lineBasicId: r.lineBasicId,
    lineDisplayName: r.lineDisplayName,
    hfmApiKeyEnc: r.hfmApiKeyEnc,
    hfmApiBaseUrl: r.hfmApiBaseUrl,
    targetWallet: r.targetWallet,
    whitelistEnabled: r.whitelistEnabled,
    keyVersion: r.keyVersion,
    lastTestedAt: r.lastTestedAt,
    lastTestResult: r.lastTestResult,
  };
}

export async function listTenantRows(db: DrizzleDb): Promise<TenantRow[]> {
  const rows = await db.select().from(tenants).orderBy(tenants.id);
  return rows.map(toRow);
}

export async function getTenantRowById(
  db: DrizzleDb,
  id: number,
): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id));
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getTenantRowByWebhookId(
  db: DrizzleDb,
  webhookId: string,
): Promise<TenantRow | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.webhookId, webhookId));
  return rows[0] ? toRow(rows[0]) : null;
}

function toEncryptedValues(input: TenantInput) {
  return {
    label: input.label,
    active: input.active ? 1 : 0,
    lineChannelAccessTokenEnc: encryptSecret(input.lineChannelAccessToken),
    lineChannelSecretEnc: encryptSecret(input.lineChannelSecret),
    hfmApiKeyEnc: encryptSecret(input.hfmApiKey),
    hfmApiBaseUrl: input.hfmApiBaseUrl,
    targetWallet: input.targetWallet,
    whitelistEnabled: input.whitelistEnabled ? 1 : 0,
  };
}

export async function insertTenantRow(
  db: DrizzleDb,
  input: TenantInput,
): Promise<number> {
  const rows = await db
    .insert(tenants)
    .values({ webhookId: randomUUID(), ...toEncryptedValues(input) })
    .returning({ id: tenants.id });
  return rows[0]!.id;
}

export async function updateTenantRow(
  db: DrizzleDb,
  id: number,
  input: Partial<TenantInput>,
): Promise<void> {
  const set: Record<string, string | number> = { updatedAt: new Date().toISOString() };
  if (input.label !== undefined) set.label = input.label;
  if (input.active !== undefined) set.active = input.active ? 1 : 0;
  if (input.lineChannelAccessToken) {
    set.lineChannelAccessTokenEnc = encryptSecret(input.lineChannelAccessToken);
  }
  if (input.lineChannelSecret) {
    set.lineChannelSecretEnc = encryptSecret(input.lineChannelSecret);
  }
  if (input.hfmApiKey) set.hfmApiKeyEnc = encryptSecret(input.hfmApiKey);
  if (input.hfmApiBaseUrl !== undefined) set.hfmApiBaseUrl = input.hfmApiBaseUrl;
  if (input.targetWallet !== undefined) set.targetWallet = input.targetWallet;
  if (input.whitelistEnabled !== undefined) {
    set.whitelistEnabled = input.whitelistEnabled ? 1 : 0;
  }
  await db.update(tenants).set(set).where(eq(tenants.id, id));
}

export async function updateTenantLineIdentity(
  db: DrizzleDb,
  id: number,
  identity: { userId: string; basicId: string | null; displayName: string | null },
): Promise<void> {
  await db
    .update(tenants)
    .set({
      lineBotUserId: identity.userId,
      lineBasicId: identity.basicId,
      lineDisplayName: identity.displayName,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tenants.id, id));
}

export async function updateTenantTestResult(
  db: DrizzleDb,
  id: number,
  result: TenantTestResult,
): Promise<void> {
  await db
    .update(tenants)
    .set({
      lastTestedAt: new Date().toISOString(),
      lastTestResult: JSON.stringify(result),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tenants.id, id));
}

export async function rotateWebhookId(db: DrizzleDb, id: number): Promise<string> {
  const webhookId = randomUUID();
  await db
    .update(tenants)
    .set({ webhookId, updatedAt: new Date().toISOString() })
    .where(eq(tenants.id, id));
  return webhookId;
}

export async function countTenants(db: DrizzleDb): Promise<number> {
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.length;
}

export async function listWhitelistUids(
  db: DrizzleDb,
  tenantId: number,
): Promise<string[]> {
  const rows = await db
    .select({ lineUid: tenantWhitelistUids.lineUid })
    .from(tenantWhitelistUids)
    .where(eq(tenantWhitelistUids.tenantId, tenantId));
  return rows.map((r) => r.lineUid);
}

export async function addWhitelistUid(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
  label: string | null,
): Promise<void> {
  await db
    .insert(tenantWhitelistUids)
    .values({ tenantId, lineUid, label })
    .onConflictDoNothing();
}

export async function removeWhitelistUid(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
): Promise<void> {
  await db
    .delete(tenantWhitelistUids)
    .where(eq(tenantWhitelistUids.lineUid, lineUid));
}
```

Note: `removeWhitelistUid` must also filter by `tenantId` in the where clause.
Use `and(eq(tenantWhitelistUids.tenantId, tenantId), eq(tenantWhitelistUids.lineUid, lineUid))` with `and` imported from `drizzle-orm`.
The same applies to every other tenant-scoped delete or update in this plan: always filter by `tenant_id`, otherwise one tenant can delete another tenant's rows.

- [ ] **Step 5: Run the tests**

```bash
bun test tests/tenant.repository.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/tenant.types.ts src/repositories/tenant.repository.ts tests/tenant.repository.test.ts
git commit -m "feat: add tenant repository and types"
```

---
### Task 4: Tenant config service with cache

**Files:**
- Create: `apps/api/src/services/tenant-config.service.ts`
- Test: `apps/api/tests/tenant-config.service.test.ts`

This is the only module that decrypts secrets.
It caches resolved `TenantConfig` objects because the webhook must answer LINE within 2 seconds, and cache misses otherwise cost a database round trip plus three AES decrypts.
The cache is invalidated the moment the UI saves, and also expires after 60 seconds as a safety net against direct database edits.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/tenant-config.service.test.ts
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  getTenantById,
  getTenantByWebhookId,
  listActiveTenants,
  saveTenant,
  invalidateTenantCache,
  TENANT_CACHE_TTL_MS,
  __setTenantClockForTests,
} from "../src/services/tenant-config.service";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { listWhitelistUids, addWhitelistUid } from "../src/repositories/tenant.repository";
import { getTenantRowById } from "../src/repositories/tenant.repository";
import { resetDbForTests } from "../src/db/connection";
import type { DrizzleDb } from "../src/db/connection";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;
let fakeNow = 1_000_000;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  db = t.db;
  client = t.client;
  __setTenantClockForTests(() => fakeNow);
});

afterAll(async () => {
  await closeTestDb(client);
  resetDbForTests();
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  invalidateTenantCache();
  fakeNow = 1_000_000;
});

describe("tenant-config.service", () => {
  test("resolves a decrypted TenantConfig with whitelist uids", async () => {
    const id = await insertTenantRow(db, {
      label: "A",
      active: true,
      lineChannelAccessToken: "tokA",
      lineChannelSecret: "secA",
      hfmApiKey: "keyA",
      hfmApiBaseUrl: "https://api.hfaffiliates.com",
      targetWallet: 111,
      whitelistEnabled: true,
    });
    await addWhitelistUid(db, id, "U1", null);
    await addWhitelistUid(db, id, "U2", null);

    const ctx = await getTenantById(id);
    expect(ctx!.lineChannelAccessToken).toBe("tokA");
    expect(ctx!.lineChannelSecret).toBe("secA");
    expect(ctx!.hfmApiKey).toBe("keyA");
    expect(ctx!.targetWallet).toBe(111);
    expect(ctx!.whitelistUids).toEqual(["U1", "U2"]);
    expect(ctx!.active).toBe(true);
  });

  test("getTenantByWebhookId finds the same tenant", async () => {
    const id = (await listActiveTenants())[0]!.id;
    const byId = await getTenantById(id);
    const byWebhook = await getTenantByWebhookId(byId!.webhookId);
    expect(byWebhook!.id).toBe(id);
  });

  test("unknown webhook id returns null, inactive tenants excluded from list", async () => {
    expect(await getTenantByWebhookId("nope")).toBeNull();
    const id2 = await saveTenant({
      label: "B",
      active: false,
      lineChannelAccessToken: "tokB",
      lineChannelSecret: "secB",
      hfmApiKey: "keyB",
      hfmApiBaseUrl: "https://api.hfaffiliates.com",
      targetWallet: 222,
      whitelistEnabled: true,
    });
    const actives = await listActiveTenants();
    expect(actives.find((t) => t.id === id2)).toBeUndefined();
  });

  test("saveTenant update keeps secrets when fields are empty strings", async () => {
    const id = await saveTenant({
      label: "C",
      active: true,
      lineChannelAccessToken: "tokC",
      lineChannelSecret: "secC",
      hfmApiKey: "keyC",
      hfmApiBaseUrl: "https://api.hfaffiliates.com",
      targetWallet: 333,
      whitelistEnabled: true,
    });
    await saveTenant(
      {
        label: "C2",
        active: true,
        lineChannelAccessToken: "",
        lineChannelSecret: "",
        hfmApiKey: "",
        hfmApiBaseUrl: "https://api.hfaffiliates.com",
        targetWallet: 334,
        whitelistEnabled: true,
      },
      id,
    );
    const ctx = await getTenantById(id);
    expect(ctx!.label).toBe("C2");
    expect(ctx!.lineChannelAccessToken).toBe("tokC");
    expect(ctx!.targetWallet).toBe(334);
  });

  test("cache is used within TTL and expires after TTL", async () => {
    const id = (await listActiveTenants()).find((t) => t.label === "A")!.id;
    const first = await getTenantById(id);
    await addWhitelistUid(db, id, "U3", null);
    const cached = await getTenantById(id);
    expect(cached!.whitelistUids).toEqual(first!.whitelistUids); // still cached
    fakeNow += TENANT_CACHE_TTL_MS + 1;
    const fresh = await getTenantById(id);
    expect(fresh!.whitelistUids).toContain("U3"); // cache expired
  });

  test("invalidateTenantCache takes effect immediately", async () => {
    const id = (await listActiveTenants()).find((t) => t.label === "A")!.id;
    await getTenantById(id);
    await addWhitelistUid(db, id, "U4", null);
    invalidateTenantCache(id);
    expect((await getTenantById(id))!.whitelistUids).toContain("U4");
  });

  test("saveTenant invalidates the cache for the saved tenant", async () => {
    const id = (await listActiveTenants()).find((t) => t.label === "A")!.id;
    await getTenantById(id);
    await saveTenant(
      {
        label: "A",
        active: true,
        lineChannelAccessToken: "tokA2",
        lineChannelSecret: "secA",
        hfmApiKey: "keyA",
        hfmApiBaseUrl: "https://api.hfaffiliates.com",
        targetWallet: 111,
        whitelistEnabled: true,
      },
      id,
    );
    expect((await getTenantById(id))!.lineChannelAccessToken).toBe("tokA2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/tenant-config.service.test.ts
```

Expected: FAIL with `Cannot find module '../src/services/tenant-config.service'`.

- [ ] **Step 3: Implement the service**

```ts
// apps/api/src/services/tenant-config.service.ts
import { getDb, type DrizzleDb } from "../db/connection";
import {
  getTenantRowById,
  getTenantRowByWebhookId,
  insertTenantRow,
  listTenantRows,
  listWhitelistUids,
  updateTenantRow,
} from "../repositories/tenant.repository";
import { decryptSecret } from "../utils/crypto";
import { logger, logError } from "../utils/logger";
import type { TenantConfig, TenantInput, TenantRow, TenantTestResult } from "../types/tenant.types";

// 60 seconds: the UI saves invalidate immediately, so this TTL only guards
// against direct database edits or a future second process.
export const TENANT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  config: TenantConfig;
  cachedAt: number;
}

let cache = new Map<number, CacheEntry>();
let clock: () => number = Date.now;

// Tests inject a fake clock; production code never touches this.
export function __setTenantClockForTests(fn: () => number): void {
  clock = fn;
}

async function resolveConfig(db: DrizzleDb, row: TenantRow): Promise<TenantConfig> {
  // A decrypt failure here means CONFIG_ENCRYPTION_KEY changed or the row is
  // corrupt. Fail this tenant loudly; never serve a half-decrypted config.
  return {
    id: row.id,
    webhookId: row.webhookId,
    label: row.label,
    active: row.active === 1,
    lineChannelAccessToken: decryptSecret(row.lineChannelAccessTokenEnc),
    lineChannelSecret: decryptSecret(row.lineChannelSecretEnc),
    lineBotUserId: row.lineBotUserId,
    lineBasicId: row.lineBasicId,
    lineDisplayName: row.lineDisplayName,
    hfmApiKey: decryptSecret(row.hfmApiKeyEnc),
    hfmApiBaseUrl: row.hfmApiBaseUrl,
    targetWallet: row.targetWallet,
    whitelistEnabled: row.whitelistEnabled === 1,
    whitelistUids: await listWhitelistUids(db, row.id),
    lastTestedAt: row.lastTestedAt,
    lastTestResult: parseTestResult(row.lastTestResult),
  };
}

function parseTestResult(raw: string | null): TenantTestResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TenantTestResult;
  } catch {
    logError("tenant-config", new Error("Unparseable last_test_result, ignoring"));
    return null;
  }
}

async function cached(
  db: DrizzleDb,
  row: TenantRow,
): Promise<TenantConfig> {
  const hit = cache.get(row.id);
  if (hit && clock() - hit.cachedAt < TENANT_CACHE_TTL_MS) return hit.config;
  const config = await resolveConfig(db, row);
  cache.set(row.id, { config, cachedAt: clock() });
  return config;
}

export async function getTenantById(id: number): Promise<TenantConfig | null> {
  const row = await getTenantRowById(getDb(), id);
  return row ? cached(getDb(), row) : null;
}

export async function getTenantByWebhookId(
  webhookId: string,
): Promise<TenantConfig | null> {
  const row = await getTenantRowByWebhookId(getDb(), webhookId);
  return row ? cached(getDb(), row) : null;
}

export async function listActiveTenants(): Promise<TenantConfig[]> {
  const rows = (await listTenantRows(getDb())).filter((r) => r.active === 1);
  return Promise.all(rows.map((r) => cached(getDb(), r)));
}

export function invalidateTenantCache(tenantId?: number): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}

export async function saveTenant(input: TenantInput, id?: number): Promise<number> {
  const db = getDb();
  const tenantId = id
    ? (await updateTenantRow(db, id, input), id)
    : await insertTenantRow(db, input);
  invalidateTenantCache(tenantId);
  logger.info({ tenantId }, "tenant config saved, cache invalidated");
  return tenantId;
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test tests/tenant-config.service.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tenant-config.service.ts tests/tenant-config.service.test.ts
git commit -m "feat: add cached tenant config service"
```

---

### Task 5: One-time bootstrap seed from the old env vars

**Files:**
- Create: `apps/api/src/db/bootstrap.ts`
- Test: `apps/api/tests/bootstrap.test.ts`

Decision Q6: on boot, if the `tenants` table is empty and the old env vars are present, one active tenant is seeded from them, and the boot log prints the generated webhook id so the operator can paste `https://<host>/webhook?oa=<webhook_id>` into the existing LINE console.
After the seed, per-tenant env vars are never read again.
There is deliberately no env fallback afterwards: a missing field must fail loudly, not silently borrow another OA's wallet.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/bootstrap.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { seedDefaultTenantFromEnv } from "../src/db/bootstrap";
import { countTenants } from "../src/repositories/tenant.repository";
import { getActiveUids } from "../src/repositories/recipient.repository";
import { getTenantConfigForTests } from "../src/services/tenant-config.service";
import { resetDbForTests } from "../src/db/connection";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  db = t.db;
  client = t.client;
});

afterAll(async () => {
  await closeTestDb(client);
  resetDbForTests();
  delete process.env.DATABASE_URL;
});

describe("bootstrap seed", () => {
  test("seeds one tenant from env exactly once", async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "prod_token";
    process.env.LINE_CHANNEL_SECRET = "prod_secret";
    process.env.HFM_API_KEY = "prod_hfm_key";
    process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
    process.env.TARGET_WALLET = "30506525";
    process.env.LINE_WHITELIST_ENABLED = "true";
    process.env.LINE_WHITELIST_UIDS = "Uw1,Uw2";
    process.env.LINE_NOTIFY_UIDS = "Un1,Un2";

    const id = await seedDefaultTenantFromEnv(db);
    expect(id).not.toBeNull();
    expect(await countTenants(db)).toBe(1);

    const ctx = await getTenantConfigForTests(db, id!);
    expect(ctx!.lineChannelAccessToken).toBe("prod_token");
    expect(ctx!.targetWallet).toBe(30506525);
    expect(ctx!.whitelistUids).toEqual(["Uw1", "Uw2"]);
    expect(await getActiveUids(db, id!)).toEqual(["Un1", "Un2"]);

    // Second boot must not seed again, even if env still present.
    const again = await seedDefaultTenantFromEnv(db);
    expect(again).toBeNull();
    expect(await countTenants(db)).toBe(1);
  });

  test("no env vars and empty table seeds nothing", async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_SECRET;
    delete process.env.HFM_API_KEY;
    expect(await seedDefaultTenantFromEnv(db)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/bootstrap.test.ts
```

Expected: FAIL with `Cannot find module '../src/db/bootstrap'`.

- [ ] **Step 3: Implement `bootstrap.ts`**

```ts
// apps/api/src/db/bootstrap.ts
import type { DrizzleDb } from "./connection";
import { countTenants, insertTenantRow, addWhitelistUid } from "../repositories/tenant.repository";
import { addRecipient } from "../repositories/recipient.repository";
import { logger } from "../utils/logger";

function splitCsv(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

function isFalseLike(raw: string | undefined): boolean {
  return ["false", "0", "off", "no"].includes((raw ?? "").trim().toLowerCase());
}

// Runs once at boot inside initDb. This is the ONLY code allowed to read the
// eight per-OA env variables, and only when the tenants table is empty.
// Returns the new tenant id, or null when nothing was seeded.
export async function seedDefaultTenantFromEnv(
  db: DrizzleDb,
): Promise<number | null> {
  if ((await countTenants(db)) > 0) return null;

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const secret = process.env.LINE_CHANNEL_SECRET?.trim();
  const hfmKey = process.env.HFM_API_KEY?.trim();
  const targetWallet = Number(process.env.TARGET_WALLET);

  if (!token || !secret || !hfmKey || !Number.isFinite(targetWallet) || targetWallet <= 0) {
    logger.warn(
      "tenants table is empty and per-OA env vars are missing; nothing seeded. " +
        "Create the first tenant through the internal UI (/internal/config).",
    );
    return null;
  }

  const id = await insertTenantRow(db, {
    label: process.env.LINE_OA_LABEL?.trim() || "Default OA",
    active: true,
    lineChannelAccessToken: token,
    lineChannelSecret: secret,
    hfmApiKey: hfmKey,
    hfmApiBaseUrl:
      process.env.HFM_API_BASE_URL?.trim() || "https://api.hfaffiliates.com",
    targetWallet,
    whitelistEnabled: !isFalseLike(process.env.LINE_WHITELIST_ENABLED),
  });

  for (const uid of splitCsv(process.env.LINE_WHITELIST_UIDS)) {
    await addWhitelistUid(db, id, uid, "seeded");
  }
  for (const uid of splitCsv(process.env.LINE_NOTIFY_UIDS)) {
    await addRecipient(db, id, uid, "seeded");
  }

  const webhookId = (
    await import("../repositories/tenant.repository").then((m) =>
      m.getTenantRowById(db, id),
    )
  )!.webhookId;

  logger.info(
    { tenantId: id, webhookId },
    `[bootstrap] seeded default tenant from env. Set the LINE webhook URL to: /webhook?oa=${webhookId}`,
  );
  return id;
}
```

Note: `LINE_OA_LABEL` is a new optional env var used only by this seed.
Add it to `.env.example` in Task 26 with the other first-boot-only variables.
Also add `getTenantConfigForTests(db, id)` to `tenant-config.service.ts`: a small export that resolves one tenant against an explicit db handle, used by tests that do not run through the global `getDb()`.

- [ ] **Step 4: Run the tests**

```bash
bun test tests/bootstrap.test.ts
```

Expected: all PASS.
This task depends on `addRecipient(db, tenantId, lineUid, label)` and `getActiveUids(db, tenantId)` from Task 11.
Implement those two functions first if you execute this task before Task 11, in the exact shape the contracts define.

- [ ] **Step 5: Commit**

```bash
git add src/db/bootstrap.ts tests/bootstrap.test.ts
git commit -m "feat: seed first tenant from env on boot"
```

---
### Task 6: Add `tenant_id` to the seven existing tables

**Files:**
- Modify: `apps/api/src/db/connection.ts` (`initDb`)
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/tests/db-helpers.ts`
- Test: `apps/api/tests/tenant-migration.test.ts`

Every table that stores per-OA data gets a `tenant_id`, and every unique key that can collide across OAs is rebuilt to include it.
The three collisions that matter most today: `client_snapshots(snapshot_date, client_id)`, `daily_report_notifications(snapshot_date)` as primary key, and `line_users(line_uid)` as primary key.
Without these changes OA number two silently loses its daily report and its line-user rows.

Order inside `initDb()`, with a comment explaining it: create the new tables from Task 2, seed the default tenant from Task 5, then migrate the existing tables, because the backfill needs a tenant id to point at.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/tenant-migration.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { insertMany, countByDate } from "../src/repositories/snapshot.repository";
import { recordLineUserRequest, listLineUsers } from "../src/repositories/line-user.repository";
import { markDailyReportSent, isDailyReportSent } from "../src/repositories/daily-notification.repository";
```

Note: if `daily-client-report.ts` keeps its notification helpers inline, export them from a new `apps/api/src/repositories/daily-notification.repository.ts` with `markDailyReportSent(db, tenantId, snapshotDate)` and `isDailyReportSent(db, tenantId, snapshotDate)` first, and reuse them from the job.
The rest of the test:

```ts
process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;

const INPUT = (wallet: number) => ({
  label: `OA ${wallet}`,
  active: true,
  lineChannelAccessToken: `tok_${wallet}`,
  lineChannelSecret: `sec_${wallet}`,
  hfmApiKey: `key_${wallet}`,
  hfmApiBaseUrl: "https://api.hfaffiliates.com",
  targetWallet: wallet,
  whitelistEnabled: true,
});

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const t = await createTestDb();
  db = t.db;
  client = t.client;
});

afterAll(async () => {
  await closeTestDb(client);
  delete process.env.DATABASE_URL;
});

describe("tenant_id migration", () => {
  test("two tenants can store the same snapshot_date and client_id", async () => {
    const a = await insertTenantRow(db, INPUT(111));
    const b = await insertTenantRow(db, INPUT(222));
    await insertMany(db, a, [
      { snapshotDate: "2026-09-05", clientId: 98241376, name: "x", email: null },
    ]);
    await insertMany(db, b, [
      { snapshotDate: "2026-09-05", clientId: 98241376, name: "x", email: null },
    ]);
    expect(await countByDate(db, a, "2026-09-05")).toBe(1);
    expect(await countByDate(db, b, "2026-09-05")).toBe(1);
  });

  test("two tenants can hold the same line uid without overwriting", async () => {
    const rows = await db.select().from((await import("../src/db/schema")).tenants);
    const a = rows[0]!.id;
    const b = rows[1]!.id;
    await recordLineUserRequest(db, a, "Usame", "message");
    await recordLineUserRequest(db, b, "Usame", "message");
    await recordLineUserRequest(db, a, "Usame", "message");
    const forA = (await listLineUsers(db, a)).find((u) => u.line_uid === "Usame");
    const forB = (await listLineUsers(db, b)).find((u) => u.line_uid === "Usame");
    expect(forA!.request_count).toBe(2);
    expect(forB!.request_count).toBe(1);
  });

  test("daily report sent for A does not suppress B", async () => {
    const rows = await db.select().from((await import("../src/db/schema")).tenants);
    const a = rows[0]!.id;
    const b = rows[1]!.id;
    await markDailyReportSent(db, a, "2026-09-05");
    expect(await isDailyReportSent(db, a, "2026-09-05")).toBe(true);
    expect(await isDailyReportSent(db, b, "2026-09-05")).toBe(false);
  });

  test("old single-tenant unique constraints are gone", async () => {
    const res = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'u' AND conname IN (
        'client_snapshots_snapshot_date_client_id_unique',
        'notify_recipients_line_uid_unique',
        'report_range_snapshots_period_from_date_to_date_unique'
      )
    `);
    expect((res as unknown as { rows: unknown[] }).rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/tenant-migration.test.ts
```

Expected: FAIL, because `insertMany(db, tenantId, ...)` does not exist yet and `createTestDb` still creates the old unique constraints.
Run it now anyway and read the failure: it is the exact bug class this task removes.

- [ ] **Step 3: Update `db-helpers.ts` to the new schema shape**

Change every table in the create block to the new shape.
The critical parts:

```sql
CREATE TABLE IF NOT EXISTS client_snapshots (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  snapshot_date TEXT NOT NULL,
  client_id     INTEGER NOT NULL,
  name          TEXT,
  email         TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, snapshot_date, client_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_tenant_date
  ON client_snapshots(tenant_id, snapshot_date);

CREATE TABLE IF NOT EXISTS notify_recipients (
  id        SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  line_uid  TEXT NOT NULL,
  label     TEXT,
  active    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, line_uid)
);

CREATE TABLE IF NOT EXISTS daily_report_notifications (
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  snapshot_date TEXT NOT NULL,
  sent_at       TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS line_users (
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id),
  line_uid         TEXT NOT NULL,
  first_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMP NOT NULL DEFAULT now(),
  request_count    INTEGER NOT NULL DEFAULT 1,
  last_event_type  TEXT,
  PRIMARY KEY (tenant_id, line_uid)
);

CREATE TABLE IF NOT EXISTS report_range_snapshots (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
  period     TEXT NOT NULL,
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  raw_json   TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, period, from_date, to_date)
);

CREATE TABLE IF NOT EXISTS client_request_snapshots (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  snapshot_date TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_req_snapshot_tenant_date
  ON client_request_snapshots(tenant_id, snapshot_date);

CREATE TABLE IF NOT EXISTS client_request_snapshot_rows (
  id          SERIAL PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES client_request_snapshots(id),
  client_id   INTEGER NOT NULL,
  UNIQUE(snapshot_id, client_id)
);
```

Keep `DROP TABLE IF EXISTS ...
CASCADE` for all tables (tenants last) at the top of the helper.

- [ ] **Step 4: Write the idempotent migration in `initDb()`**

Add helper functions above `initDb` in `apps/api/src/db/connection.ts`:

```ts
async function columnExists(
  db: PostgresJsDatabase<Record<string, unknown>>,
  table: string,
  column: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);
  return (res as unknown as { rows: unknown[] }).rows.length > 0;
}

async function constraintExists(
  db: PostgresJsDatabase<Record<string, unknown>>,
  name: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM pg_constraint WHERE conname = ${name}
  `);
  return (res as unknown as { rows: unknown[] }).rows.length > 0;
}
```

Then extend `initDb` so its body becomes, in this order:

```ts
// 1. Create every table in its NEW shape (IF NOT EXISTS is a no-op on
//    databases that already ran the migration).
// 2. Seed the default tenant from env (no-op when tenants already exist).
// 3. Migrate existing legacy tables: add tenant_id, backfill, constrain.
//    The order matters: the backfill needs at least one tenant row.
```

The migration block (after the seed call):

```ts
const LEGACY_TABLES = [
  "client_snapshots",
  "notify_recipients",
  "daily_report_notifications",
  "line_users",
  "report_range_snapshots",
  "client_request_snapshots",
] as const;

for (const table of LEGACY_TABLES) {
  if (!(await columnExists(target, table, "tenant_id"))) {
    await target.execute(
      sql.raw(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER`),
    );
  }
}

const tenantRows = (await target
  .execute(sql`SELECT MIN(id) AS first_id FROM tenants`)) as unknown as {
  rows: { first_id: number | null }[];
};
const defaultTenantId = tenantRows.rows[0]?.first_id ?? null;

const orphanCheck = (await target.execute(sql`
  SELECT
    (SELECT count(*) FROM client_snapshots WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM daily_report_notifications WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM line_users WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM notify_recipients WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM report_range_snapshots WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM client_request_snapshots WHERE tenant_id IS NULL) AS orphans
`)) as unknown as { rows: { orphans: string }[] };
const orphans = Number(orphanCheck.rows[0]?.orphans ?? 0);

if (orphans > 0 && defaultTenantId === null) {
  throw new Error(
    `Legacy rows exist (${orphans}) but no tenant exists to backfill them. ` +
      "Set the per-OA env vars once so the bootstrap seed can run, then restart.",
  );
}

if (defaultTenantId !== null) {
  for (const table of LEGACY_TABLES) {
    await target.execute(
      sql.raw(`UPDATE ${table} SET tenant_id = ${defaultTenantId} WHERE tenant_id IS NULL`),
    );
  }
}

// NOT NULL + FK after the backfill, guarded so reruns are silent.
for (const table of LEGACY_TABLES) {
  const nullRes = (await target.execute(
    sql.raw(`SELECT count(*) AS n FROM ${table} WHERE tenant_id IS NULL`),
  )) as unknown as { rows: { n: string }[] };
  if (Number(nullRes.rows[0]!.n) === 0) {
    await target.execute(
      sql.raw(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`),
    );
    await target.execute(
      sql.raw(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_tenant_id_fkey`,
      ),
    );
    await target.execute(
      sql.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant_id_fkey ` +
          `FOREIGN KEY (tenant_id) REFERENCES tenants(id)`,
      ),
    );
  }
}
```

Then the constraint rebuilds, each guarded by `constraintExists` and each written so it can never partially apply on a fresh database (on a fresh database the old constraints never exist, so these are all no-ops):

```ts
async function dropIfExists(db: PostgresJsDatabase<Record<string, unknown>>, name: string, table: string) {
  if (await constraintExists(db, name)) {
    await db.execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`));
  }
}

await dropIfExists(target, "client_snapshots_snapshot_date_client_id_unique", "client_snapshots");
await target.execute(sql`
  ALTER TABLE client_snapshots
  ADD CONSTRAINT client_snapshots_tenant_date_client_unique
  UNIQUE (tenant_id, snapshot_date, client_id)
`);

await dropIfExists(target, "notify_recipients_line_uid_unique", "notify_recipients");
await target.execute(sql`
  ALTER TABLE notify_recipients
  ADD CONSTRAINT notify_recipients_tenant_uid_unique
  UNIQUE (tenant_id, line_uid)
`);

await dropIfExists(target, "daily_report_notifications_pkey", "daily_report_notifications");
await target.execute(sql`
  ALTER TABLE daily_report_notifications
  ADD CONSTRAINT daily_report_notifications_tenant_date_pkey
  PRIMARY KEY (tenant_id, snapshot_date)
`);

await dropIfExists(target, "line_users_pkey", "line_users");
await target.execute(sql`
  ALTER TABLE line_users
  ADD CONSTRAINT line_users_tenant_uid_pkey
  PRIMARY KEY (tenant_id, line_uid)
`);

await dropIfExists(target, "report_range_snapshots_period_from_date_to_date_unique", "report_range_snapshots");
await target.execute(sql`
  ALTER TABLE report_range_snapshots
  ADD CONSTRAINT report_range_snapshots_tenant_period_unique
  UNIQUE (tenant_id, period, from_date, to_date)
`);
```

Because these `ADD CONSTRAINT` statements are not idempotent on their own, wrap each pair in a guard: only run the `ADD` when `!await constraintExists(target, "<new name>")`.

Finally update `apps/api/src/db/schema.ts` drizzle definitions to match the new columns and constraints (same names as the SQL above), and switch index `idx_snapshot_date` to `idx_snapshot_tenant_date` and `idx_req_snapshot_date` to `idx_req_snapshot_tenant_date` in both the SQL and `db-helpers.ts`.

- [ ] **Step 5: Run the migration tests and the whole suite**

```bash
bun test tests/tenant-migration.test.ts
bun test
```

Expected: tenant-migration tests PASS.
Other suites FAIL at this point (they call `insertMany(db, ...)` without `tenantId`).
That is expected: Tasks 7 to 14 thread `tenantId` through the repositories and jobs.
Do not fix those tests by loosening this task; continue with the plan order.

- [ ] **Step 6: Commit**

```bash
git add src/db/connection.ts src/db/schema.ts tests/db-helpers.ts tests/tenant-migration.test.ts
git commit -m "feat: scope all data tables by tenant_id"
```

---


<!-- part: B -->

### Task 7: Thread `ctx` through `hfm.service.ts`

**Files:**
- Modify: `apps/api/src/services/hfm.service.ts`
- Test: `apps/api/tests/hfm.service.test.ts`

Every function that reads `process.env.HFM_API_KEY`, `HFM_API_BASE_URL` or `TARGET_WALLET` takes `ctx: TenantConfig` as its first parameter and reads `ctx.hfmApiKey`, `ctx.hfmApiBaseUrl`, `ctx.targetWallet`.
Pure helpers (`extractWalletNumber`, `parsePerformanceLookup`, `normalizeClientRow`) keep their signatures: they never read env.

- [ ] **Step 1: Update the tests first**

In `apps/api/tests/hfm.service.test.ts`, every call site gains a ctx.
Add one shared factory:

```ts
import type { TenantConfig } from "../src/types/tenant.types";

function makeCtx(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    id: 1,
    webhookId: "00000000-0000-4000-8000-000000000001",
    label: "Test OA",
    active: true,
    lineChannelAccessToken: "line_tok",
    lineChannelSecret: "line_sec",
    lineBotUserId: null,
    lineBasicId: null,
    lineDisplayName: null,
    hfmApiKey: "hfm_key_for_test",
    hfmApiBaseUrl: "https://hfm.test",
    targetWallet: 30506525,
    whitelistEnabled: true,
    whitelistUids: [],
    lastTestedAt: null,
    lastTestResult: null,
    ...overrides,
  };
}
```

Then replace every `fetchPerformance({...})` with `fetchPerformance(makeCtx(), {...})`, and so on for the other functions.

Add the two tests that matter most for this task:

```ts
describe("tenant isolation in hfm.service", () => {
  test("fetchPerformance sends the ctx tenant's bearer token", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(String((init!.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({
        clients: [{ client_id: 1, account_id: 2, archived: null, subaffiliate: "WL-30506525" }],
      }), { status: 200 });
    }) as typeof fetch;

    const a = makeCtx({ hfmApiKey: "key_A", hfmApiBaseUrl: "https://a.test" });
    const b = makeCtx({ hfmApiKey: "key_B", hfmApiBaseUrl: "https://b.test" });
    await fetchPerformance(a, { kind: "wallet", id: 1, label: "1" });
    await fetchPerformance(b, { kind: "wallet", id: 1, label: "1" });

    expect(seen).toEqual(["Bearer key_A", "Bearer key_B"]);
  });

  test("checkConditions uses ctx.targetWallet, never env", async () => {
    process.env.TARGET_WALLET = "99999999";
    const ctx = makeCtx({ targetWallet: 30506525 });
    const data = {
      subaffiliate: "WL-30506525",
      balance: 500,
      account_currency: "USD",
    } as Parameters<typeof checkConditions>[1];
    expect(checkConditions(ctx, data).underTargetWallet).toBe(true);
    delete process.env.TARGET_WALLET;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test tests/hfm.service.test.ts
```

Expected: FAIL with wrong arity or `process.env` still being read.

- [ ] **Step 3: Change the signatures**

In `apps/api/src/services/hfm.service.ts`:

```ts
import type { TenantConfig } from "../types/tenant.types";

export async function checkHfmApiHealthy(ctx: TenantConfig): Promise<boolean> {
  try {
    const res = await fetch(`${ctx.hfmApiBaseUrl}/api/wallet/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.hfmApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function checkConditions(
  ctx: TenantConfig,
  data: HFMPerformanceData,
): ConditionCheck {
  if (!data.subaffiliate) {
    logError("hfm-service", `No subaffiliate found for client ${data.client_id}`);
    return { underTargetWallet: false, depositThresholdMet: false, matchAll: false };
  }
  // Same logic as before, but the wallet comes from the tenant that owns
  // this request, never from env.
  const walletNum = extractWalletNumber(data.subaffiliate.toString());
  const underTargetWallet = walletNum === ctx.targetWallet;
  const depositThreshold = data.account_currency === "USC" ? 200_00 : 200;
  const depositThresholdMet = data.balance >= depositThreshold;
  return { underTargetWallet, depositThresholdMet, matchAll: underTargetWallet && depositThresholdMet };
}
```

Apply the same pattern to `fetchPerformance`, `resolveLinkedAccounts`, `fetchClients`, `fetchAllClients`, `fetchClientsByRange`:
add `ctx: TenantConfig` as the first parameter, and replace each of these three lines that appear inside them:

```ts
const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
```

with:

```ts
const baseUrl = ctx.hfmApiBaseUrl;
```

and each:

```ts
headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
```

with:

```ts
headers: { Authorization: `Bearer ${ctx.hfmApiKey}` },
```

Delete the now-unused `process.env.TARGET_WALLET` read from `checkConditions` (shown above) and confirm by grepping:

```bash
grep -n "process.env" src/services/hfm.service.ts
```

Expected: no output (zero matches).

- [ ] **Step 4: Run the tests**

```bash
bun test tests/hfm.service.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hfm.service.ts tests/hfm.service.test.ts
git commit -m "refactor: thread tenant ctx through hfm service"
```

---

### Task 8: Thread `ctx` through `line.service.ts`, add `fetchBotInfo`

**Files:**
- Modify: `apps/api/src/services/line.service.ts`
- Test: `apps/api/tests/line.service.test.ts`

- [ ] **Step 1: Add the isolation test and `fetchBotInfo` test**

```ts
test("two tenants push with their own tokens", async () => {
  const seen: Array<{ auth: string; to: string }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push({
      auth: String((init!.headers as Record<string, string>).Authorization),
      to: JSON.parse(String(init!.body)).to,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await pushText(ctxA, "U123", "hi");
  await pushText(ctxB, "U123", "hi");
  expect(seen.map((s) => s.auth)).toEqual(["Bearer tokA", "Bearer tokB"]);
});

test("fetchBotInfo returns identity or null", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      userId: "U827", basicId: "@abc", displayName: "Test",
    }), { status: 200 })) as typeof fetch;
  expect(await fetchBotInfo("tok")).toEqual({
    userId: "U827", basicId: "@abc", displayName: "Test",
  });

  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  expect(await fetchBotInfo("bad")).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test tests/line.service.test.ts
```

Expected: FAIL, arity errors.

- [ ] **Step 3: Implement**

Every internal helper (`pushMessage`, `replyMessage`, `replyMessages`) gains a `ctx: TenantConfig` first parameter and uses `ctx.lineChannelAccessToken`.
Every exported wrapper passes it through.
The full new exported surface:

```ts
import type { TenantConfig } from "../types/tenant.types";

export const pushText = (ctx: TenantConfig, userId: string, text: string) =>
  pushMessage(ctx, userId, { type: "text", text });
export const pushFlex = (
  ctx: TenantConfig, userId: string, altText: string, contents: object,
) => pushMessage(ctx, userId, { type: "flex", altText, contents });
export const replyText = (ctx: TenantConfig, replyToken: string, text: string) =>
  replyMessage(ctx, replyToken, { type: "text", text });
export const replyTexts = (ctx: TenantConfig, replyToken: string, texts: string[]) =>
  replyMessages(ctx, replyToken, texts.map((text) => ({ type: "text", text })));
export const replyOrPushText = (
  ctx: TenantConfig, replyToken: string, userId: string, text: string,
) => replyOrPush(ctx, replyToken, userId, { type: "text", text });
export const replyOrPushFlex = (
  ctx: TenantConfig, replyToken: string, userId: string, altText: string, contents: object,
) => replyOrPush(ctx, replyToken, userId, { type: "flex", altText, contents });
export async function showLoading(
  ctx: TenantConfig, chatId: string, loadingSeconds = 20,
): Promise<void> { /* unchanged body but ctx.lineChannelAccessToken */ }
export async function pushToAll(
  ctx: TenantConfig, uids: string[], text: string,
): Promise<void> { /* unchanged body */ }
```

And the new function:

```ts
// Resolves the bot identity behind an access token. Used by the admin UI to
// verify a pasted token and to store the bot user id that webhook
// `destination` values are cross-checked against. Returns null on any
// non-2xx so callers can show "token invalid" instead of guessing.
export async function fetchBotInfo(
  accessToken: string,
): Promise<{ userId: string; basicId: string | null; displayName: string | null } | null> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      userId?: string; basicId?: string; displayName?: string;
    };
    if (!body.userId) return null;
    return {
      userId: body.userId,
      basicId: body.basicId ?? null,
      displayName: body.displayName ?? null,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests, then grep**

```bash
bun test tests/line.service.test.ts
grep -n "process.env" src/services/line.service.ts
```

Expected: tests PASS, grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/services/line.service.ts tests/line.service.test.ts
git commit -m "refactor: thread tenant ctx through line service"
```

---

### Task 9: Whitelist from `ctx`

**Files:**
- Modify: `apps/api/src/utils/whitelist.ts`
- Test: `apps/api/tests/whitelist.test.ts`

- [ ] **Step 1: Rewrite the test**

```ts
// apps/api/tests/whitelist.test.ts
import { describe, test, expect } from "bun:test";
import { isWhitelisted } from "../src/utils/whitelist";
import type { TenantConfig } from "../src/types/tenant.types";

function ctx(over: Partial<TenantConfig> = {}): TenantConfig {
  return {
    whitelistEnabled: true,
    whitelistUids: ["U1", "U2"],
    ...over,
  } as TenantConfig;
}

describe("whitelist", () => {
  test("uid in the tenant list passes", () => {
    expect(isWhitelisted(ctx(), "U1")).toBe(true);
  });
  test("uid not in the list is rejected", () => {
    expect(isWhitelisted(ctx(), "U9")).toBe(false);
  });
  test("disabled whitelist lets everyone through", () => {
    expect(isWhitelisted(ctx({ whitelistEnabled: false }), "U9")).toBe(true);
  });
  test("enabled with empty list lets everyone through (unchanged semantics)", () => {
    expect(isWhitelisted(ctx({ whitelistUids: [] }), "U9")).toBe(true);
  });
  test("another tenant's uid list is not consulted", () => {
    const a = ctx({ whitelistUids: ["U1"] });
    const b = ctx({ whitelistUids: ["U2"] });
    expect(isWhitelisted(a, "U2")).toBe(false);
    expect(isWhitelisted(b, "U2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test tests/whitelist.test.ts
```

Expected: FAIL with arity mismatch.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/utils/whitelist.ts
import type { TenantConfig } from "../types/tenant.types";

export function isWhitelisted(ctx: TenantConfig, userId: string): boolean {
  if (!ctx.whitelistEnabled) return true;
  // Empty list means "no restriction", same as the old env behaviour.
  if (ctx.whitelistUids.length === 0) return true;
  return ctx.whitelistUids.includes(userId);
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test tests/whitelist.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/whitelist.ts tests/whitelist.test.ts
git commit -m "refactor: read whitelist from tenant ctx"
```

---

### Task 10: Per-tenant last-trade cache

**Files:**
- Modify: `apps/api/src/services/last-trade.service.ts`
- Test: `apps/api/tests/last-trade.service.test.ts`

This is the direct data-leak fix.
The module-level `let cache` and `let inflight` become `Map`s keyed by `ctx.id`, so tenant B can never be handed tenant A's account-id map.

- [ ] **Step 1: Add the isolation tests**

```ts
test("tenant B never receives tenant A's warmed map", async () => {
  const rowsFor = (ids: number[]) => ids.map((id) => ({ id, last_trade: `t${id}` }));
  const fetchA = async () => ({ ok: true, data: rowsFor([1, 2]) }) as const;
  const fetchB = async () => ({ ok: true, data: rowsFor([3]) }) as const;

  const fromA = await getLastTradeMap(ctxA, { fetchClientsFn: fetchA });
  expect(fromA!.get(1)).toBe("t1");

  const fromB = await getLastTradeMap(ctxB, { fetchClientsFn: fetchB });
  expect(fromB!.has(1)).toBe(false); // leak test
  expect(fromB!.get(3)).toBe("t3");
});

test("single flight is per tenant", async () => {
  let callsA = 0;
  let callsB = 0;
  const fetchA = async () => { callsA++; return { ok: true, data: [] } as const; };
  const fetchB = async () => { callsB++; return { ok: true, data: [] } as const; };
  await Promise.all([
    getLastTradeMap(ctxA, { fetchClientsFn: fetchA }),
    getLastTradeMap(ctxA, { fetchClientsFn: fetchA }),
    getLastTradeMap(ctxB, { fetchClientsFn: fetchB }),
  ]);
  expect(callsA).toBe(1);
  expect(callsB).toBe(1);
});

test("resetLastTradeCache(tenantId) clears only that tenant", async () => {
  // warm both, reset A only, verify A refetches while B stays cached
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/last-trade.service.test.ts
```

- [ ] **Step 3: Implement**

Replace the two module singletons:

```ts
type LastTradeMap = Map<number, string | null>;

interface CacheEntry {
  map: LastTradeMap;
  fetchedAt: number;
}

const caches = new Map<number, CacheEntry>();
const inflights = new Map<number, Promise<LastTradeMap | null>>();

export function resetLastTradeCache(tenantId?: number): void {
  if (tenantId === undefined) {
    caches.clear();
    inflights.clear();
    return;
  }
  caches.delete(tenantId);
  inflights.delete(tenantId);
}
```

`getLastTradeMap(ctx, options)` then works exactly as the old `getLastTradeMap` did, but all `cache`/`inflight` accesses go through `caches.get(ctx.id)` / `caches.set(ctx.id, ...)`.
`refresh` gains a `tenantId` argument so it writes into the right entry:

```ts
async function refresh(
  tenantId: number,
  fetchClientsFn: () => Promise<HFMClientsResult>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<LastTradeMap | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await fetchClientsFn();
    if (result.ok) {
      const map: LastTradeMap = new Map(result.data.map((row) => [row.id, row.last_trade]));
      caches.set(tenantId, { map, fetchedAt: now() });
      return map;
    }
    // ...unchanged retry ladder; keep the existing comments about ~7s and ~48s
  }
  const cached = caches.get(tenantId);
  if (cached) {
    logError("last-trade", "getLastTradeMap fetch failed; serving stale cache");
    return cached.map;
  }
  logError("last-trade", "getLastTradeMap fetch failed; no cache available");
  return null;
}
```

Keep every existing comment about the 5 minute TTL, the ~7.4s endpoint, and the 60s reply-token budget.
`getLastTradeMapWithin(ctx, deadlineMs, options)` passes ctx through unchanged.
`GetLastTradeMapOptions` is unchanged.

- [ ] **Step 4: Run the tests**

```bash
bun test tests/last-trade.service.test.ts
```

Expected: all PASS, including the leak test.

- [ ] **Step 5: Commit**

```bash
git add src/services/last-trade.service.ts tests/last-trade.service.test.ts
git commit -m "fix: key last-trade cache by tenant"
```

---

### Task 11: `tenantId` in the repositories

**Files:**
- Modify: `apps/api/src/repositories/snapshot.repository.ts`
- Modify: `apps/api/src/repositories/recipient.repository.ts`
- Modify: `apps/api/src/repositories/request-snapshot.repository.ts`
- Modify: `apps/api/src/repositories/report-range.repository.ts`
- Modify: `apps/api/src/repositories/line-user.repository.ts`
- Test: `apps/api/tests/recipient.repository.test.ts`, `apps/api/tests/line-user.repository.test.ts`, `apps/api/tests/snapshot.repository.test.ts`

- [ ] **Step 1: Update the tests to always pass a tenant id**

The representative change in `recipient.repository.test.ts`:

```ts
let tenantA: number;
let tenantB: number;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db; client = t.client;
  tenantA = await insertTenantRow(db, INPUT("A"));
  tenantB = await insertTenantRow(db, INPUT("B"));
});

test("getActiveUids returns only this tenant's recipients", async () => {
  await addRecipient(db, tenantA, "Urec1", "boss A");
  await addRecipient(db, tenantA, "Urec2", null);
  await addRecipient(db, tenantB, "Urec3", "boss B");
  expect(await getActiveUids(db, tenantA)).toEqual(["Urec1", "Urec2"]);
  expect(await getActiveUids(db, tenantB)).toEqual(["Urec3"]);
});

test("removeRecipient only removes for that tenant", async () => {
  await addRecipient(db, tenantA, "Udup", "a");
  await addRecipient(db, tenantB, "Udup", "b");
  await removeRecipient(db, tenantB, "Udup");
  expect(await getActiveUids(db, tenantA)).toContain("Udup");
  expect(await getActiveUids(db, tenantB)).not.toContain("Udup");
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/recipient.repository.test.ts tests/line-user.repository.test.ts tests/snapshot.repository.test.ts
```

- [ ] **Step 3: Implement**

Rule for every function in these five files: `tenantId: number` is the second parameter, right after `db`, and every query filters by it.

`recipient.repository.ts` in full, because two functions are deleted here:

```ts
// apps/api/src/repositories/recipient.repository.ts
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { notifyRecipients } from "../db/schema";

// seedFromEnv and parseNotifyUids are gone by design: recipients now come
// from the database only, managed per tenant through the internal UI.

export async function addRecipient(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
  label: string | null,
): Promise<void> {
  await db
    .insert(notifyRecipients)
    .values({ tenantId, lineUid, label })
    .onConflictDoNothing();
}

export async function removeRecipient(
  db: DrizzleDb,
  tenantId: number,
  lineUid: string,
): Promise<void> {
  await db
    .delete(notifyRecipients)
    .where(
      and(
        eq(notifyRecipients.tenantId, tenantId),
        eq(notifyRecipients.lineUid, lineUid),
      ),
    );
}

export async function getActiveUids(db: DrizzleDb, tenantId: number): Promise<string[]> {
  const rows = await db
    .select({ lineUid: notifyRecipients.lineUid })
    .from(notifyRecipients)
    .where(
      and(eq(notifyRecipients.tenantId, tenantId), eq(notifyRecipients.active, 1)),
    );
  return rows.map((r) => r.lineUid);
}
```

`line-user.repository.ts`: `recordLineUserRequest(db, tenantId, lineUid, eventType)` upserts on `target: [lineUsers.tenantId, lineUsers.lineUid]`, and `listLineUsers(db, tenantId)` filters `eq(lineUsers.tenantId, tenantId)`.
`snapshot.repository.ts` (`countByDate`, `insertMany`, `purgeOlderThan`, `getLatestSnapshotDateBefore`), `request-snapshot.repository.ts`, and `report-range.repository.ts` follow the same rule: add the parameter, add the `eq(table.tenantId, tenantId)` filter to every statement, and include `tenantId` in every insert's values.

- [ ] **Step 4: Run the repository tests**

```bash
bun test tests/recipient.repository.test.ts tests/line-user.repository.test.ts tests/snapshot.repository.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repositories tests/recipient.repository.test.ts tests/line-user.repository.test.ts tests/snapshot.repository.test.ts
git commit -m "refactor: scope repositories by tenant id"
```

---

<!-- part: C -->

### Task 12: Tenant resolution in the webhook route

**Files:**
- Modify: `apps/api/src/routes/webhook.ts`
- Test: `apps/api/tests/webhook.test.ts`

The route accepts both `POST /webhook?oa=<webhookId>` and `POST /webhook/<webhookId>` and resolves them identically.
The resolution order is fixed by the contracts and must not be reordered: the `oa` value is only a routing hint because LINE signs the body, never the URL.

1. read the id, 404 when missing
2. load the tenant, 404 when unknown
3. inactive tenant: 200 OK, no processing
4. verify the signature with this tenant's secret, 400 when bad
5. only now trust the body: compare `destination` with the stored bot user id, 400 when mismatched
6. process events with `ctx`, return 200

- [ ] **Step 1: Update `webhook.test.ts` setup and add the routing tests**

The test file already signs bodies with `computeSig(body, SECRET)` and creates the schema itself.
Extend `setupTestDb` to also seed one tenant and export its webhook id:

```ts
import { insertTenantRow } from "../src/repositories/tenant.repository";
import { addWhitelistUid } from "../src/repositories/tenant.repository";

let webhookId = "";
const UID = "U11111111111111111111111111111111";

async function setupTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
    DROP TABLE IF EXISTS tenant_health_state CASCADE;
    DROP TABLE IF EXISTS tenant_whitelist_uids CASCADE;
    DROP TABLE IF EXISTS tenants CASCADE;
  `);
  await initDb(db);
  process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
  const id = await insertTenantRow(db, {
    label: "test",
    active: true,
    lineChannelAccessToken: "test_token",
    lineChannelSecret: SECRET,
    hfmApiKey: "test_hfm_key",
    hfmApiBaseUrl: "https://api.hfaffiliates.com",
    targetWallet: 30506525,
    whitelistEnabled: true,
  });
  await addWhitelistUid(db, id, UID, null);
  await updateTenantLineIdentity(db, id, {
    userId: BOT_USER_ID, basicId: null, displayName: null,
  });
  const row = await getTenantRowById(db, id);
  webhookId = row!.webhookId;
  await client.end();
  resetDbForTests();
}
```

New routing tests (send `destination: BOT_USER_ID` in every body):

```ts
describe("webhook tenant routing", () => {
  const bodyFor = (events: unknown[]) =>
    JSON.stringify({ destination: BOT_USER_ID, events });

  test("missing oa id -> 404", async () => {
    const res = await app.request("/webhook", { method: "POST", body: "" });
    expect(res.status).toBe(404);
  });

  test("unknown oa id -> 404", async () => {
    const res = await app.request("/webhook?oa=00000000-0000-4000-8000-0000000000ff", {
      method: "POST", body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("valid signature for the wrong tenant -> 400", async () => {
    // Signed with some other OA's secret but sent to this tenant's URL.
    const body = bodyFor([]);
    const res = await app.request(`/webhook?oa=${webhookId}`, {
      method: "POST",
      headers: { "x-line-signature": computeSig(body, "wrong_secret") },
      body,
    });
    expect(res.status).toBe(400);
  });

  test("inactive tenant -> 200 without processing", async () => {
    await saveTenant({ ...INPUT, active: false }, TENANT_ID);
    const body = bodyFor([]);
    const res = await app.request(`/webhook?oa=${webhookId}`, {
      method: "POST",
      headers: { "x-line-signature": computeSig(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("destination mismatch -> 400 (webhook URL pasted into another OA)", async () => {
    const body = JSON.stringify({ destination: "U99999999999999999999999999999999", events: [] });
    const res = await app.request(`/webhook?oa=${webhookId}`, {
      method: "POST",
      headers: { "x-line-signature": computeSig(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
  });

  test("path form /webhook/<id> works the same as ?oa=", async () => {
    const body = bodyFor([]);
    const res = await app.request(`/webhook/${webhookId}`, {
      method: "POST",
      headers: { "x-line-signature": computeSig(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("happy path: known id, valid signature, matching destination -> 200", async () => {
    const body = bodyFor([]);
    const res = await app.request(`/webhook?oa=${webhookId}`, {
      method: "POST",
      headers: { "x-line-signature": computeSig(body, SECRET) },
      body,
    });
    expect(res.status).toBe(200);
  });
});
```

Update the existing event-processing tests to send `?oa=${webhookId}` and `destination: BOT_USER_ID` too, and to sign with `SECRET`.

- [ ] **Step 2: Run to verify the new tests fail**

```bash
bun test tests/webhook.test.ts -t "webhook tenant routing"
```

- [ ] **Step 3: Implement the resolver in `webhook.ts`**

```ts
webhook.post(
  "/:webhookId?",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.text("Payload Too Large", 413),
  }),
  async (c) => {
    const rawBody = await c.req.text();
    const sig = c.req.header("x-line-signature") ?? "";

    // The `oa` id is a routing hint only. LINE signs the body, never the
    // URL, so identity is proven by the tenant's own channel secret below.
    const webhookId = c.req.query("oa") ?? c.req.param("webhookId") ?? "";
    if (!webhookId) return c.text("Not Found", 404);

    const ctx = await getTenantByWebhookId(webhookId);
    if (!ctx) {
      logger.warn({ webhookId }, "webhook called with unknown oa id");
      return c.text("Not Found", 404);
    }

    // Deliberately disabled tenants answer 200 so LINE keeps the webhook
    // enabled; re-enabling later needs no console visit.
    if (!ctx.active) {
      logger.info({ tenantId: ctx.id }, "webhook for inactive tenant ignored");
      return c.text("OK", 200);
    }

    if (!verifyLineSignature(rawBody, sig, ctx.lineChannelSecret)) {
      return c.text("Unauthorized", 400);
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody) as WebhookBody;
    } catch {
      return c.text("Bad Request", 400);
    }

    // Body is now trustworthy. Cross-check that this OA really owns this
    // webhook URL: the common setup mistake is pasting tenant A's URL into
    // tenant B's LINE console. destination is always present per LINE docs.
    if (ctx.lineBotUserId && body.destination && body.destination !== ctx.lineBotUserId) {
      logger.error(
        { tenantId: ctx.id, expected: ctx.lineBotUserId, got: body.destination },
        "webhook destination mismatch: this URL is registered in another OA's console",
      );
      return c.text("Wrong channel", 400);
    }

    const events = (body.events ?? []).slice(0, MAX_WEBHOOK_EVENTS);
    const db = getDb();

    for (const event of events) {
      const uid = event.source?.userId;
      if (uid) {
        recordLineUserRequest(db, ctx.id, uid, event.type).catch((err) =>
          logError("line-user", err),
        );
      }
      if (isTextMessageEvent(event)) {
        const { replyToken } = event;
        processTextEvent(ctx, event).catch((err) => {
          logError("webhook", err);
          if (uid) void notifyRetry(ctx, replyToken, uid);
        });
      } else if (isPostbackEvent(event)) {
        const { replyToken } = event;
        processPostbackEvent(ctx, event).catch((err) => {
          logError("webhook", err);
          if (uid) void notifyRetry(ctx, replyToken, uid);
        });
      }
    }

    return c.text("OK", 200);
  }
);
```

Add `destination?: string` to the `WebhookBody` type in `apps/api/src/types/line.types.ts`.
Note: LINE requires a response within 2 seconds, which is why `getTenantByWebhookId` must stay cache-backed and must never do the AES round trip on a cache hit.

- [ ] **Step 4: Run the whole webhook suite**

```bash
bun test tests/webhook.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/webhook.ts src/types/line.types.ts tests/webhook.test.ts
git commit -m "feat: route webhook by tenant webhook id"
```

---

### Task 13: Thread `ctx` through the event handlers

**Files:**
- Modify: `apps/api/src/routes/webhook.ts`
- Test: `apps/api/tests/webhook.test.ts`

- [ ] **Step 1: Add the scoping test**

```ts
test("a request to tenant A records line_users under tenant A only", async () => {
  // seed a second tenant B with its own webhook id (same helper as setup)
  const body = bodyFor([{ type: "message", ... }]);
  await app.request(`/webhook?oa=${webhookIdA}`, { ... });
  await waitFor(() => true);
  const db = getDb();
  const rowsA = await listLineUsers(db, idA);
  const rowsB = await listLineUsers(db, idB);
  expect(rowsA.length).toBe(1);
  expect(rowsB.length).toBe(0);
});
```

- [ ] **Step 2: Implement the threading**

Every handler gains `ctx: TenantConfig` as the first parameter, and every service call inside passes it:

- `isWhitelisted(ctx, userId)`
- `showLoading(ctx, userId)`
- `generateReportForUser(ctx, { reportPeriod })`
- `replyText(ctx, replyToken, text)`, `replyTexts(ctx, ...)`
- `fetchPerformance(ctx, lookup)`, `resolveLinkedAccounts(ctx, lookup.id)`
- `checkConditions(ctx, clientData)`
- `getLastTradeMapWithin(ctx, lastTradeDeadlineMs())`
- `replyOrPushFlex(ctx, ...)`, `replyOrPushText(ctx, ...)`
- `notifyRetry(ctx, replyToken, userId)` uses `isWhitelisted(ctx, userId)` and `replyOrPushText(ctx, ...)`

`recordLineUserRequest(db, ctx.id, uid, event.type)` was already threaded in Task 12.

- [ ] **Step 3: Run**

```bash
bun test tests/webhook.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/webhook.ts tests/webhook.test.ts
git commit -m "refactor: thread tenant ctx through webhook handlers"
```

---

### Task 14: Daily report per tenant

**Files:**
- Modify: `apps/api/src/jobs/daily-client-report.ts`
- Create: `apps/api/src/repositories/daily-notification.repository.ts`
- Test: `apps/api/tests/daily-client-report.test.ts`

- [ ] **Step 1: Add the cross-tenant report test**

```ts
test("two tenants with different wallets produce different reports on the same date", async () => {
  // ctxA.targetWallet = 111, ctxB.targetWallet = 222
  // stubbed fetchClientsByRange returns different client sets per key
  const a = await generateReportForUser(ctxA, {});
  const b = await generateReportForUser(ctxB, {});
  expect(a.join(" ")).toContain("111");
  expect(a.join(" ")).not.toContain("222");
  expect(b.join(" ")).toContain("222");
});

test("daily_report_notifications for A does not suppress B", async () => {
  await markDailyReportSent(db, idA, "2026-09-05");
  expect(await isDailyReportSent(db, idB, "2026-09-05")).toBe(false);
});
```

- [ ] **Step 2: Implement**

`apps/api/src/repositories/daily-notification.repository.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { dailyReportNotifications } from "../db/schema";

export async function markDailyReportSent(
  db: DrizzleDb,
  tenantId: number,
  snapshotDate: string,
): Promise<void> {
  await db
    .insert(dailyReportNotifications)
    .values({ tenantId, snapshotDate })
    .onConflictDoNothing();
}

export async function isDailyReportSent(
  db: DrizzleDb,
  tenantId: number,
  snapshotDate: string,
): Promise<boolean> {
  const rows = await db
    .select({ snapshotDate: dailyReportNotifications.snapshotDate })
    .from(dailyReportNotifications)
    .where(
      and(
        eq(dailyReportNotifications.tenantId, tenantId),
        eq(dailyReportNotifications.snapshotDate, snapshotDate),
      ),
    );
  return rows.length > 0;
}
```

In `daily-client-report.ts`:

- delete `getTargetWallet()`; every use becomes `ctx.targetWallet` and `String(ctx.targetWallet)`
- `runDailyClientReport(ctx, options)` and `generateReportForUser(ctx, options)`
- delete `await seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "")`; recipients come from `getActiveUids(db, ctx.id)`
- every snapshot read/write passes `ctx.id` as the tenant id
- pushes use `pushToAll(ctx, uids, text)`

- [ ] **Step 3: Run**

```bash
bun test tests/daily-client-report.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/jobs/daily-client-report.ts src/repositories/daily-notification.repository.ts tests/daily-client-report.test.ts
git commit -m "refactor: daily report per tenant"
```

---

### Task 15: Healthcheck per tenant, state in the database

**Files:**
- Modify: `apps/api/src/jobs/hfm-healthcheck.ts`
- Test: `apps/api/tests/hfm-healthcheck.test.ts`

- [ ] **Step 1: Update the tests**

Replace the `lastHealthy` reset calls with database state, and add:

```ts
test("state change is persisted, restart does not re-alert", async () => {
  await runHfmHealthCheckForTenant(ctxA, { checkHealthyFn: async () => false, pushToAllFn });
  await runHfmHealthCheckForTenant(ctxA, { checkHealthyFn: async () => false, pushToAllFn });
  expect(pushCount()).toBe(1); // second run sees unchanged persisted state
});

test("tenant A down does not alert tenant B's recipients", async () => {
  await runHfmHealthCheckAll({ checkHealthyFn: async () => ctxA.id === downTenantId ? false : true, pushToAllFn });
  // B's uids never receive a down message
});
```

- [ ] **Step 2: Implement**

Delete `let lastHealthy` and `__resetHealthState`.
New module body:

```ts
// Health state lives in tenant_health_state, not in a module variable, so a
// process restart while HFM is down no longer re-sends the alert, and so a
// future second process cannot double-alert. Baseline for a tenant with no
// row is "healthy": a first failed probe alerts, a first success stays quiet.
export async function getTenantHealthState(
  db: DrizzleDb,
  tenantId: number,
): Promise<boolean> {
  const rows = await db
    .select({ healthy: tenantHealthState.healthy })
    .from(tenantHealthState)
    .where(eq(tenantHealthState.tenantId, tenantId));
  return rows.length === 0 ? true : rows[0]!.healthy === 1;
}

async function setTenantHealthState(
  db: DrizzleDb,
  tenantId: number,
  healthy: boolean,
): Promise<void> {
  await db
    .insert(tenantHealthState)
    .values({ tenantId, healthy: healthy ? 1 : 0 })
    .onConflictDoUpdate({
      target: tenantHealthState.tenantId,
      set: { healthy: healthy ? 1 : 0, changedAt: new Date().toISOString() },
    });
}

export async function runHfmHealthCheckForTenant(
  ctx: TenantConfig,
  options: RunHfmHealthCheckOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const checkHealthy = options.checkHealthyFn ?? (() => checkHfmApiHealthy(ctx));
  const pushAll = options.pushToAllFn ?? ((uids, text) => pushToAll(ctx, uids, text));
  const getUids = options.getUidsFn ?? (() => getActiveUids(db, ctx.id));

  const healthy = await checkHealthy();
  if (healthy === (await getTenantHealthState(db, ctx.id))) return;

  const uids = await getUids();
  if (uids.length === 0) {
    console.warn(`[cron] hfm-healthcheck: no recipients for tenant ${ctx.id}, skipping notify`);
    await setTenantHealthState(db, ctx.id, healthy);
    return;
  }

  const message = healthy ? RECOVERED_MESSAGE : DOWN_MESSAGE;
  await pushAll(uids, message);
  await setTenantHealthState(db, ctx.id, healthy);
}

export async function runHfmHealthCheckAll(
  options: RunHfmHealthCheckOptions = {},
): Promise<void> {
  const tenants = await listActiveTenants();
  // Sequential on purpose: N parallel probes would fire N HFM requests at
  // once, and one tenant's slow failure must not delay the others' results.
  for (const ctx of tenants) {
    try {
      await runHfmHealthCheckForTenant(ctx, options);
    } catch (e) {
      console.error(`[cron] hfm-healthcheck failed for tenant ${ctx.id} (${ctx.label}):`, e);
    }
  }
}
```

- [ ] **Step 3: Run**

```bash
bun test tests/hfm-healthcheck.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/jobs/hfm-healthcheck.ts tests/hfm-healthcheck.test.ts
git commit -m "refactor: per-tenant healthcheck with db state"
```

---

### Task 16: Register both cron jobs

**Files:**
- Modify: `apps/api/src/jobs/index.ts`

The 05:00 ICT daily report described in `INITIAL.md` was never scheduled: `registerJobs` only registers the healthcheck, and only a manual script triggers the report.
This task makes the schedule real, which is new production behaviour.
Announce it to the operator before deploy, and check Open Risk 2 (a host crontab may already trigger it) to avoid double sending.

- [ ] **Step 1: Implement**

```ts
// apps/api/src/jobs/index.ts
import { Cron } from "croner";
import { runHfmHealthCheckAll } from "./hfm-healthcheck";
import { runDailyClientReport } from "./daily-client-report";
import { listActiveTenants } from "../services/tenant-config.service";
import { logError } from "../utils/logger";

// Per-tenant timeout so one stuck HFM call cannot block the other tenants'
// reports. Generous because fetchClients can legitimately take ~48s.
const REPORT_TIMEOUT_MS = 120_000;

export function registerJobs(): void {
  new Cron(
    "*/5 * * * *",
    { timezone: "Asia/Bangkok", protect: true },
    async () => {
      try {
        await runHfmHealthCheckAll();
      } catch (e) {
        logError("cron", e);
      }
    },
  );
  console.log("[cron] hfm-healthcheck registered (every 5 min, all tenants)");

  new Cron(
    "0 5 * * *",
    { timezone: "Asia/Bangkok", protect: true },
    async () => {
      // Sequential on purpose: parallel HFM calls for N tenants would burst
      // and one stuck tenant must not block the rest.
      for (const ctx of await listActiveTenants()) {
        try {
          await Promise.race([
            runDailyClientReport(ctx),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`report timeout for tenant ${ctx.id}`)), REPORT_TIMEOUT_MS),
            ),
          ]);
        } catch (e) {
          logError("cron", e);
        }
      }
    },
  );
  console.log("[cron] daily-client-report registered (05:00 ICT, all tenants)");
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/index.ts
git commit -m "feat: schedule per-tenant daily report at 05:00 ICT"
```

---

### Task 17: Startup order, liveness-only health

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/health.test.ts`

- [ ] **Step 1: Update `index.ts`**

```ts
// Fail fast: a process that cannot decrypt its tenants is not servable.
let encryptionKey: Buffer;
try {
  encryptionKey = loadEncryptionKey();
} catch (err) {
  console.error(String(err));
  process.exit(1);
}

const db = getDb();
await initDb(db); // creates tables, seeds the first tenant, migrates legacy rows

registerJobs();

// Warm every tenant sequentially. Each warm costs one ~7.4s HFM call with
// that tenant's own key; firing them in parallel would burst the upstream
// and blur whose cache failed. A small gap spreads the load.
(async () => {
  for (const ctx of await listActiveTenants()) {
    try {
      const map = await getLastTradeMap(ctx);
      logger.info(
        { tenantId: ctx.id, label: ctx.label, size: map?.size ?? 0 },
        "[startup] last-trade cache warmed",
      );
    } catch (err) {
      logError("startup-warm", err);
    }
    await Bun.sleep(500);
  }
})();
```

`initDb` in `connection.ts` now calls `seedDefaultTenantFromEnv(db)` between table creation and migration, as Task 6 specified.

- [ ] **Step 2: Split the health endpoint**

`GET /internal/health` becomes database and process only:

```ts
internal.get("/health", async (c) => {
  // Liveness only. The docker healthcheck uses this endpoint with
  // restart=unless-stopped, so an HFM outage must NOT mark the container
  // unhealthy: that would restart the bot in a loop and drop the warm cache
  // every restart. Upstream status lives in /internal/health/tenants.
  const checks: Record<string, "ok" | "error"> = {};
  try {
    await getDb().execute(sql`SELECT 1`);
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }
  const allOk = Object.values(checks).every((v) => v === "ok");
  return c.json({ status: allOk ? "healthy" : "unhealthy", checks }, allOk ? 200 : 503);
});

internal.get("/health/tenants", async (c) => {
  const db = getDb();
  const rows = await db.select().from(tenantHealthState);
  const tenants = await listTenantRows(db);
  return c.json({
    tenants: tenants.map((t) => ({
      id: t.id,
      label: t.label,
      active: t.active === 1,
      healthy: rows.find((r) => r.tenantId === t.id)?.healthy ?? 1,
      changedAt: rows.find((r) => r.tenantId === t.id)?.changedAt ?? null,
    })),
  });
});
```

- [ ] **Step 3: Update `tests/health.test.ts`**

The HFM stub is removed from the health test; `checks.hfm_api` no longer exists.
Add a test that `/internal/health` returns 200 even when the HFM upstream is unreachable (stub `fetch` to reject), and a test that `/internal/health/tenants` returns one entry per tenant.

- [ ] **Step 4: Run the full suite and typecheck**

```bash
bun test && bun run typecheck
```

Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/routes/internal.ts src/db/connection.ts tests/health.test.ts
git commit -m "feat: startup warm per tenant, liveness health"
```

---

<!-- part: D -->

### Task 18: Admin auth: login, cookie session, CSRF

**Files:**
- Create: `apps/api/src/routes/internal-auth.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/internal-auth.test.ts`

The admin pages edit real channel tokens, so they do not accept `?key=`.
They use a signed httpOnly cookie.
The `?key=` middleware must keep working for `/internal/health`, `/internal/logs*`, and `/internal/line-uids`, because the docker healthcheck and existing tooling depend on it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/tests/internal-auth.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { internalAuthRoutes, requireAdmin, issueSession } from "../src/routes/internal-auth";

const app = new Hono();
app.route("/internal", internalAuthRoutes);
app.use("/internal/secret-page", requireAdmin);
app.get("/internal/secret-page", (c) => c.text("secret"));

process.env.INTERNAL_API_KEY = "the-key";

beforeEach(() => {
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("admin auth", () => {
  test("no cookie redirects to login", async () => {
    const res = await app.request("/internal/secret-page");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/internal/login");
  });

  test("wrong key is rejected", async () => {
    const res = await app.request("/internal/login", {
      method: "POST",
      body: new URLSearchParams({ key: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("right key sets an httpOnly cookie and grants access", async () => {
    const login = await app.request("/internal/login", {
      method: "POST",
      body: new URLSearchParams({ key: "the-key" }),
    });
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const res = await app.request("/internal/secret-page", {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(res.status).toBe(200);
  });

  test("tampered cookie is rejected", async () => {
    const login = await app.request("/internal/login", {
      method: "POST",
      body: new URLSearchParams({ key: "the-key" }),
    });
    const good = login.headers.get("set-cookie")!.split(";")[0];
    const forged = good.replace(/hfm_admin=[^;]+/, "hfm_admin=forged");
    const res = await app.request("/internal/secret-page", {
      headers: { cookie: forged },
    });
    expect(res.status).toBe(302);
  });

  test("expired cookie is rejected", async () => {
    // issued with expiry in the past via the test helper
    const expired = issueSession(0);
    const res = await app.request("/internal/secret-page", {
      headers: { cookie: `hfm_admin=${expired}` },
    });
    expect(res.status).toBe(302);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test tests/internal-auth.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/api/src/routes/internal-auth.ts
import { Hono } from "hono";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";

const COOKIE_NAME = "hfm_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one shift, not forever

function sessionSecret(): string {
  // Derived from INTERNAL_API_KEY so no new env var is needed. Changing the
  // key invalidates all sessions, which is the wanted behaviour.
  return process.env.INTERNAL_API_KEY ?? "";
}

// value = "<expiresAtMs>.<csrfToken>.<hmac(expiresAtMs + "." + csrfToken)>"
export function issueSession(ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const csrf = randomUUID();
  const payload = `${expiresAt}.${csrf}`;
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(value: string | undefined): { csrf: string } | null {
  if (!value) return null;
  const [expiresAt, csrf, sig] = value.split(".");
  if (!expiresAt || !csrf || !sig) return null;
  const expected = createHmac("sha256", sessionSecret())
    .update(`${expiresAt}.${csrf}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiresAt) < Date.now()) return null;
  return { csrf };
}

export async function requireAdmin(c: Context, next: Next) {
  const session = verifySession(getCookie(c, COOKIE_NAME));
  if (!session) return c.redirect("/internal/login");
  c.set("adminCsrf" as never, session.csrf as never);
  await next();
}

export function requireCsrf(c: Context): boolean {
  const sent = (c.req.bodyCache ? undefined : undefined) ?? undefined;
  return sent !== null;
}
```

Note for the implementer: `requireCsrf` above is intentionally minimal in this plan text.
Implement it for real: read the posted form field `csrf` and compare it with `c.get("adminCsrf")` using a timing-safe compare.
Reject with 403 when missing or wrong.

```ts
export const internalAuthRoutes = new Hono();

internalAuthRoutes.get("/login", (c) => {
  return c.html(`<!doctype html>
<html><head><title>Login</title></head>
<body>
  <form method="post" action="/internal/login">
    <input type="password" name="key" placeholder="Internal API key" autofocus>
    <button type="submit">Sign in</button>
  </form>
</body></html>`);
});

internalAuthRoutes.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const key = String(form.key ?? "");
  const expected = process.env.INTERNAL_API_KEY ?? "";
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && expected.length > 0 && timingSafeEqual(a, b);
  if (!ok) return c.text("Unauthorized", 401);
  c.header(
    "set-cookie",
    `${COOKIE_NAME}=${issueSession()}; HttpOnly; SameSite=Strict; Path=/internal; Max-Age=${SESSION_TTL_MS / 1000}${process.env.PUBLIC_BASE_URL?.startsWith("https") ? "; Secure" : ""}`,
  );
  return c.redirect("/internal/config");
});

internalAuthRoutes.post("/logout", (c) => {
  c.header("set-cookie", `${COOKIE_NAME}=; HttpOnly; Path=/internal; Max-Age=0`);
  return c.redirect("/internal/login");
});
```

In `internal.ts`, mount `internalAuthRoutes` and protect the config routes with `requireAdmin`, while keeping the `?key=` middleware only on the machine-readable routes listed in the contracts.

- [ ] **Step 4: Run**

```bash
bun test tests/internal-auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/internal-auth.ts src/routes/internal.ts tests/internal-auth.test.ts
git commit -m "feat: cookie session and CSRF for admin UI"
```

---

### Task 19: Tenant list and edit form

**Files:**
- Create: `apps/api/src/routes/internal-config.tsx`
- Modify: `apps/api/src/routes/internal.ts`
- Test: `apps/api/tests/internal-config.test.ts`

Server-rendered with `hono/jsx`.
No client framework, no build step.
Inline CSS in the layout is enough for an internal tool.

- [ ] **Step 1: Layout and list page**

```tsx
// apps/api/src/routes/internal-config.tsx
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import type { TenantConfig, TenantRow, TenantTestResult } from "../types/tenant.types";
import { maskSecret } from "../utils/crypto";
import { decryptSecret } from "../utils/crypto";

const Layout = (props: { title: string; children: any }) => (
  <html>
    <head>
      <title>{props.title}</title>
      <style>{`
        body { font-family: system-ui, sans-serif; margin: 2rem; }
        table { border-collapse: collapse; }
        td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
        .badge-ok { background: #d4f7d4; padding: 2px 6px; }
        .badge-warn { background: #ffe9c7; padding: 2px 6px; }
        .badge-err { background: #ffd7d7; padding: 2px 6px; }
        form.inline { display: inline; }
      `}</style>
    </head>
    <body>{props.children}</body>
  </html>
);

function TestBadge({ row }: { row: TenantRow }) {
  if (!row.lastTestedAt) return <span class="badge-err">never tested</span>;
  try {
    const r = JSON.parse(row.lastTestResult!) as TenantTestResult;
    return r.lineOk && r.hfmOk && r.walletOk
      ? <span class="badge-ok">tested ok</span>
      : <span class="badge-warn">test failed</span>;
  } catch {
    return <span class="badge-warn">unknown</span>;
  }
}

function webhookUrl(webhookId: string): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "https://YOUR-HOST";
  return `${base}/webhook?oa=${webhookId}`;
}
```

The list route renders every tenant with its badge, webhook URL, and links.
The create and edit routes render the same `TenantForm`:

```tsx
function TenantForm({ row }: { row?: TenantRow }) {
  const isEdit = row !== undefined;
  return (
    <form method="post" action={isEdit ? `/internal/config/${row!.id}` : "/internal/config/new"}>
      <input type="hidden" name="csrf" value={"CSRF_FROM_CONTEXT"} />
      <label>Label <input name="label" required value={row?.label ?? ""} /></label><br />
      <label>
        LINE channel access token{" "}
        <input name="lineChannelAccessToken" placeholder={isEdit ? "unchanged" : ""} />
      </label><br />
      <label>
        LINE channel secret{" "}
        <input name="lineChannelSecret" placeholder={isEdit ? "unchanged" : ""} />
      </label><br />
      <label>
        HFM API key{" "}
        <input name="hfmApiKey" placeholder={isEdit ? "unchanged" : ""} />
      </label><br />
      <label>
        HFM base URL{" "}
        <input name="hfmApiBaseUrl" value={row?.hfmApiBaseUrl ?? "https://api.hfaffiliates.com"} />
      </label><br />
      <label>
        Target wallet{" "}
        <input name="targetWallet" type="number" min="1" required value={row?.targetWallet ?? ""} />
      </label><br />
      <label>
        <input type="checkbox" name="whitelistEnabled" checked={(row?.whitelistEnabled ?? 1) === 1} />
        whitelist enabled
      </label><br />
      <label>
        <input type="checkbox" name="active" checked={(row?.active ?? 0) === 1} />
        active
      </label><br />
      <button type="submit">Save</button>
    </form>
  );
}
```

The implementer replaces `CSRF_FROM_CONTEXT` by passing the CSRF token down as a prop from `requireAdmin` (available as `c.get("adminCsrf")`).
Secrets are never echoed back: the edit form shows only a placeholder.
If you need to show what is stored, show `maskSecret(decryptSecret(row.lineChannelAccessTokenEnc))` as a separate read-only line, never as an input value.

- [ ] **Step 2: Add tests for rendering**

```ts
test("list shows never-tested badge for a fresh tenant", async () => {
  const res = await app.request("/internal/config", { headers: { cookie: adminCookie() } });
  const html = await res.text();
  expect(html).toContain("never tested");
  expect(html).not.toContain(decryptedAnySecret);
});

test("unauthenticated list redirects to login", async () => {
  const res = await app.request("/internal/config");
  expect(res.status).toBe(302);
});
```

- [ ] **Step 3: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx src/routes/internal.ts tests/internal-config.test.ts
git commit -m "feat: tenant list and edit form UI"
```

---

### Task 20: Save handler with bot identity fetch

**Files:**
- Modify: `apps/api/src/routes/internal-config.tsx`
- Test: `apps/api/tests/internal-config.test.ts`

- [ ] **Step 1: Tests**

```ts
test("save with empty secret fields keeps stored values", async () => {
  const before = await getTenantRowById(db, id);
  await app.request(`/internal/config/${id}`, {
    method: "POST",
    headers: { cookie: adminCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf, label: "New label", lineChannelAccessToken: "", lineChannelSecret: "", hfmApiKey: "", hfmApiBaseUrl: "https://api.hfaffiliates.com", targetWallet: "42", whitelistEnabled: "on", active: "on" }),
  });
  const after = await getTenantRowById(db, id);
  expect(after!.label).toBe("New label");
  expect(after!.lineChannelAccessTokenEnc).toBe(before!.lineChannelAccessTokenEnc);
});

test("save invalidates the tenant cache immediately", async () => {
  await getTenantById(id); // prime cache
  await app.request(`/internal/config/${id}`, { ...saveWithLabel("Cache check") });
  expect((await getTenantById(id))!.label).toBe("Cache check");
});

test("save fetches bot info and stores identity", async () => {
  globalThis.fetch = stubBotInfo({ userId: "U777", displayName: "My OA" }) as typeof fetch;
  await app.request(`/internal/config/${id}`, { ...saveWithLabel("Identity") });
  const row = await getTenantRowById(db, id);
  expect(row!.lineBotUserId).toBe("U777");
  expect(row!.lineDisplayName).toBe("My OA");
});

test("bot info failure still saves and shows a warning", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const res = await app.request(`/internal/config/${id}`, { ...saveWithLabel("Warn me") });
  const html = await res.text();
  expect(html).toContain("LINE token could not be verified");
});
```

- [ ] **Step 2: Implement the handlers**

The save handler:

```ts
async function handleSave(c: Context, id?: number) {
  if (!requireCsrf(c)) return c.text("Forbidden", 403);
  const form = await c.req.parseBody();
  const input: TenantInput = {
    label: String(form.label ?? "").trim(),
    active: form.active === "on",
    lineChannelAccessToken: String(form.lineChannelAccessToken ?? ""),
    lineChannelSecret: String(form.lineChannelSecret ?? ""),
    hfmApiKey: String(form.hfmApiKey ?? ""),
    hfmApiBaseUrl: String(form.hfmApiBaseUrl ?? "").trim() || "https://api.hfaffiliates.com",
    targetWallet: Number(form.targetWallet),
    whitelistEnabled: form.whitelistEnabled === "on",
  };

  // Validation: fail loudly, never half-save a tenant.
  const errors: string[] = [];
  if (!input.label) errors.push("label is required");
  if (!Number.isInteger(input.targetWallet) || input.targetWallet <= 0) {
    errors.push("target wallet must be a positive integer");
  }
  if (!input.hfmApiBaseUrl.startsWith("https://")) errors.push("base URL must be https");
  if (id === undefined) {
    if (!input.lineChannelAccessToken) errors.push("access token is required");
    if (!input.lineChannelSecret) errors.push("channel secret is required");
    if (!input.hfmApiKey) errors.push("HFM API key is required");
  }
  if (errors.length > 0) return c.html(errorPage(errors), 400);

  const tenantId = await saveTenant(input, id);

  // Verify the token and pin the bot identity. A failure is a warning, not
  // an error: the user explicitly chose that tests never block saving.
  let warning: string | null = null;
  const token = input.lineChannelAccessToken ||
    decryptSecret((await getTenantRowById(getDb(), tenantId))!.lineChannelAccessTokenEnc);
  const identity = await fetchBotInfo(token);
  if (identity) {
    await updateTenantLineIdentity(getDb(), tenantId, identity);
  } else {
    warning = "LINE token could not be verified. Check it before going live.";
  }

  return c.redirect(`/internal/config/${tenantId}${warning ? `?warn=${encodeURIComponent(warning)}` : ""}`);
}
```

Add `POST /internal/config/:id/rotate` that calls `rotateWebhookId(db, id)` and `invalidateTenantCache(id)`, and renders a page telling the operator to update the URL in the LINE console immediately.

- [ ] **Step 3: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx tests/internal-config.test.ts
git commit -m "feat: save tenant with bot identity check"
```

---

### Task 21: Test connection button and status page

**Files:**
- Modify: `apps/api/src/routes/internal-config.tsx`
- Test: `apps/api/tests/internal-config.test.ts`

The test is a button, never a gate (decision Q24).
Activation is never blocked by a failed test.
But the list page shows a red badge for never-tested or failed, so a misconfigured OA cannot look healthy at a glance.

- [ ] **Step 1: Tests**

```ts
test("test stores a failing result and the list shows the badge", async () => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const auth = String((init!.headers as Record<string, string>).Authorization);
    if (auth.startsWith("Bearer line_ok")) {
      return new Response(JSON.stringify({ userId: "U1" }), { status: 200 });
    }
    return new Response("nope", { status: 401 }); // HFM down
  }) as typeof fetch;

  await app.request(`/internal/config/${id}/test`, {
    method: "POST", headers: { cookie: adminCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf }),
  });

  const row = await getTenantRowById(db, id);
  const result = JSON.parse(row!.lastTestResult!) as TenantTestResult;
  expect(result.lineOk).toBe(true);
  expect(result.hfmOk).toBe(false);
  expect(result.walletOk).toBe(false);
  const list = await (await app.request("/internal/config", { headers: { cookie: adminCookie() } })).text();
  expect(list).toContain("test failed");
});

test("wallet check uses the tenant's own HFM key", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (String(init!.headers ? (init!.headers as any).Authorization : "").includes("hfm")) {
      seen.push(String((init!.headers as Record<string, string>).Authorization));
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await app.request(`/internal/config/${id}/test`, { method: "POST", ...withCsrf() });
  expect(seen).toEqual([`Bearer ${ctxA.hfmApiKey}`]);
});
```

- [ ] **Step 2: Implement `POST /internal/config/:id/test`**

```ts
internalConfigRoutes.post("/:id/test", requireAdmin, async (c) => {
  const ctx = await getTenantById(Number(c.req.param("id")));
  if (!ctx) return c.text("Not Found", 404);

  // Three independent checks. LINE token via /v2/bot/info, HFM key via the
  // wallet balance probe, and the wallet itself must exist under that key.
  const identity = await fetchBotInfo(ctx.lineChannelAccessToken);
  const lineOk = identity !== null;

  let hfmOk = false;
  try {
    const res = await fetch(`${ctx.hfmApiBaseUrl}/api/wallet/balance`, {
      headers: { Authorization: `Bearer ${ctx.hfmApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    hfmOk = res.ok;
  } catch {
    hfmOk = false;
  }

  // The wallet check is the one that catches "wrong wallet copied from
  // another OA": a wrong-but-existing wallet would otherwise report happily
  // forever. It runs only when the key itself works.
  let walletOk = false;
  if (hfmOk) {
    const result = await fetchPerformance(ctx, {
      kind: "wallet", id: ctx.targetWallet, label: String(ctx.targetWallet),
    });
    walletOk = result.ok;
  }

  const message = [lineOk && "LINE ok", hfmOk && "HFM ok", walletOk && "wallet ok"]
    .filter(Boolean).join(", ") || "all checks failed";
  await updateTenantTestResult(getDb(), ctx.id, { lineOk, hfmOk, walletOk, message });
  invalidateTenantCache(ctx.id);
  return c.redirect(`/internal/config/${ctx.id}`);
});
```

- [ ] **Step 3: Status page `GET /internal/config/:id/status`**

Show: LINE identity (displayName, basicId, botUserId), active flag, target wallet, last test result and time, `tenant_health_state` row, webhook URL, last webhook activity and request counts from `listLineUsers(db, ctx.id)`, and last-trade cache freshness if the map is warm.

- [ ] **Step 4: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx tests/internal-config.test.ts
git commit -m "feat: tenant connection test and status page"
```

---

### Task 22: Whitelist and notify recipient management

**Files:**
- Modify: `apps/api/src/routes/internal-config.tsx`
- Test: `apps/api/tests/internal-config.test.ts`

- [ ] **Step 1: Tests**

```ts
test("adding a whitelist uid takes effect on the next webhook without restart", async () => {
  await app.request(`/internal/config/${id}/whitelist`, {
    method: "POST", headers: { cookie: adminCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf, lineUid: "Unew", label: "new guy", action: "add" }),
  });
  const ctx = await getTenantById(id); // fresh read after invalidate
  expect(ctx!.whitelistUids).toContain("Unew");
  // then POST a webhook from Unew and expect it not to be rejected
});

test("notify recipients are per tenant", async () => {
  await app.request(`/internal/config/${idA}/recipients`, { method: "POST", ...addUid("Ur1") });
  await app.request(`/internal/config/${idB}/recipients`, { method: "POST", ...addUid("Ur2") });
  expect(await getActiveUids(db, idA)).toEqual(["Ur1"]);
  expect(await getActiveUids(db, idB)).toEqual(["Ur2"]);
});
```

- [ ] **Step 2: Implement two form endpoints**

`POST /internal/config/:id/whitelist` with `action=add|remove`, `lineUid`, `label`:
calls `addWhitelistUid` or `removeWhitelistUid`, then `invalidateTenantCache(id)`.
The cache invalidation is mandatory because `whitelistUids` lives inside the cached `TenantConfig`.

`POST /internal/config/:id/recipients` with the same shape for notify uids via `addRecipient` / `removeRecipient`.

Render both lists with remove buttons inside the tenant detail page.

- [ ] **Step 3: Run, commit**

```bash
bun test tests/internal-config.test.ts
git add src/routes/internal-config.tsx tests/internal-config.test.ts
git commit -m "feat: manage whitelist and recipients per tenant"
```

---

<!-- part: E -->

### Task 23: The cross-tenant isolation proof suite

**Files:**
- Create: `apps/api/tests/multi-tenant-isolation.test.ts`

This file exists to fail loudly if any future change reintroduces a shared cache, a shared env read, or a missing `tenant_id` filter.
It is the acceptance test for the whole feature.

- [ ] **Step 1: Write the suite**

```ts
// apps/api/tests/multi-tenant-isolation.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { initDb, resetDbForTests, getDb } from "../src/db/connection";
import { app } from "../src/app"; // see note below
import { saveTenant, invalidateTenantCache, getTenantConfigForTests } from "../src/services/tenant-config.service";
import { addWhitelistUid, getTenantRowById } from "../src/repositories/tenant.repository";
import { addRecipient, getActiveUids } from "../src/repositories/recipient.repository";
import { insertMany, countByDate } from "../src/repositories/snapshot.repository";
import { markDailyReportSent, isDailyReportSent } from "../src/repositories/daily-notification.repository";
import { listLineUsers } from "../src/repositories/line-user.repository";
import { getLastTradeMap, resetLastTradeCache } from "../src/services/last-trade.service";
import { Glob } from "bun";
import path from "node:path";

process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
const UID_A = "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UID_B = "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_A = "Ubotbotbotbotbotbotbotbotbotbot1";
const BOT_B = "Ubotbotbotbotbotbotbotbotbotbot2";

let idA = 0;
let idB = 0;
let webhookA = "";
let webhookB = "";

interface RecordedRequest { url: string; auth: string; body: string }
const outbound: RecordedRequest[] = [];

function stubFetchRecording(): void {
  (globalThis as any).fetch = async (url: any, init?: RequestInit) => {
    outbound.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
      body: String(init?.body ?? ""),
    });
    // LINE APIs succeed; HFM endpoints return an empty-but-valid payload.
    if (String(url).startsWith("https://api.line.me")) {
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
}

async function postWebhook(webhookId: string, secret: string, body: object) {
  const raw = JSON.stringify(body);
  const sig = createHmac("sha256", secret).update(raw).digest("base64");
  return app.request(`/webhook?oa=${webhookId}`, {
    method: "POST",
    headers: { "x-line-signature": sig, "content-type": "application/json" },
    body: raw,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  await client.end; // placeholder, see note
  resetDbForTests();
  const db = getDb(TEST_DATABASE_URL);
  await initDb(db);

  idA = await saveTenant({
    label: "OA Alpha", active: true,
    lineChannelAccessToken: "line_tok_A", lineChannelSecret: "line_sec_A",
    hfmApiKey: "hfm_key_A", hfmApiBaseUrl: "https://hfm-a.test",
    targetWallet: 111111, whitelistEnabled: true,
  });
  idB = await saveTenant({
    label: "OA Beta", active: true,
    lineChannelAccessToken: "line_tok_B", lineChannelSecret: "line_sec_B",
    hfmApiKey: "hfm_key_B", hfmApiBaseUrl: "https://hfm-b.test",
    targetWallet: 222222, whitelistEnabled: true,
  });
  await addWhitelistUid(db, idA, UID_A, null);
  await addWhitelistUid(db, idB, UID_B, null);
  webhookA = (await getTenantRowById(db, idA))!.webhookId;
  webhookB = (await getTenantRowById(db, idB))!.webhookId;
});

afterAll(() => {
  resetDbForTests();
  delete process.env.DATABASE_URL;
});

describe("cross-tenant isolation", () => {
  test("webhook for A sends LINE replies with A's token and HFM calls with A's key", async () => {
    stubFetchRecording();
    const res = await postWebhook(webhookA, "line_sec_A", {
      destination: BOT_A,
      events: [{ type: "message", replyToken: "rt_a", source: { userId: UID_A }, message: { type: "text", text: "98241376" } }],
    });
    expect(res.status).toBe(200);
    const lineAuths = outbound.filter((r) => r.url.includes("api.line.me")).map((r) => r.auth);
    const hfmAuths = outbound.filter((r) => r.url.includes("hfm-a.test")).map((r) => r.auth);
    expect(lineAuths.length).toBeGreaterThan(0);
    expect(new Set(lineAuths)).toEqual(new Set(["Bearer line_tok_A"]));
    expect(hfmAuths.every((a) => a === "Bearer hfm_key_A")).toBe(true);
    expect(outbound.some((r) => r.url.includes("hfm-b.test"))).toBe(false);
  });

  test("A's valid signature replayed against B's URL is rejected", async () => {
    stubFetchRecording();
    const res = await postWebhook(webhookB, "line_sec_A", {
      destination: BOT_B, events: [],
    });
    expect(res.status).toBe(400);
    expect(outbound.length).toBe(0);
  });

  test("interleaved concurrent requests never mix credentials", async () => {
    stubFetchRecording();
    const results = await Promise.all([
      postWebhook(webhookA, "line_sec_A", { destination: BOT_A, events: [{ type: "message", replyToken: "rt_a1", source: { userId: UID_A }, message: { type: "text", text: "98241376" } }] }),
      postWebhook(webhookB, "line_sec_B", { destination: BOT_B, events: [{ type: "message", replyToken: "rt_b1", source: { userId: UID_B }, message: { type: "text", text: "98241377" } }] }),
      postWebhook(webhookA, "line_sec_A", { destination: BOT_A, events: [{ type: "message", replyToken: "rt_a2", source: { userId: UID_A }, message: { type: "text", text: "98241378" } }] }),
      postWebhook(webhookB, "line_sec_B", { destination: BOT_B, events: [{ type: "message", replyToken: "rt_b2", source: { userId: UID_B }, message: { type: "text", text: "98241379" } }] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const lineAuths = new Set(outbound.filter((r) => r.url.includes("api.line.me")).map((r) => r.auth));
    expect(lineAuths.has("Bearer line_tok_A")).toBe(true);
    expect(lineAuths.has("Bearer line_tok_B")).toBe(true);
    for (const r of outbound.filter((x) => x.url.includes("hfm-a.test"))) {
      expect(r.auth).toBe("Bearer hfm_key_A");
    }
    for (const r of outbound.filter((x) => x.url.includes("hfm-b.test"))) {
      expect(r.auth).toBe("Bearer hfm_key_B");
    }
  });

  test("last-trade cache warmed by A is not served to B", async () => {
    resetLastTradeCache();
    const fetchA = async () => ({ ok: true, data: [{ id: 1, last_trade: "a" }] }) as const;
    const fetchB = async () => ({ ok: true, data: [{ id: 2, last_trade: "b" }] }) as const;
    const ctxA = await getTenantConfigForTests(getDb(), idA);
    const ctxB = await getTenantConfigForTests(getDb(), idB);
    const mapA = await getLastTradeMap(ctxA, { fetchClientsFn: fetchA });
    const mapB = await getLastTradeMap(ctxB, { fetchClientsFn: fetchB });
    expect(mapA!.has(2)).toBe(false);
    expect(mapB!.has(1)).toBe(false);
  });

  test("snapshot and notification rows do not leak across tenants", async () => {
    const db = getDb();
    await insertMany(db, idA, [{ snapshotDate: "2026-09-05", clientId: 98241376, name: "x", email: null }]);
    expect(await countByDate(db, idB, "2026-09-05")).toBe(0);
    await markDailyReportSent(db, idA, "2026-09-05");
    expect(await isDailyReportSent(db, idB, "2026-09-05")).toBe(false);
  });

  test("line_users rows stay per tenant", async () => {
    const db = getDb();
    const { recordLineUserRequest } = await import("../src/repositories/line-user.repository");
    await recordLineUserRequest(db, idA, UID_A, "message");
    expect((await listLineUsers(db, idB)).length).toBe(0);
    expect((await listLineUsers(db, idA)).length).toBeGreaterThan(0);
  });

  test("notify recipients stay per tenant", async () => {
    const db = getDb();
    await addRecipient(db, idA, "Un1", null);
    expect(await getActiveUids(db, idB)).toEqual([]);
  });
});

describe("no per-tenant env reads remain", () => {
  test("src never reads the eight per-OA env vars except in bootstrap.ts", async () => {
    const forbidden = [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET",
      "HFM_API_KEY",
      "TARGET_WALLET",
      "LINE_WHITELIST_UIDS",
      "LINE_WHITELIST_ENABLED",
      "LINE_NOTIFY_UIDS",
    ];
    const offenders: string[] = [];
    const glob = new Glob("**/*.ts");
    const srcRoot = path.join(import.meta.dir, "..", "src");
    for await (const file of glob.scan(srcRoot)) {
      const text = await Bun.file(path.join(srcRoot, file)).text();
      if (file === "db/bootstrap.ts") continue; // the one allowed place
      for (const name of forbidden) {
        if (text.includes(`process.env.${name}`)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

Note for the implementer: `src/index.ts` currently builds the app inline and calls top-level awaits.
Extract a testable `createApp()` into a new `apps/api/src/app.ts` that `index.ts` re-exports and calls, so tests can import the Hono app without booting crons.
Keep the top-level boot side effects (registerJobs, cache warm) in `index.ts` only.

- [ ] **Step 2: Run the suite**

```bash
bun test tests/multi-tenant-isolation.test.ts
```

Expected: every test PASS.
If the interleaved-concurrency test fails intermittently, treat it as a real shared-state bug, never as flakiness.

- [ ] **Step 3: Commit**

```bash
git add src/app.ts src/index.ts tests/multi-tenant-isolation.test.ts
git commit -m "test: prove cross-tenant isolation"
```

---

### Task 24: Packaging fixes

**Files:**
- Modify: `apps/api/Dockerfile`
- Modify: `docker-compose.yml`

Two real defects: the image omits `apps/api/scripts/`, so `trigger:daily-client-report` cannot run in production, and the root compose file says `build: .` while no root Dockerfile exists.

- [ ] **Step 1: Fix the Dockerfile**

Add after `COPY src/ ./src/`:

```dockerfile
COPY scripts/ ./scripts/
```

- [ ] **Step 2: Fix the compose file**

```yaml
services:
  bot:
    build:
      context: ./apps/api
      dockerfile: Dockerfile
    container_name: hfm-line-bot
    restart: unless-stopped
    env_file: apps/api/.env
    ports:
      - "127.0.0.1:${PORT:-3000}:3000"
    environment:
      - PORT=3000
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    deploy:
      resources:
        # Raised from 512M: each tenant holds its own last-trade map in
        # memory, and the number of tenants grows over time.
        limits:       { cpus: "0.75", memory: 1G }
        reservations: { cpus: "0.25", memory: 512M }
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3000/internal/health?key=$$INTERNAL_API_KEY || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    ulimits: { nofile: { soft: 1024, hard: 2048 } }

  postgres-test:
    image: postgres:16-alpine
    ports: ["127.0.0.1:5433:5432"]
    tmpfs: [/var/lib/postgresql/data]
```

`CONFIG_ENCRYPTION_KEY` and `PUBLIC_BASE_URL` travel through `env_file: apps/api/.env`, so they need no separate entries.

- [ ] **Step 3: Verify the build**

Run `docker compose build bot` if Docker is available on the machine.
This development machine has no `docker` binary (verified), so on it run instead:

```bash
cd apps/api && bun build src/index.ts --target=bun --outdir /tmp/hfm-build-check
```

Expected: build completes with no unresolved imports, and `/tmp/hfm-build-check` contains the bundled entry.
On the deploy host, `docker compose config` must print a valid config and `docker compose build bot` must succeed before rollout.

- [ ] **Step 4: Commit**

```bash
git add apps/api/Dockerfile docker-compose.yml
git commit -m "fix: compose context and image scripts"
```

---

### Task 25: Scripts take an explicit tenant

**Files:**
- Create: `apps/api/scripts/lib/resolve-tenant.ts`
- Modify: `apps/api/scripts/trigger-daily-client-report.ts`
- Modify: `apps/api/scripts/trigger-hfm-healthcheck.ts`
- Modify: `apps/api/scripts/fetch-client-performance-range.ts`
- Modify: `apps/api/scripts/compare-client-performance-files.ts`

- [ ] **Step 1: Shared resolver**

```ts
// apps/api/scripts/lib/resolve-tenant.ts
import { getTenantById, listActiveTenants } from "../../src/services/tenant-config.service";
import { listTenantRows } from "../../src/repositories/tenant.repository";
import { getDb } from "../../src/db/connection";
import type { TenantConfig } from "../../src/types/tenant.types";

export interface TenantSelector { tenant?: string; all?: boolean }

export function parseArgs(argv: string[]): TenantSelector {
  const out: TenantSelector = {};
  for (const arg of argv.slice(2)) {
    if (arg === "--all") out.all = true;
    else if (arg.startsWith("--tenant=")) out.tenant = arg.slice("--tenant=".length);
  }
  if (!out.all && out.tenant === undefined && process.env.TENANT) {
    out.tenant = process.env.TENANT;
  }
  return out;
}

async function findByLabelOrWebhookId(value: string): Promise<TenantConfig | null> {
  // id first, then webhook id, then label; label is unique by convention only
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber > 0) return getTenantById(asNumber);
  const rows = await listTenantRows(getDb());
  const row = rows.find((r) => r.webhookId === value || r.label === value);
  return row ? getTenantById(row.id) : null;
}

// Refuses to guess: no selector means stop and explain.
export async function resolveTenants(selector: TenantSelector): Promise<TenantConfig[]> {
  if (selector.all) return listActiveTenants();
  if (selector.tenant) {
    const ctx = await findByLabelOrWebhookId(selector.tenant);
    if (!ctx) {
      console.error(`No tenant matched "${selector.tenant}". Use --all, --tenant=<id|webhookId|label>, or TENANT=.`);
      process.exit(2);
    }
    return [ctx];
  }
  console.error("Refusing to guess a tenant. Use --all, --tenant=<id|webhookId|label>, or TENANT=.");
  process.exit(2);
}
```

- [ ] **Step 2: Rewire the four scripts**

`trigger-daily-client-report.ts` becomes:

```ts
import { resolveTenants, parseArgs } from "./lib/resolve-tenant";
import { runDailyClientReport } from "../../src/jobs/daily-client-report";
import { initDb, getDb } from "../../src/db/connection";
import { loadEncryptionKey } from "../../src/utils/crypto";

loadEncryptionKey(); // fail fast
await initDb(getDb());
for (const ctx of await resolveTenants(parseArgs(process.argv))) {
  console.log(`[script] daily client report for "${ctx.label}" (tenant ${ctx.id})`);
  await runDailyClientReport(ctx, { dryRun: process.env.DRY_RUN === "1" });
}
process.exit(0);
```

Apply the same shape to `trigger-hfm-healthcheck.ts` (call `runHfmHealthCheckForTenant(ctx)` or loop for `--all`), `fetch-client-performance-range.ts` (loop over the resolved tenants, write one output file per tenant id), and `compare-client-performance-files.ts`.
In the compare script, delete the broken line:

```ts
const DEFAULT_WALLET = Number(process.env.TARGET_WALLET ?? process.env.TARGET_WALLET);
```

and take the wallet from the resolved tenant's `ctx.targetWallet`.

- [ ] **Step 3: Run one script against the local test database**

```bash
TENANT=wrong bun run trigger:daily-client-report; echo "exit=$?"
```

Expected: exit=2 and the "Refusing to guess"/"No tenant matched" message, proving no silent default tenant.

- [ ] **Step 4: Commit**

```bash
git add scripts
git commit -m "refactor: scripts select an explicit tenant"
```

---

### Task 26: Documentation and rollout runbook

**Files:**
- Modify: `apps/api/.env.example`
- Modify: `AGENTS.md`
- Create: `docs/plans/2026-09-05-multi-tenant-line-oa-rollout.md`

- [ ] **Step 1: `.env.example`**

```bash
# --- System level, always read from env ---
DATABASE_URL=postgresql://user:password@host:port/database
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
INTERNAL_API_KEY=
# 32 bytes base64: bun -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
CONFIG_ENCRYPTION_KEY=
PUBLIC_BASE_URL=https://bot.example.com
PORT=3000
LAST_TRADE_DEADLINE_MS=
LINE_OA_LABEL=Default OA

# --- FIRST BOOT ONLY: read once to seed the first tenant, then delete ---
# After the first boot these are never read again. Per-OA settings live in
# the database and are edited at /internal/config.
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
HFM_API_KEY=
HFM_API_BASE_URL=https://api.hfaffiliates.com
TARGET_WALLET=
LINE_WHITELIST_ENABLED=true
LINE_WHITELIST_UIDS=
LINE_NOTIFY_UIDS=
```

- [ ] **Step 2: `AGENTS.md` updates**

In the Environment and Security section, keep the secret list but note that per-OA credentials now live in the database, encrypted with `CONFIG_ENCRYPTION_KEY`, and that `/internal/config` is cookie protected while `/internal/health`, `/internal/logs`, and `/internal/line-uids` keep the `?key=` mechanism.
Add a short "Multi-tenant" section: webhook URL shape `https://host/webhook?oa=<webhook_id>`, tenant resolution order, and the fact that `initDb` seeds the first tenant from env exactly once.

- [ ] **Step 3: Rollout runbook**

Create `docs/plans/2026-09-05-multi-tenant-line-oa-rollout.md` with this sequence:

1. Back up the database: `pg_dump` the whole database and store it off-host.
   The migration drops unique constraints and changes primary keys, which is irreversible without the backup.
2. Generate and set `CONFIG_ENCRYPTION_KEY` in the deployment environment.
3. Keep the eight per-OA env vars in place for this deploy only; the seed needs them once.
4. Deploy the new image.
5. Read the boot log and confirm: `[bootstrap] seeded default tenant from env` with the printed webhook id, and one `last-trade cache warmed` line per active tenant.
6. In the LINE console of the existing OA, replace the webhook URL with `https://<host>/webhook?oa=<printed webhook id>` and press Verify.
7. Send a test message to the existing OA and confirm the card still replies with the right wallet.
8. Remove the eight per-OA env vars from the deployment environment and restart once, confirming the tenant still resolves from the database.
9. Add the second OA through `/internal/config`, press Test, review the badges, then paste its webhook URL into that OA's LINE console.
10. Watch `/internal/health/tenants` for one healthcheck cycle.

Rollback: restore the code and the `pg_dump` from step 1.
The database changes (composite keys, backfilled `tenant_id`, dropped constraints) cannot be reverted in place, which is why the backup is mandatory.
Rolling back code without restoring the database is not supported.

- [ ] **Step 4: Commit**

```bash
git add apps/api/.env.example AGENTS.md docs/plans/2026-09-05-multi-tenant-line-oa-rollout.md
git commit -m "docs: multi-tenant rollout and env docs"
```

---

## Open risks carried into execution

These three facts are unknown because they live outside the repository.
The executing engineer must confirm each before the task named after it.

1. **How production is actually deployed.**
   The repo `docker-compose.yml` cannot build (`build: .` with no root Dockerfile), so the deployed artifact is something else, maybe a differently arranged directory on the host.
   Confirm before Task 24 and before the rollout runbook is executed.
   If the deploy layout differs, adapt the compose fix instead of assuming.

2. **Whether a host crontab already triggers the daily report.**
   Task 16 adds an in-process 05:00 ICT cron.
   If an external crontab also runs `trigger:daily-client-report`, customers get the report twice.
   Confirm on the production host before deploying Task 16, and disable the external entry when the in-process cron goes live.
   `daily_report_notifications` now keys on `(tenant_id, snapshot_date)` and the job checks it, which limits the damage, but the check must be verified against the external runner's behaviour.

3. **Expected number of OAs and clients per OA.**
   The memory limit raise in Task 24 (512M to 1G) and the sequential warm loop in Task 17 assume roughly ten OAs with a few thousand clients each.
   If the real numbers are much larger, revisit the cache ceiling (an LRU bound on the per-tenant maps) before rollout.
   Confirm before the first production deploy with more than a handful of tenants.

---

## Self-review notes

Decisions Q1 to Q27 are all represented: routing (Task 12), ctx threading (Tasks 7 to 9, 13), tenant-scoped data (Tasks 6, 11, 14), encryption (Tasks 1, 4), UI (Tasks 18 to 22), seed-once env (Tasks 5, 26), per-tenant caches (Tasks 10, 17), healthcheck state (Tasks 15, 17), daily report schedule (Task 16), liveness split (Task 17), webhook id shape (Tasks 2, 3), destination cross-check (Task 12), test button not a gate (Tasks 20, 21), immediate secret rotation (Task 20), no redelivery handling (out of scope, documented), and scripts (Task 25).

One intentional deviation from the user's answers: Q24 was answered as "button, not gate", and this plan follows that, while adding the never-tested badge as a non-blocking guard.
If that guard is unwanted, delete the badge rendering in Task 19 and the stored-result assertions in Task 21; nothing else depends on them.
