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
