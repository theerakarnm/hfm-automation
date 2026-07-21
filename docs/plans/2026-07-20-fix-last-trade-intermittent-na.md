# Fix Intermittent "N/A" Last Trade in LINE Lookups Implementation Plan

> **Run with:** `/execute-plan <path-to-this-file>` - the runner that ticks these checkboxes.
>
> **For the executing agent:** This is a single sequential track (small fix over shared files).
> Implement tasks 1 -> 2 -> 3 -> 4 in order.
> Steps use checkbox (`- [ ]`) syntax; tick them as you go.
> Run the `## Preflight` checks BEFORE task 1 and report anything down.

**Goal:** Stop the LINE trading card from rendering Last Trade as "N/A" when the flaky HFM `/api/clients/` endpoint blips, by adding a retrying, cached, single-flight last-trade lookup service.
**Architecture:** A new module `last-trade.service.ts` owns an in-memory `Map<accountId, last_trade>` cache with a 5-minute TTL, retries the flaky upstream up to 3 times with short interactive backoff, serves stale cache on total failure, and coalesces concurrent callers into one in-flight fetch.
The webhook lookup path calls this service instead of hitting `fetchClients()` raw on every request.
**Tech Stack:** Bun runtime, TypeScript, Hono webhook, `bun:test`.
**Spec:** none - planned from conversation.

## Root cause (diagnosis)

User report: searching by wallet id or trading account number shows Last Trade "N/A" intermittently; retrying a couple of times then shows the correct value.

1. `apps/api/src/routes/webhook.ts:198-201` (`handleLookupAndReply`) calls `fetchClients()` - the ENTIRE client list from HFM `/api/clients/` - on every lookup, solely to build the `lastTradeByAccountId` map.
2. HFM `/api/clients/` is documented flaky: `apps/api/src/services/hfm.service.ts:222-227` intermittently returns 200 with empty `data: []`, which `fetchClients` collapses into `{ ok: false, reason: "server_error" }` (same flake previously fixed for snapshots in commit `4a8e179`).
3. On `!clientsResult.ok` the webhook silently falls back to an empty `Map`, so `last_trade` becomes `null` and `fmtLastTrade` (`apps/api/src/builders/flex-message.builder.ts:21-28`) renders `{ text: "N/A", color: "#DC2626" }`.
4. A user retry succeeds whenever the upstream flake clears - exactly the reported behavior.

Contributing factors: no retry in the webhook path (unlike `ensureTodaySnapshot` in `apps/api/src/jobs/daily-client-report.ts:244-281`), no caching (full-list fetch per lookup), and `fetchClients()` defaulting to a 120_000 ms timeout while the LINE loading indicator lasts only 20 s and reply tokens expire after about 1 minute.

**NOT building:**

- No change to `fmtLastTrade` rendering; "N/A" stays the fallback when data is truly absent.
- No distinction between "fetch failed" and "client never traded" in the card copy.
- No persistence of `last_trade` to the snapshot DB and no schema changes.
- No retry or caching changes to the daily-report or healthcheck paths.
- No change to the HFM upstream flake itself (external API, out of our control).

## Global Constraints

- Runtime is Bun.
  Use `bun test`, `bun run <script>`, `bunx`.
  Bun auto-loads `.env`, so do not add or use `dotenv`.
- All `bun` commands run from the `apps/api/` directory.
  All `git` commands run from the repo root (their pathspecs are repo-root-relative).
- The new unit test file must NOT require a database.
- Fix parameters are fixed values: fresh TTL 5 minutes, per-attempt fetch timeout 15_000 ms (NOT the 120_000 ms default), max 3 attempts, backoff 1000 ms then 2000 ms between attempts.
  Worst-case latency is 3 x 15 s + 3 s backoff = 48 s, which stays inside the ~60 s LINE reply-token window.
- Error logging goes through `logError("last-trade", err)`.
- Never use the em dash character in any file this plan writes; use a plain dash.

## Patterns to Mirror

