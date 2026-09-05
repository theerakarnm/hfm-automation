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
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5433/hfm_test";

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
