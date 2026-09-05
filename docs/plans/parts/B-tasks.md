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