### Retry loop shape (attempts + backoff between, not after the last)
<!-- SOURCE: apps/api/src/jobs/daily-client-report.ts:253-280 -->
```ts
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  const result = await fetchCurrent();
  let reason: string;
  if (result.ok) {
    const normalized = dedupeByCompositeKey(result.data).map(normalizeClientRow);
    if (normalized.length > 0) {
      await insertMany(db, today, normalized);
      return true;
    }
    reason = "empty client list";
  } else {
    reason = result.reason;
  }
  if (attempt < maxRetries) {
    const delayMs = attempt * 5_000;
    console.warn(/* ... */);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  } else {
    console.error(/* ... */);
  }
}
return false;
```
Mirror the shape (loop, check `result.ok`, sleep only when `attempt < max`), but use the interactive-scale delays 1000/2000 ms, not `attempt * 5_000`.

### Injectable dependencies for testability
<!-- SOURCE: apps/api/src/jobs/daily-client-report.ts:212-218 -->
```ts
export interface RunDailyClientReportOptions {
  now?: Date;
  db?: DrizzleDb;
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  reportPeriod?: ReportPeriod;
}
```
The new `GetLastTradeMapOptions` follows this exact injection style (`fetchClientsFn?`, plus `sleepFn?` and `nowMs?`).

### Error logging
<!-- SOURCE: apps/api/src/utils/logger.ts:19-25 -->
```ts
export function logError(context: string, error: unknown): void {
  const message =
    error instanceof Error
      ? `${error.message} | ${error.stack ?? ""}`
      : String(error);
  logger.error({ context }, message);
}
```

### Map build from client rows (the exact code being replaced)
<!-- SOURCE: apps/api/src/routes/webhook.ts:198-201 -->
```ts
const clientsResult = await fetchClients();
const lastTradeByAccountId = clientsResult.ok
  ? new Map(clientsResult.data.map((row) => [row.id, row.last_trade]))
  : new Map<number, string | null>();
```
The map is keyed by `row.id` (the account id) and consumed at `webhook.ts:207` via `lastTradeByAccountId.get(clientData.account_id)`.
Preserve that keying exactly.

### The upstream flake this fix defends against
<!-- SOURCE: apps/api/src/services/hfm.service.ts:222-227 -->
```ts
// HFM /api/clients/ intermittently returns 200 with an empty `data: []`.
// Treat that as a failure so the caller retries instead of saving an empty snapshot.
if (!Array.isArray(body.data) || body.data.length === 0) {
  logError("hfm-service", "fetchClients returned empty client list");
  return { ok: false, reason: "server_error" };
}
```
`fetchClients()` already collapses the empty-`data` flake into `{ ok: false, reason: "server_error" }`.
The service only needs to retry on `!result.ok`; it does not need to re-detect emptiness.

### Test conventions
<!-- SOURCE: apps/api/tests/daily-client-report.test.ts:1 -->
```ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
```
Follow this `bun:test` import style.
The new test adds `mock` (for call-count assertions) and does NOT import `postgres`/`drizzle`/`initDb`, keeping it DB-free.

## Preflight

The task-level Verify steps (typecheck and the scoped unit test) are pure local commands and need no infra.
These entries cover only the fuller checks in `## End-to-end verification`.

- Postgres `hfm_test` on :5432 - Check: `psql -h localhost -p 5432 -d hfm_test -c 'select 1'` - Needed by: the Task 2 Step 3 baseline capture and the full `bun test` run in End-to-end verification (DB-backed tests such as `tests/daily-client-report.test.ts` and `tests/webhook.test.ts` connect via `TEST_DATABASE_URL`, default `postgresql://jametirakarn@localhost:5432/hfm_test`).
  Note: at plan-authoring time this probe failed with `fe_sendauth: no password supplied` and `bun test tests/webhook.test.ts` failed all 13 tests with postgres `auth_failed` (28P01), so expect the DB-down branch unless credentials are supplied.
  If down: the DB-dependent suites fail for reasons unrelated to this fix; record that separately and do not treat it as a regression.
  The scoped run `bun test tests/last-trade.service.test.ts` does not touch it.
- LINE + HFM credentials in `apps/api/.env` - Check (from `apps/api`, because only Bun processes auto-load `.env`; a plain shell `test -n` would be a false negative): `bun -e 'process.exit(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET && process.env.HFM_API_KEY ? 0 : 1)'` - Needed by: the user-performed Manual verify (sending a wallet id to the live LINE bot).
  If absent: agree up front that the Manual box stays unchecked and the fix is validated by the unit tests only.

**Working-tree caveat (user must confirm at plan review):** The working tree already has uncommitted WIP that implements the Last Trade feature itself (the code exhibiting this bug): `apps/api/src/routes/webhook.ts`, `apps/api/src/types/hfm.types.ts` (adds `last_trade?: string | null` to `HFMPerformanceData`), and `apps/api/src/builders/flex-message.builder.ts` (adds `fmtLastTrade` and the card row).
Task 2 commits that WIP on its own so the fix commits stay clean.
The user may veto or adjust this (for example squash it into the fix, or amend an existing commit) before execution begins.

## Execution

Single sequential track.
Tasks run 1 -> 2 -> 3 -> 4 in order in the current worktree; no parallel tracks, no worktree leasing (treehouse not needed for a single track).
**Shared files:** `apps/api/src/routes/webhook.ts` is committed as pre-existing WIP in Task 2 and then modified in Task 4.
Because the track is sequential there is no cross-track conflict.
`apps/api/src/services/last-trade.service.ts` is created in Task 3 and imported in Task 4.

---

### Task 1: Fix the pre-existing typecheck failure in line.types.ts

`bun run typecheck` currently fails with 2 pre-existing errors unrelated to this bug (repo rule: fix failing checks you encounter, even unrelated ones):

```text
src/types/line.types.ts(59,11): error TS2339: Property 'postback' does not exist on type 'WebhookEvent'.
src/types/line.types.ts(60,18): error TS2339: Property 'postback' does not exist on type 'WebhookEvent'.
```

The `isPostbackEvent` type guard reads `event.postback` but the `WebhookEvent` base interface never declares it (unlike `message?`, which it does declare).
This fix is verified: adding the optional field makes `bunx tsc --noEmit` exit 0 against the current tree.

**Files:**
- Modify: `apps/api/src/types/line.types.ts:17-22` (anchor: `message?: {`, in `interface WebhookEvent`)

**Gotcha:** `line.types.ts` is currently UNMODIFIED in the working tree; the three WIP files are separate.
Stage only `line.types.ts` for this commit.

**Steps:**
- [x] Step 1: Add an optional `postback` field to `WebhookEvent`, directly after the `message?` field, mirroring the shape already declared on `PostbackEvent`:
      ```ts
      message?: {
        type: string;
        id: string;
        text?: string;
      };
      postback?: {
        data: string;
        params?: Record<string, string>;
      };
      ```
- [x] Step 2: Verify - Run: `bun run typecheck` - Expected: 0 errors.
- [x] Step 3: Commit - `git add apps/api/src/types/line.types.ts && git commit -m "fix: declare optional postback on WebhookEvent base type"`

---

### Task 2: Commit the existing Last Trade WIP

**Files:**
- Commit (already modified, do not re-edit): `apps/api/src/routes/webhook.ts`, `apps/api/src/types/hfm.types.ts` (anchor: `last_trade?: string | null`), `apps/api/src/builders/flex-message.builder.ts` (anchor: `fmtLastTrade`)

**Gotcha:** Do not fold the upcoming fix into this commit.
This commit captures only the already-present feature code so the later fix history is legible.
If the user opted to squash or amend instead (see Preflight caveat), follow that instead of creating a new commit.

**Steps:**
- [ ] Step 1: Confirm the three files above are the only ones MODIFIED (staging happens in Step 4) and that they contain the feature code, not fix code: `git status` and `git diff --stat`.
      Untracked entries such as `docs/plans/` are expected and stay untracked.
- [ ] Step 2: Verify - Run: `bun run typecheck` - Expected: 0 errors.
- [ ] Step 3: Note the pre-fix `bun test` baseline for later comparison: `bun test` - Expected: record pass/fail counts; do not fix failures here.
      Two known failure groups may appear: (a) if `hfm_test` Postgres is down per Preflight, every DB-backed suite fails with postgres errors; (b) if the DB is UP, exactly 3 lookup-path tests in `tests/webhook.test.ts` fail ("valid text message event shows loading before fetching HFM" at line 198, "T-prefix account lookup..." at line 290, "pagination splits clients..." at line 416) because the WIP inserts a `/api/clients/` fetch that shifts their asserted `fetchCalls` indices.
      Group (b) is EXPECTED here and is repaired by Task 4's test updates.
- [ ] Step 4: Commit - `git add apps/api/src/routes/webhook.ts apps/api/src/types/hfm.types.ts apps/api/src/builders/flex-message.builder.ts && git commit -m "feat: show Last Trade on trading lookup cards"`

---

### Task 3: Create the retrying, cached, single-flight last-trade service (test-first)

**Files:**
- Create: `apps/api/src/services/last-trade.service.ts`
- Test:   `apps/api/tests/last-trade.service.test.ts`

**Interfaces:**
- Consumes: `fetchClients(timeoutMs?: number): Promise<HFMClientsResult>` from `../services/hfm.service`; `logError(context: string, error: unknown): void` from `../utils/logger`; `HFMClientsResult` from `../types/hfm.types`.
- Produces (consumed by Task 4):
  - `getLastTradeMap(options?: GetLastTradeMapOptions): Promise<Map<number, string | null> | null>`
  - `resetLastTradeCache(): void`
  - `interface GetLastTradeMapOptions { fetchClientsFn?: () => Promise<HFMClientsResult>; sleepFn?: (ms: number) => Promise<void>; nowMs?: () => number; }`

**Gotcha:** Sleep only BETWEEN attempts, never after the final one (mirror `ensureTodaySnapshot`).
The single-flight guard must be checked AFTER the freshness check, and the in-flight promise must be cleared in a `.finally()` so a failed refresh does not wedge every future call.

**Steps:**
- [ ] Step 1: Write the DB-free test file first, then pin the red state.
      Verify - Run: `bun test tests/last-trade.service.test.ts` - Expected: fails (unresolved import of `../src/services/last-trade.service`).
      ```ts
      import { expect, test, describe, beforeEach, mock } from "bun:test";
      import {
        getLastTradeMap,
        resetLastTradeCache,
      } from "../src/services/last-trade.service";
      import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";

      function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
        return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
      }

      describe("getLastTradeMap", () => {
        beforeEach(() => {
          resetLastTradeCache();
        });

        test("maps row.id -> last_trade on a successful fetch", async () => {
          const rows = [
            makeRow({ id: 101, last_trade: "2026-07-19T10:00:00Z" }),
            makeRow({ id: 202, last_trade: null }),
          ];
          const fetchClientsFn = mock(
            async (): Promise<HFMClientsResult> => ({ ok: true, data: rows }),
          );
          const map = await getLastTradeMap({ fetchClientsFn });
          expect(map).not.toBeNull();
          expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
          expect(map!.get(202)).toBeNull();
          expect(fetchClientsFn).toHaveBeenCalledTimes(1);
        });

        test("retries within one call when the first fetch flakes then succeeds", async () => {
          const rows = [makeRow({ id: 101, last_trade: "2026-07-19T10:00:00Z" })];
          let calls = 0;
          const fetchClientsFn = mock(async (): Promise<HFMClientsResult> => {
            calls += 1;
            if (calls === 1) return { ok: false, reason: "server_error" };
            return { ok: true, data: rows };
          });
          const sleepFn = mock(async (_ms: number) => {});
          const map = await getLastTradeMap({ fetchClientsFn, sleepFn });
          expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
          expect(fetchClientsFn).toHaveBeenCalledTimes(2);
          expect(sleepFn).toHaveBeenCalledWith(1000);
        });

        test("returns null after 3 failed attempts with no cache", async () => {
          const fetchClientsFn = mock(
            async (): Promise<HFMClientsResult> => ({ ok: false, reason: "server_error" }),
          );
          const sleepFn = mock(async (_ms: number) => {});
          const map = await getLastTradeMap({ fetchClientsFn, sleepFn });
          expect(map).toBeNull();
          expect(fetchClientsFn).toHaveBeenCalledTimes(3);
        });

        test("serves stale cache when a later refresh fully fails", async () => {
          let now = 0;
          const nowMs = () => now;
          const okFetch = mock(
            async (): Promise<HFMClientsResult> => ({
              ok: true,
              data: [makeRow({ id: 101, last_trade: "A" })],
            }),
          );
          const first = await getLastTradeMap({ fetchClientsFn: okFetch, nowMs });
          expect(first!.get(101)).toBe("A");

          now = 6 * 60 * 1000; // past the 5-minute TTL
          const failFetch = mock(
            async (): Promise<HFMClientsResult> => ({ ok: false, reason: "server_error" }),
          );
          const sleepFn = mock(async (_ms: number) => {});
          const second = await getLastTradeMap({ fetchClientsFn: failFetch, sleepFn, nowMs });
          expect(second!.get(101)).toBe("A");
          expect(failFetch).toHaveBeenCalledTimes(3);
        });

        test("does not refetch while the cache is fresh", async () => {
          let now = 0;
          const nowMs = () => now;
          const fetchClientsFn = mock(
            async (): Promise<HFMClientsResult> => ({
              ok: true,
              data: [makeRow({ id: 101, last_trade: "A" })],
            }),
          );
          await getLastTradeMap({ fetchClientsFn, nowMs });
          now = 60 * 1000; // 1 minute later, still within TTL
          const second = await getLastTradeMap({ fetchClientsFn, nowMs });
          expect(second!.get(101)).toBe("A");
          expect(fetchClientsFn).toHaveBeenCalledTimes(1);
        });

        test("coalesces concurrent callers into one in-flight fetch", async () => {
          let resolveFetch!: (r: HFMClientsResult) => void;
          const fetchClientsFn = mock(
            () =>
              new Promise<HFMClientsResult>((res) => {
                resolveFetch = res;
              }),
          );
          const p1 = getLastTradeMap({ fetchClientsFn });
          const p2 = getLastTradeMap({ fetchClientsFn });
          resolveFetch({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] });
          const [m1, m2] = await Promise.all([p1, p2]);
          expect(m1!.get(101)).toBe("A");
          expect(m2).toBe(m1);
          expect(fetchClientsFn).toHaveBeenCalledTimes(1);
        });
      });
      ```
- [ ] Step 2: Implement the service.
      ```ts
      import { fetchClients } from "./hfm.service";
      import { logError } from "../utils/logger";
      import type { HFMClientsResult } from "../types/hfm.types";

      const FRESH_TTL_MS = 5 * 60 * 1000;
      const FETCH_TIMEOUT_MS = 15_000;
      const MAX_ATTEMPTS = 3;
      const BACKOFF_MS = [1000, 2000]; // between attempts 1->2 and 2->3

      type LastTradeMap = Map<number, string | null>;

      interface CacheEntry {
        map: LastTradeMap;
        fetchedAt: number;
      }

      let cache: CacheEntry | null = null;
      let inflight: Promise<LastTradeMap | null> | null = null;

      export interface GetLastTradeMapOptions {
        fetchClientsFn?: () => Promise<HFMClientsResult>;
        sleepFn?: (ms: number) => Promise<void>;
        nowMs?: () => number;
      }

      const defaultSleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      export function resetLastTradeCache(): void {
        cache = null;
        inflight = null;
      }

      // Fetches the account-id -> last_trade map, retrying the flaky HFM
      // /api/clients/ endpoint and serving a short-lived cache. Returns null
      // only when every attempt fails and no prior cache exists.
      export async function getLastTradeMap(
        options: GetLastTradeMapOptions = {},
      ): Promise<LastTradeMap | null> {
        const now = options.nowMs ?? Date.now;
        const sleep = options.sleepFn ?? defaultSleep;
        const fetchClientsFn =
          options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));

        if (cache && now() - cache.fetchedAt < FRESH_TTL_MS) {
          return cache.map;
        }

        // Single-flight: concurrent callers share one refresh.
        if (inflight) return inflight;

        inflight = refresh(fetchClientsFn, sleep, now).finally(() => {
          inflight = null;
        });
        return inflight;
      }

      async function refresh(
        fetchClientsFn: () => Promise<HFMClientsResult>,
        sleep: (ms: number) => Promise<void>,
        now: () => number,
      ): Promise<LastTradeMap | null> {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const result = await fetchClientsFn();
          if (result.ok) {
            const map: LastTradeMap = new Map(
              result.data.map((row) => [row.id, row.last_trade]),
            );
            cache = { map, fetchedAt: now() };
            return map;
          }
          logError(
            "last-trade",
            new Error(
              `getLastTradeMap attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
            ),
          );
          if (attempt < MAX_ATTEMPTS) {
            await sleep(BACKOFF_MS[attempt - 1]!);
          }
        }

        if (cache) {
          logError(
            "last-trade",
            new Error("getLastTradeMap fetch failed; serving stale cache"),
          );
          return cache.map;
        }
        logError(
          "last-trade",
          new Error("getLastTradeMap fetch failed; no cache available"),
        );
        return null;
      }
      ```
- [ ] Step 3: Verify - Run: `bun test tests/last-trade.service.test.ts && bun run typecheck` - Expected: 6 pass, 0 fail; typecheck 0 errors.
- [ ] Step 4: Commit - `git add apps/api/src/services/last-trade.service.ts apps/api/tests/last-trade.service.test.ts && git commit -m "fix: add retrying cached last-trade lookup service"`

---

### Task 4: Route the webhook lookup through the new service and repair the lookup-path tests

**Files:**
- Modify: `apps/api/src/routes/webhook.ts:4` (anchor: `from "../services/hfm.service"`), `apps/api/src/routes/webhook.ts:198-201` (anchor: `const clientsResult = await fetchClients();`, in `handleLookupAndReply`)
- Modify: `apps/api/tests/webhook.test.ts:1-12` (anchor: `const ORIGINAL_FETCH`), `:51-68` (anchor: `beforeEach(async () => {`), and the 3 lookup tests (anchors: `"valid text message event shows loading before fetching HFM"`, `"T-prefix account lookup resolves wallet via client_id"`, `"pagination splits clients in chunks of 5"`)

**Interfaces:**
- Consumes: `getLastTradeMap(options?: GetLastTradeMapOptions): Promise<Map<number, string | null> | null>` and `resetLastTradeCache(): void` from Task 3.

**Gotcha 1:** After the swap, `fetchClients` is no longer referenced in `webhook.ts` (it was only used at line 198).
Remove it from the import on line 4 so the file has no unused import.
Do not touch the rest of the import list.

**Gotcha 2:** The 3 lookup tests assert exact `fetchCalls` index sequences (for example `fetchCalls[2]?.url` is the LINE reply at line 287) and use a 500 ms `waitFor` budget.
The production path calls `getLastTradeMap()` with NO injected `sleepFn`, so if the service actually refreshes inside a test whose catch-all mock returns `{}` (which `fetchClients` maps to `ok: false`), the test eats 3 attempts plus 1000 + 2000 ms of real sleep and times out.
The fix below avoids that entirely by PRE-WARMING the cache with an injected `fetchClientsFn` before dispatching the webhook request: the fresh cache (5-minute TTL vs millisecond test duration) makes the production `getLastTradeMap()` return instantly with zero `/api/clients/` fetch, so every existing `fetchCalls` index assertion holds unchanged.
Pre-warm INSIDE each lookup test (after installing its fetch mock, before `app.fetch`), not in `beforeEach`, so each test controls its own rows.

**Steps:**
- [ ] Step 1: In `webhook.ts`, add the service import near the other service imports (after line 5).
      ```ts
      import { getLastTradeMap } from "../services/last-trade.service";
      ```
- [ ] Step 2: In `webhook.ts`, drop `fetchClients` from the `hfm.service` import so line 4 reads:
      ```ts
      import { fetchPerformance, resolveLinkedAccounts, checkConditions, parsePerformanceLookup } from "../services/hfm.service";
      ```
- [ ] Step 3: In `webhook.ts`, replace the raw fetch-and-build block at lines 198-201 with the cached lookup.
      Preserve the existing empty-map fallback so a `null` return still renders "N/A" exactly as today (no behavior change on true failure).
      ```ts
      const lastTradeByAccountId =
        (await getLastTradeMap()) ?? new Map<number, string | null>();
      ```
      Leave the `bubbles` mapping at lines 203-210 untouched; it still calls `lastTradeByAccountId.get(clientData.account_id)`.
- [ ] Step 4: In `tests/webhook.test.ts`, add the service imports after the existing imports (line 7):
      ```ts
      import {
        getLastTradeMap,
        resetLastTradeCache,
      } from "../src/services/last-trade.service";
      import type { HFMClientRow } from "../src/types/hfm.types";
      ```
      Add `resetLastTradeCache();` as the last line of the `beforeEach` (after `await setupTestDb();`) and as the first line of the `afterEach`.
- [ ] Step 5: In the test `"valid text message event shows loading before fetching HFM"`, directly after the `globalThis.fetch = ...` mock assignment and before `app.fetch(...)`, pre-warm the cache with a row matching the mocked `account_id` 78451293:
      ```ts
      await getLastTradeMap({
        fetchClientsFn: async () => ({
          ok: true,
          data: [{ id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow],
        }),
      });
      ```
      Then extend the test's final assertions (after the existing `fetchCalls[2]?.url` check at line 287) with a Last Trade rendering check:
      ```ts
      expect(fetchCalls[2]?.body).toContain("18/07/2026 09:30");
      ```
      (`fmtLastTrade` formats with `dayjs.utc(raw).format("DD/MM/YYYY HH:mm")`.)
- [ ] Step 6: In the tests `"T-prefix account lookup resolves wallet via client_id and returns all linked accounts"` and `"pagination splits clients in chunks of 5 and appends pagination card, postback navigates correctly"`, add the same pre-warm call directly after their `globalThis.fetch = ...` mock assignments, but with empty rows (their assertions do not inspect Last Trade; an empty map renders "N/A" exactly as before):
      ```ts
      await getLastTradeMap({
        fetchClientsFn: async () => ({ ok: true, data: [] as HFMClientRow[] }),
      });
      ```
      In the pagination test the single pre-warm before the first `app.fetch` also covers the postback dispatch later in the test (same 5-minute TTL window).
      Leave every existing assertion in all 3 tests untouched.
- [ ] Step 7: Verify - Run: `bun run typecheck && bun test tests/last-trade.service.test.ts && bun test tests/webhook.test.ts` - Expected: typecheck 0 errors (proves `fetchClients` is not left dangling and the new import resolves); service tests 6 pass, 0 fail; `webhook.test.ts` 13 pass, 0 fail when `hfm_test` Postgres is up - if the DB is down (Preflight), all 13 fail with postgres `auth_failed`/connection errors, which is the declared DB-down branch, not a regression of this task.
- [ ] Step 8: Commit - `git add apps/api/src/routes/webhook.ts apps/api/tests/webhook.test.ts && git commit -m "fix: use cached last-trade service in LINE lookup path"`

## End-to-end verification

- [ ] Run: `bun run typecheck` (from `apps/api`) - Expected: 0 errors.
- [ ] Run: `bun test tests/last-trade.service.test.ts` (from `apps/api`) - Expected: 6 pass, 0 fail.
- [ ] Run: `bun test` (from `apps/api`) - Expected: no NEW failures versus the Task 2 Step 3 baseline, and if `hfm_test` Postgres is up, the 3 lookup-path tests in `tests/webhook.test.ts` that failed in the group-(b) baseline now pass (DB-dependent suites require the Postgres from Preflight; a pre-existing DB-down failure is not a regression).
- [ ] Manual (user-performed, needs LINE + HFM creds in `.env` and a running dev server via `bun run dev`): send a wallet id or `T`-prefixed trading account number to the LINE bot and confirm the card shows a Last Trade date, then resend the same query several times and confirm it stays a date every time (no intermittent "N/A").
      Expected: Last Trade renders a real date consistently across repeated sends.
