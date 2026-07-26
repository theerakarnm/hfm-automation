# Fix Silent First Wallet Lookup Implementation Plan

> **Run with:** `/execute-plan docs/plans/2026-07-26-fix-silent-first-lookup.md` - the runner that ticks these
> checkboxes and honours the track layout below.
>
> **For the executing agent:** This plan is a single sequential track.
> Steps use checkbox (`- [ ]`) syntax for tracking; tick them as you go.
> Run the `## Preflight` checks BEFORE task 1 and report anything down.

**Goal:** A customer who sends a Wallet ID always gets a reply on the first message - either the Trading Account Summary card or a "please try again" notice - instead of silence that forces them to send the ID a second time.

**Architecture:** The LINE reply path blocks on `getLastTradeMap()`, which hits the 1.5 MB `/api/clients/` endpoint that needs ~7.4s even when healthy and up to 48s when it flakes through its 3-attempt retry ladder.
That pushes the reply past LINE's 60s reply-token window, and every failure downstream of that lands on a bare `.catch(logError)` in the webhook dispatcher, so the customer sees nothing at all.
The fix makes the last-trade lookup non-blocking (stale-while-revalidate plus a hard deadline in the request path, warmed at boot), and makes every failure path end in a user-visible message by falling back from `reply` to `push` when the reply token is dead.

**Tech Stack:** Bun 1.3.5, Hono, Drizzle + postgres-js, croner, pino, `bun:test`.

**Spec:** none - planned from conversation. Root cause was established from the customer screenshot (two Wallet ID messages at 02:58 and 02:59, one card) plus direct measurement of the HFM API (see Root cause evidence below).

**Root cause evidence (measured 2026-07-26, do not re-litigate):**

- `GET https://api.hfaffiliates.com/api/clients/` with the repo's real `HFM_API_KEY`: 3 consecutive calls returned `status=200 ms=7467 / 7270 / 7391`, `bytes=1565387`, `rows=2709`. **~7.4s is the healthy latency, not the failure case.**
- `apps/api/src/routes/webhook.ts:199-200` awaits `getLastTradeMap()` *after* the wallet fetch already succeeded, so its cost is added to every reply.
- Cold-cache worst case in `apps/api/src/services/last-trade.service.ts:63-79`: 3 attempts x `FETCH_TIMEOUT_MS` 15s + backoff 1s + 2s = **48s**, on top of `fetchPerformance`'s 10s ceiling (`hfm.service.ts:97`) = **58s** for a wallet lookup and **68s** for a `T`-prefix lookup.
- LINE requires the reply token to be used within **60 seconds** ([Send messages | LINE Developers](https://developers.line.biz/en/docs/messaging-api/sending-messages/)). Past that, `replyMessage` throws at `line.service.ts:63-68`.
- That throw propagates to `webhook.ts:60` `processTextEvent(event).catch((err) => logError("webhook", err))` - **logged, never surfaced**. The customer gets silence.
- The second message succeeds because the first message's background fetch has by then populated the 5-minute cache (`last-trade.service.ts:45-47`), so the reply lands in ~1s.

**NOT building:**

- No change to the `/api/clients/` retry ladder, `MAX_ATTEMPTS`, `BACKOFF_MS`, or `FETCH_TIMEOUT_MS`. The ladder is correct; it just must not run in the request path.
- No caching of `fetchPerformance` (the per-wallet call). It is fast and must stay live.
- No new cron job. Cache warming is boot-time plus demand-driven revalidation, so an idle bot issues zero background traffic.
- No LINE webhook redelivery / retry configuration.
- No change to the whitelist-reject or bad-format replies (`webhook.ts:76-79`, `:120-123`, `:148-151`). Those fire before any HFM call, so their reply token is always fresh.
- No change to the report command path (`webhook.ts:96-115`). It already replies on error.
- No change to `daily-client-report.ts`'s `console.warn`/`console.error` deviation from `logError`.
- No redesign of the Trading Account Summary card layout.

## Global Constraints

- Bun only. `bun <file>`, `bun test`, `bun install`, `bunx` - never node/npm/jest/vitest (`apps/api/AGENTS.md`).
- All work is inside `apps/api/`. Run every command from `/Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation/apps/api`.
- Never use the em dash character in new prose or new comments. Use a plain dash. (Pre-existing occurrences in code strings and test names are quoted verbatim and must not be touched.)
- Thai user-facing strings in `src/routes/webhook.ts` are stored as `\uXXXX` escape sequences, not literal Thai glyphs. Any new Thai string must follow that encoding exactly.
- `logError(context: string, error: unknown)` takes a **plain string** for expected/flake conditions and an `Error` for real throws (convention enforced by commit `902585c`).
- **Every customer-facing send in `src/routes/webhook.ts` is gated by `isWhitelisted(userId)`.** Both handlers reject non-whitelisted users before doing any work (`webhook.ts:75-81`, `:147-153`). Any new send path added by this plan must respect that gate, or the bot starts answering users it is supposed to ignore.
- Never create a file longer than 500 lines.
- Do not remove pre-existing dead code, and do not reformat adjacent lines.

## Patterns to Mirror

### Naming - service exports are camelCase verbs, options objects carry injectable seams

<!-- SOURCE: apps/api/src/services/last-trade.service.ts:20-32 -->
```ts
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
```

### Naming - LINE senders are arrow-const wrappers over a private `Message` function

<!-- SOURCE: apps/api/src/services/line.service.ts:102-115 -->
```ts
export const replyText = (replyToken: string, text: string) =>
  replyMessage(replyToken, { type: "text", text });

export const replyTexts = (replyToken: string, texts: string[]) =>
  replyMessages(
    replyToken,
    texts.map((text) => ({ type: "text", text })),
  );

export const replyFlex = (
  replyToken: string,
  altText: string,
  contents: object
) => replyMessage(replyToken, { type: "flex", altText, contents });
```

### Error handling - HFM fetches never throw, they return a discriminated result

<!-- SOURCE: apps/api/src/services/hfm.service.ts:135-144 -->
```ts
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      logError("hfm-service", `Request timeout for ${lookup.kind} ${lookup.id}`);
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
```

### Error handling - LINE senders log then rethrow

<!-- SOURCE: apps/api/src/services/line.service.ts:63-68 -->
```ts
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE reply failed ${res.status}: ${errText}`);
    logError("line-service", err);
    throw err;
  }
```

### Error handling - a flake message is logged as a plain string, not an Error

<!-- SOURCE: apps/api/src/services/last-trade.service.ts:72-75 -->
```ts
    logError(
      "last-trade",
      `getLastTradeMap attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
    );
```

### Tests - pure service tests inject seams via the options object and `mock()`

<!-- SOURCE: apps/api/tests/last-trade.service.test.ts:1-15 -->
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
```

### Tests - LINE service tests monkeypatch `globalThis.fetch` and assert on parsed bodies

<!-- SOURCE: apps/api/tests/line.service.test.ts:1-21 -->
```ts
import { expect, test, describe, afterEach } from "bun:test";
import { pushToAll } from "../src/services/line.service";

const ORIGINAL_FETCH = globalThis.fetch;

describe("pushToAll", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("sends to each UID sequentially", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body.to);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await pushToAll(["U001", "U002", "U003"], "hello");
    expect(calls).toEqual(["U001", "U002", "U003"]);
  });
```

### Tests - webhook tests poll, because the handler is fire-and-forget

<!-- SOURCE: apps/api/tests/webhook.test.ts:25-36 -->
```ts
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for webhook background work");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

### Tests - webhook tests import the route fresh per test with env preset

<!-- SOURCE: apps/api/tests/webhook.test.ts:926-939 -->
```ts
async function importWebhook() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  process.env.HFM_API_KEY = "test_hfm_key";
  process.env.HFM_API_BASE_URL = "https://api.hfaffiliates.com";
  resetDbForTests();
  const webhookMod = await import("../src/routes/webhook");
  const app = new Hono();
  app.route("/webhook", webhookMod.default);
  return { app };
}
```

## Codebase facts the tasks rely on

Every fact below is load-bearing for a step and is stated here so no task requires opening a file to be written.

- **`uid` binding.** Inside the webhook route's event loop, `webhook.ts:55` already declares `const uid = event.source?.userId;`. Task 4 Step 3's `if (uid) void notifyRetry(replyToken, uid);` uses that existing binding; it declares nothing new.
- **`replyToken` is non-optional on both event types.** `TextMessageEvent.replyToken: string` (`src/types/line.types.ts:30`) and `PostbackEvent.replyToken: string` (`:50`) both narrow the optional field on the shared base type, so Task 4 Step 3's `const { replyToken } = event;` typechecks in both branches.
- **`handleLookupAndReply` already has `userId` in scope.** Its signature is `async function handleLookupAndReply(replyToken: string, userId: string, lookup: PerformanceLookup, page: number = 1): Promise<void>` (`webhook.ts:172-177`). Task 4 Step 5 passes that existing parameter; no signature change is needed.
- **`isWhitelisted` defaults to allowing everyone.** `export function isWhitelisted(userId: string): boolean` (`src/utils/whitelist.ts`) returns `true` when `LINE_WHITELIST_ENABLED` is unset, *and* returns `true` when `LINE_WHITELIST_UIDS` is empty or unset. `tests/webhook.test.ts` deletes both vars in `afterEach` and never sets them for the new tests, so `Uabc123` is whitelisted by default. That is what lets Task 4's three new tests reach the lookup path at all, and why Task 4 Step 4's guard does not break them.
- **Card assertion strings.** `"Trading Account Summary"` is the literal header text at `src/builders/flex-message.builder.ts:222`. `"N/A"` is emitted by `fmtLastTrade` at `flex-message.builder.ts:21-28` when `last_trade` is null or absent. Tasks 2 and 4 assert on both.
- **Current test counts by file:** `webhook.test.ts` 13, `line.service.test.ts` 4, `last-trade.service.test.ts` 6, `line-uids.test.ts` 8, `sqlite.service.test.ts` 3 (1 pass, 2 fail). Suite total `Ran 181 tests`.

## Preflight

Every command below was executed while writing this plan; the pasted output is real.

- **Bun toolchain** - Check: `bun --version` - Output when planned: `1.3.5`. Needed by: every task.
- **Dependencies installed** - Check: `cd apps/api && bun install` - Note: `apps/*` are **independent** Bun projects. There is no root `package.json` and no workspace file, so `bun install` at the repo root does nothing useful. Always install from `apps/api`.
- **Postgres test database** - Check: `psql "postgresql://jametirakarn@localhost:5432/hfm_test" -c "select 1"` - Output when planned:
  ```
   ?column?
  ----------
          1
  (1 row)
  ```
  Needed by: Tasks 2, 4, 5, 6, 7 and the full-suite verifies. Task 6's Manual verify boots the real app, and `src/index.ts:10-11` does `getDb()` plus a top-level `await initDb(db)`, so the process dies at startup without a reachable `DATABASE_URL`. `tests/webhook.test.ts:14-15` defaults to this URL when `TEST_DATABASE_URL` is unset. If down: STOP and ask, do not defer those verifies to the end. (Note `.env.example` advertises `postgresql://test:test@localhost:5433/hfm_test`, which is **not** what works on this machine - use the default above or export `TEST_DATABASE_URL`.)
- **Baseline test suite** - Check: `cd apps/api && bun test` - Output when planned: `179 pass, 2 fail, 420 expect() calls, Ran 181 tests across 17 files`. The 2 failures are **pre-existing and unrelated** to this bug, both in `tests/sqlite.service.test.ts`; Task 7 fixes them. Every earlier task's full-suite expectation accounts for them.
- **Baseline typecheck** - Check: `cd apps/api && bun run typecheck` - Output when planned: clean, no diagnostics.
- **HFM API credentials** (End-to-end verification only) - Check: `test -n "$HFM_API_KEY"` after loading `apps/api/.env`, then `bun -e 'const r = await fetch((process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com") + "/api/clients/", { headers: { Authorization: "Bearer " + process.env.HFM_API_KEY } }); console.log(r.status)'` - Output when planned: `200` after ~7.4s. Needed by: **Task 6 Step 4's Manual verify** (it asserts the warm log reports a non-zero `size`, which only a real API call produces) and the whole End-to-end verification section. No other task-level Verify needs it. If absent: agree up front that Task 6 Step 4 and the End-to-end Manual items stay unticked, rather than discovering it at the end.
- **Free port 3000** - Check: `lsof -i :3000` returns nothing. Needed by: Task 6's Manual verify and End-to-end verification.

## Execution

**Tracks:** single sequential track. Tasks 2, 4, and 5 all modify `src/routes/webhook.ts`, and Tasks 2 and 6 both depend on Task 1's new export, so there is no genuinely independent work to parallelise. No treehouse worktree is needed; work on one branch in the primary checkout.

**Branch:** create `fix/silent-first-lookup` off `main` before Task 1.

**Order:** 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7, strictly.

**Shared files:** `src/routes/webhook.ts` (Tasks 2, 4, 5) and `tests/webhook.test.ts` (Tasks 2, 4, 5). Sequential execution owns them; no cross-track coordination required. Single-owner files: `.env.example` (Task 2 only) and `src/index.ts`, the app/route registration entry point (Task 6 only). `package.json` and the lockfile are not touched by any task - this plan adds no dependency, so no `bun install` is needed mid-run.

**Failure-mode coverage matrix.** The "customer always gets a reply" guarantee is quantified over failure modes; this is where each is proven:

| Failure mode | Covered by |
| --- | --- |
| `/api/clients/` hangs or is slow (cold cache) | Task 2 test, `replies with the card even when the last-trade fetch hangs` |
| `/api/clients/` fully fails, cache exists | Task 1 test, `serves stale cache immediately and refreshes in the background` |
| HFM `server_error` on the wallet fetch | Task 4 test, `HFM server error replies with the HFM-down notice instead of silence` |
| HFM `not_found` / `timeout` / `no_wallet` | Same `replyOrPushText` call site as `server_error` (`handleLookupAndReply`'s single error send); the `server_error` test exercises that line. Behaviour of the branches themselves is unchanged by this plan. |
| Reply token expired | Task 4 test, `an expired reply token falls back to pushing the card` |
| Reply **and** push both rejected for the card | Task 4 test, `a total send failure still pushes the try-again notice` |
| Postgres unreachable | Task 5 test, `a database failure does not stop the lookup reply` |
| Non-whitelisted user | Task 4 test, `a non-whitelisted user gets no retry notice when their rejection fails` |

---

### Track A

#### Task 1: Make the last-trade lookup non-blocking

**Files:**

- Modify: `apps/api/src/services/last-trade.service.ts` (anchor: `export async function getLastTradeMap`)
- Test: `apps/api/tests/last-trade.service.test.ts` (anchor: `describe("getLastTradeMap"`)

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `export async function getLastTradeMapWithin(deadlineMs: number, options?: GetLastTradeMapOptions): Promise<Map<number, string | null> | null>` - consumed by Task 2.
  - `getLastTradeMap` keeps its existing signature but gains stale-while-revalidate behaviour: when a cache exists but has aged past `FRESH_TTL_MS`, it returns the stale map **immediately** and refreshes in the background instead of blocking the caller.

**Gotcha:** the existing test `"serves stale cache when a later refresh fully fails"` (`tests/last-trade.service.test.ts:57-77`) asserts `expect(failFetch).toHaveBeenCalledTimes(3)` **synchronously** after the call returns. Stale-while-revalidate makes that call return before the retry ladder finishes, so this assertion will fail unless the test is rewritten to poll. Rewriting it is part of this task, not a deviation.

**Steps:**

- [x] Step 1: Create the branch.
      ```bash
      cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
      git checkout -b fix/silent-first-lookup
      ```

- [x] Step 2: In `apps/api/src/services/last-trade.service.ts`, replace the body of `getLastTradeMap` (from `export async function getLastTradeMap(` down to the closing `}` immediately before `async function refresh`) with the stale-while-revalidate version. Keep the existing doc comment above it unchanged.
      ```ts
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
        if (!inflight) {
          inflight = refresh(fetchClientsFn, sleep, now).finally(() => {
            inflight = null;
          });
        }
        const refreshing = inflight;

        // Stale-while-revalidate: /api/clients/ needs ~7s even when healthy, so
        // an expired cache is handed back immediately while the refresh warms it
        // for the next lookup. Only a completely cold cache blocks the caller.
        if (cache) {
          refreshing.catch((err) => logError("last-trade", err));
          return cache.map;
        }

        return refreshing;
      }
      ```

- [x] Step 3: In the same file, append `getLastTradeMapWithin` immediately after `getLastTradeMap` and before `async function refresh`.
      ```ts
      // Same contract as getLastTradeMap but never blocks the caller longer than
      // deadlineMs. On a cold cache the retry ladder can run for ~48s, which does
      // not fit inside LINE's 60s reply-token window; past the deadline we hand
      // back whatever cache exists (possibly none) and let the refresh finish in
      // the background so the next lookup is warm.
      export async function getLastTradeMapWithin(
        deadlineMs: number,
        options: GetLastTradeMapOptions = {},
      ): Promise<LastTradeMap | null> {
        const pending = getLastTradeMap(options).catch((err) => {
          logError("last-trade", err);
          return null;
        });

        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<LastTradeMap | null>((resolve) => {
          timer = setTimeout(() => {
            logError(
              "last-trade",
              `getLastTradeMapWithin exceeded ${deadlineMs}ms; replying without a fresh map`,
            );
            resolve(cache?.map ?? null);
          }, deadlineMs);
        });

        try {
          return await Promise.race([pending, deadline]);
        } finally {
          clearTimeout(timer);
        }
      }
      ```

- [x] Step 4: In `apps/api/tests/last-trade.service.test.ts`, add a poll helper directly below the existing `makeRow` function (anchor: `function makeRow(overrides`).
      ```ts
      async function waitForCalls(
        m: { mock: { calls: unknown[] } },
        n: number,
        timeoutMs = 500,
      ): Promise<void> {
        const startedAt = Date.now();
        while (m.mock.calls.length < n) {
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error(
              `Timed out waiting for ${n} calls (got ${m.mock.calls.length})`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      ```

- [x] Step 5: In the same test file, replace the whole existing test `test("serves stale cache when a later refresh fully fails", ...)` (anchor: `serves stale cache when a later refresh fully fails`) with the stale-while-revalidate version.
      ```ts
      test("serves stale cache immediately and refreshes in the background", async () => {
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

        const startedAt = Date.now();
        const second = await getLastTradeMap({ fetchClientsFn: failFetch, sleepFn, nowMs });
        const elapsed = Date.now() - startedAt;

        expect(second!.get(101)).toBe("A");
        expect(elapsed).toBeLessThan(50); // returned without waiting on the ladder
        await waitForCalls(failFetch, 3); // ladder still ran in the background
      });
      ```

- [x] Step 6: In the same test file, append a new `describe` block for `getLastTradeMapWithin` after the closing `});` of the existing `describe("getLastTradeMap", ...)`. Add `getLastTradeMapWithin` to the import list at the top of the file.
      ```ts
      describe("getLastTradeMapWithin", () => {
        beforeEach(() => {
          resetLastTradeCache();
        });

        test("returns the map when the fetch finishes inside the deadline", async () => {
          const fetchClientsFn = mock(
            async (): Promise<HFMClientsResult> => ({
              ok: true,
              data: [makeRow({ id: 101, last_trade: "A" })],
            }),
          );
          const map = await getLastTradeMapWithin(500, { fetchClientsFn });
          expect(map!.get(101)).toBe("A");
        });

        test("returns null at the deadline instead of blocking on a slow fetch", async () => {
          const fetchClientsFn = mock(
            () =>
              new Promise<HFMClientsResult>((resolve) =>
                setTimeout(
                  () => resolve({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] }),
                  400,
                ),
              ),
          );
          const startedAt = Date.now();
          const map = await getLastTradeMapWithin(50, { fetchClientsFn });
          const elapsed = Date.now() - startedAt;
          expect(map).toBeNull();
          expect(elapsed).toBeLessThan(300);

          // Let the background refresh settle before the next test runs. It is
          // currently benign (it writes the same 101 -> "A" payload the next test
          // asserts), so removing this does not turn the suite red today - it is
          // kept so a future reordering cannot make module-level cache state leak
          // across a test boundary.
          await new Promise((resolve) => setTimeout(resolve, 450));
        });

        test("background refresh still warms the cache after the deadline fires", async () => {
          const fetchClientsFn = mock(
            () =>
              new Promise<HFMClientsResult>((resolve) =>
                setTimeout(
                  () => resolve({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] }),
                  100,
                ),
              ),
          );
          expect(await getLastTradeMapWithin(20, { fetchClientsFn })).toBeNull();
          await waitForCalls(fetchClientsFn, 1);
          await new Promise((resolve) => setTimeout(resolve, 250));

          const warm = await getLastTradeMapWithin(50, { fetchClientsFn });
          expect(warm!.get(101)).toBe("A");
          expect(fetchClientsFn).toHaveBeenCalledTimes(1);
        });
      });
      ```

- [x] Step 7: Verify - Run: `cd apps/api && bun test tests/last-trade.service.test.ts` - Expected: `9 pass, 0 fail`.

- [x] Step 8: Verify - Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.

- [x] Step 9: Commit - `git commit -m "fix: serve last-trade cache stale-while-revalidate and add a bounded lookup"`

---

#### Task 2: Bound the last-trade wait inside the LINE reply path

**Files:**

- Modify: `apps/api/src/routes/webhook.ts` (anchors: `import { getLastTradeMap }`, `const MAX_WEBHOOK_EVENTS`, `const lastTradeByAccountId`)
- Modify: `apps/api/.env.example` (anchor: `PORT=3000`)
- Test: `apps/api/tests/webhook.test.ts`

**Interfaces:**

- Consumes: `getLastTradeMapWithin(deadlineMs: number, options?: GetLastTradeMapOptions): Promise<Map<number, string | null> | null>` from Task 1.
- Produces: nothing consumed by later tasks.

**Gotcha:** the deadline default is `8_000` ms, chosen because the measured healthy `/api/clients/` latency is ~7.4s - so a cold-cache lookup on a healthy API still gets real Last Trade data rather than `N/A`, while the worst-case reply lands at ~18s for a wallet lookup and ~28s for a `T`-prefix lookup (two 10s `fetchPerformance` calls), both comfortably inside LINE's 60s window.
An 8s wait would make the new test slow, so the value is overridable by env; the test sets it to `200`.

**The deadline MUST be read at call time, not at module load.** `importWebhook()` in `tests/webhook.test.ts` calls `await import("../src/routes/webhook")`, and Bun returns the **ESM-cached** module rather than a fresh one. A module-level `const LAST_TRADE_DEADLINE_MS = Number(process.env...) || 8_000` is therefore frozen at `8000` by the first test in the file (`invalid signature returns 400`), long before Step 5's test sets the override - and Step 5's test then times out waiting 8s against a 2s `waitFor`. This was measured, not assumed. Use the function form in Step 2.

**Steps:**

- [x] Step 1: In `apps/api/src/routes/webhook.ts`, change the import on line 6 from `getLastTradeMap` to `getLastTradeMapWithin`.
      ```ts
      import { getLastTradeMapWithin } from "../services/last-trade.service";
      ```

- [x] Step 2: In the same file, add the deadline accessor directly below `const MAX_WEBHOOK_EVENTS = 20;`. Note this is a **function**, not a const - see the Gotcha.
      ```ts
      // The HFM /api/clients/ endpoint needs ~7.4s when healthy and up to 48s
      // through its retry ladder. LINE reply tokens expire after 60s, so the
      // reply must never wait on it - past this deadline the card renders with
      // whatever cache exists and the refresh continues in the background.
      // Read per call: Bun caches the module, so a module-load read cannot be
      // overridden by tests that re-import this route.
      const lastTradeDeadlineMs = (): number =>
        Number(process.env.LAST_TRADE_DEADLINE_MS) || 8_000;
      ```

- [x] Step 3: In the same file, replace the `lastTradeByAccountId` assignment (anchor: `const lastTradeByAccountId`, inside `handleLookupAndReply`).
      ```ts
          const lastTradeByAccountId =
            (await getLastTradeMapWithin(lastTradeDeadlineMs())) ??
            new Map<number, string | null>();
      ```

- [x] Step 4: In `apps/api/.env.example`, append below `PORT=3000`.
      ```
      # Max ms the LINE reply path waits for the HFM /api/clients/ last-trade map
      # before rendering the card without it. Default 8000.
      LAST_TRADE_DEADLINE_MS=
      ```

- [x] Step 5: In `apps/api/tests/webhook.test.ts`, add a test that a hanging `/api/clients/` still produces a card. Place it after the existing wallet-lookup test (anchor: `18/07/2026 09:30`). Note this test deliberately does **not** pre-seed the cache, and it sets the deadline override before `importWebhook()`.
      ```ts
      test("replies with the card even when the last-trade fetch hangs", async () => {
        process.env.LAST_TRADE_DEADLINE_MS = "200";
        const { app } = await importWebhook();
        const body = JSON.stringify({
          destination: "U123",
          events: [
            {
              type: "message",
              message: { type: "text", id: "123", text: "98241376" },
              source: { type: "user", userId: "Uabc123" },
              replyToken: "token123",
              timestamp: 1716000000000,
              mode: "active",
            },
          ],
        });
        const sig = computeSig(body, SECRET);

        const fetchCalls: Array<{ url: string; body?: string }> = [];
        globalThis.fetch = (async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ) => {
          const url = String(input);
          fetchCalls.push({
            url,
            body: typeof init?.body === "string" ? init.body : undefined,
          });

          if (url.includes("/api/clients/")) {
            // Never resolves - the deadline must win.
            return new Promise<Response>(() => {});
          }

          if (url.includes("/api/performance/client-performance")) {
            return new Response(
              JSON.stringify({
                clients: [
                  {
                    client_id: 98241376,
                    account_id: 78451293,
                    full_name: "Test Client",
                    activity_status: "active",
                    trades: 5,
                    volume: 0.05,
                    account_type: "Premium",
                    deposits: 100,
                    withdrawals: 0,
                    account_currency: "USD",
                    equity: 32.88,
                    archived: null,
                    subaffiliate: 30506525,
                    account_regdate: "2026-07-22",
                    status: "approved",
                    balance: 32.88,
                    commission: 0,
                  },
                ],
                totals: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          return new Response("{}", { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const response = await app.fetch(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-line-signature": sig,
            },
            body,
          })
        );
        expect(response.status).toBe(200);

        await waitFor(
          () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
          2000
        );
        const reply = fetchCalls.find(
          (c) => c.url === "https://api.line.me/v2/bot/message/reply"
        );
        expect(reply?.body).toContain("Trading Account Summary");
        expect(reply?.body).toContain("N/A");
      });
      ```

- [x] Step 6: In `apps/api/tests/webhook.test.ts`, add `delete process.env.LAST_TRADE_DEADLINE_MS;` to the existing `afterEach` block (anchor: `delete process.env.TARGET_WALLET;`) so the override never leaks into other tests.

- [x] Step 7: Verify - Run: `cd apps/api && bun test tests/webhook.test.ts` - Expected: `14 pass, 0 fail` (13 pre-existing plus the new one). Requires the Postgres test database from Preflight.

- [x] Step 8: Verify - Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.

- [x] Step 9: Commit - `git commit -m "fix: cap the last-trade wait so the LINE reply always beats the token expiry"`

---

#### Task 3: Add reply-then-push senders to the LINE service

**Files:**

- Modify: `apps/api/src/services/line.service.ts` (anchor: `export const replyFlex`)
- Test: `apps/api/tests/line.service.test.ts` (anchor: `describe("pushToAll"`)

**Interfaces:**

- Consumes: nothing.
- Produces, both consumed by Task 4:
  - `export const replyOrPushText: (replyToken: string, userId: string, text: string) => Promise<void>`
  - `export const replyOrPushFlex: (replyToken: string, userId: string, altText: string, contents: object) => Promise<void>`

**Gotcha:** `replyMessage` already calls `logError` before rethrowing (`line.service.ts:63-68`), so the fallback's `catch` must stay empty rather than double-logging. `pushMessage` still throws when the push also fails - that is intentional, so Task 4's catch-all sees it.
LINE push messages count against the channel's monthly message quota while replies do not; this fallback only fires on the failure path, which is rare once Task 2 keeps the reply inside the token window.

**Steps:**

- [x] Step 1: In `apps/api/src/services/line.service.ts`, append after the `replyFlex` export (anchor: `export const replyFlex`) and before `export async function pushToAll`.
      ```ts
      // Replies with the reply token, falling back to a push when the reply is
      // rejected (expired token, LINE 4xx) so the customer is never left with
      // silence. Throws only when the push fails too.
      async function replyOrPush(
        replyToken: string,
        userId: string,
        message: object
      ): Promise<void> {
        try {
          await replyMessage(replyToken, message);
          return;
        } catch {
          // replyMessage already logged the failure.
        }
        await pushMessage(userId, message);
      }

      export const replyOrPushText = (
        replyToken: string,
        userId: string,
        text: string
      ) => replyOrPush(replyToken, userId, { type: "text", text });

      export const replyOrPushFlex = (
        replyToken: string,
        userId: string,
        altText: string,
        contents: object
      ) => replyOrPush(replyToken, userId, { type: "flex", altText, contents });
      ```

- [x] Step 2: In `apps/api/tests/line.service.test.ts`, extend the import on line 2 to `import { pushToAll, replyOrPushText, replyOrPushFlex } from "../src/services/line.service";` and append a new `describe` block after the closing `});` of `describe("pushToAll", ...)`.
      ```ts
      describe("replyOrPush", () => {
        afterEach(() => {
          globalThis.fetch = ORIGINAL_FETCH;
        });

        test("uses the reply token and does not push when the reply succeeds", async () => {
          const urls: string[] = [];
          globalThis.fetch = (async (input: unknown) => {
            urls.push(String(input));
            return new Response("{}", { status: 200 });
          }) as unknown as typeof globalThis.fetch;

          await replyOrPushText("token123", "U001", "hello");
          expect(urls).toEqual(["https://api.line.me/v2/bot/message/reply"]);
        });

        test("falls back to a push carrying the same message when the reply fails", async () => {
          const calls: Array<{ url: string; body: string }> = [];
          globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, body: init?.body as string });
            if (url.endsWith("/message/reply")) {
              return new Response("Invalid reply token", { status: 400 });
            }
            return new Response("{}", { status: 200 });
          }) as unknown as typeof globalThis.fetch;

          await replyOrPushFlex("expired", "U001", "alt text", { type: "bubble" });

          expect(calls.map((c) => c.url)).toEqual([
            "https://api.line.me/v2/bot/message/reply",
            "https://api.line.me/v2/bot/message/push",
          ]);
          const pushed = JSON.parse(calls[1]!.body);
          expect(pushed.to).toBe("U001");
          expect(pushed.messages[0]).toEqual({
            type: "flex",
            altText: "alt text",
            contents: { type: "bubble" },
          });
        });

        test("throws when both the reply and the push fail", async () => {
          globalThis.fetch = (async () =>
            new Response("nope", { status: 400 })) as unknown as typeof globalThis.fetch;

          await expect(replyOrPushText("expired", "U001", "hello")).rejects.toThrow();
        });
      });
      ```

- [x] Step 3: Verify - Run: `cd apps/api && bun test tests/line.service.test.ts` - Expected: `7 pass, 0 fail` (4 pre-existing plus 3 new).

- [x] Step 4: Verify - Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.

- [x] Step 5: Commit - `git commit -m "feat: add replyOrPushText and replyOrPushFlex LINE senders"`

---

#### Task 4: Make every webhook failure end in a user-visible message

**Files:**

- Modify: `apps/api/src/routes/webhook.ts` (anchors: `import { replyText, replyFlex`, `const lastTradeDeadlineMs`, `processTextEvent(event).catch`, `await replyFlex(replyToken`, `await replyText(replyToken, errMsg)`)
- Test: `apps/api/tests/webhook.test.ts`

**Interfaces:**

- Consumes: `replyOrPushText(replyToken, userId, text)` and `replyOrPushFlex(replyToken, userId, altText, contents)` from Task 3.
- Produces: nothing consumed by later tasks.

**Gotcha:** the retry message must be written as `\uXXXX` escapes to match the file's existing convention (see Global Constraints). The exact literal is given verbatim in Step 2 and decodes to `⚠️ ระบบขัดข้องชั่วคราว` / newline / `กรุณาส่ง Wallet ID อีกครั้ง` ("System temporarily unavailable. Please send the Wallet ID again.").
Do **not** change the whitelist-reject or bad-format `replyText` calls - those fire before any HFM call, so their tokens are always fresh.

**Steps:**

- [x] Step 1: In `apps/api/src/routes/webhook.ts`, extend the LINE service import on line 5.
      ```ts
      import {
        replyText,
        replyTexts,
        showLoading,
        replyOrPushText,
        replyOrPushFlex,
      } from "../services/line.service";
      ```
      `replyFlex` is no longer used after **Step 5** and must be dropped from the import. Between Step 1 and Step 5 the file carries an unused-import state; that is expected, and only the end-of-task typecheck needs to be clean.

- [x] Step 2: In the same file, add the retry message constant directly below the `const lastTradeDeadlineMs` accessor added in Task 2. Copy the escape sequence exactly.
      ```ts
      // Last-resort notice. Anything that reaches the dispatcher's catch has
      // already failed to reply, so the customer must at least be told to retry
      // rather than be left staring at silence.
      const RETRY_MESSAGE =
        "\u26A0\uFE0F \u0E23\u0E30\u0E1A\u0E1A\u0E02\u0E31\u0E14\u0E02\u0E49\u0E2D\u0E07\u0E0A\u0E31\u0E48\u0E27\u0E04\u0E23\u0E32\u0E27\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07";
      ```
      This escape sequence was generated and round-tripped while planning; copy it byte-for-byte rather than retyping Thai glyphs.

- [x] Step 3: In the same file, replace the dispatch block inside the route handler (anchor: `processTextEvent(event).catch`).
      ```ts
            if (isTextMessageEvent(event)) {
              const { replyToken } = event;
              processTextEvent(event).catch((err) => {
                logError("webhook", err);
                if (uid) void notifyRetry(replyToken, uid);
              });
            } else if (isPostbackEvent(event)) {
              const { replyToken } = event;
              processPostbackEvent(event).catch((err) => {
                logError("webhook", err);
                if (uid) void notifyRetry(replyToken, uid);
              });
            }
      ```

- [x] Step 4: In the same file, add `notifyRetry` directly below the closing `}` of the `webhook.post(...)` call and above `async function processTextEvent`.
      ```ts
      async function notifyRetry(replyToken: string, userId: string): Promise<void> {
        // The catch-all also fires for non-whitelisted users whose rejection
        // notice failed to send; they must not get a retry prompt.
        if (!isWhitelisted(userId)) return;
        try {
          await replyOrPushText(replyToken, userId, RETRY_MESSAGE);
        } catch (err) {
          logError("webhook-notify", err);
        }
      }
      ```
      `isWhitelisted` is already imported at `webhook.ts:10`; no import change is needed for it.

- [x] Step 5: In the same file, switch the three sends inside `handleLookupAndReply` to the push-fallback variants. Replace the `replyFlex` block (anchor: `await replyFlex(replyToken`):
      ```ts
          if (bubbles.length === 1) {
            await replyOrPushFlex(
              replyToken,
              userId,
              `Trading Summary \u2014 ${altLabel}`,
              bubbles[0]!
            );
          } else {
            await replyOrPushFlex(
              replyToken,
              userId,
              `Trading Summary \u2014 ${altLabel}`,
              {
                type: "carousel",
                contents: bubbles,
              }
            );
          }
      ```
      and replace the final error send (anchor: `await replyText(replyToken, errMsg)`):
      ```ts
        await replyOrPushText(replyToken, userId, errMsg);
      ```

- [x] Step 6: In `apps/api/tests/webhook.test.ts`, append these four tests after the test added in Task 2.
      ```ts
      test("HFM server error replies with the HFM-down notice instead of silence", async () => {
        const { app } = await importWebhook();
        const body = JSON.stringify({
          destination: "U123",
          events: [
            {
              type: "message",
              message: { type: "text", id: "123", text: "98241376" },
              source: { type: "user", userId: "Uabc123" },
              replyToken: "token123",
              timestamp: 1716000000000,
              mode: "active",
            },
          ],
        });
        const sig = computeSig(body, SECRET);

        const fetchCalls: Array<{ url: string; body?: string }> = [];
        globalThis.fetch = (async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ) => {
          const url = String(input);
          fetchCalls.push({
            url,
            body: typeof init?.body === "string" ? init.body : undefined,
          });
          if (url.includes("/api/performance/client-performance")) {
            return new Response("upstream boom", { status: 500 });
          }
          return new Response("{}", { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const response = await app.fetch(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-line-signature": sig },
            body,
          })
        );
        expect(response.status).toBe(200);

        await waitFor(
          () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
          2000
        );
        const reply = fetchCalls.find(
          (c) => c.url === "https://api.line.me/v2/bot/message/reply"
        );
        // "HFM API" appears verbatim inside the Thai server_error notice.
        expect(reply?.body).toContain("HFM API");
      });

      test("an expired reply token falls back to pushing the card", async () => {
        const { app } = await importWebhook();
        const body = JSON.stringify({
          destination: "U123",
          events: [
            {
              type: "message",
              message: { type: "text", id: "123", text: "98241376" },
              source: { type: "user", userId: "Uabc123" },
              replyToken: "expired",
              timestamp: 1716000000000,
              mode: "active",
            },
          ],
        });
        const sig = computeSig(body, SECRET);

        const fetchCalls: Array<{ url: string; body?: string }> = [];
        globalThis.fetch = (async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ) => {
          const url = String(input);
          fetchCalls.push({
            url,
            body: typeof init?.body === "string" ? init.body : undefined,
          });
          if (url.endsWith("/message/reply")) {
            return new Response("Invalid reply token", { status: 400 });
          }
          if (url.includes("/api/performance/client-performance")) {
            return new Response(
              JSON.stringify({
                clients: [
                  {
                    client_id: 98241376,
                    account_id: 78451293,
                    full_name: "Test Client",
                    activity_status: "active",
                    trades: 5,
                    volume: 0.05,
                    account_type: "Premium",
                    deposits: 100,
                    withdrawals: 0,
                    account_currency: "USD",
                    equity: 32.88,
                    archived: null,
                    subaffiliate: 30506525,
                    account_regdate: "2026-07-22",
                    status: "approved",
                    balance: 32.88,
                    commission: 0,
                  },
                ],
                totals: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("{}", { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        await getLastTradeMap({
          fetchClientsFn: async () => ({
            ok: true,
            data: [{ id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow],
          }),
        });

        const response = await app.fetch(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-line-signature": sig },
            body,
          })
        );
        expect(response.status).toBe(200);

        await waitFor(
          () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/push"),
          2000
        );
        const pushed = fetchCalls.find(
          (c) => c.url === "https://api.line.me/v2/bot/message/push"
        );
        expect(JSON.parse(pushed!.body!).to).toBe("Uabc123");
        expect(pushed?.body).toContain("Trading Account Summary");
      });

      test("a total send failure still pushes the try-again notice", async () => {
        const { app } = await importWebhook();
        const body = JSON.stringify({
          destination: "U123",
          events: [
            {
              type: "message",
              message: { type: "text", id: "123", text: "98241376" },
              source: { type: "user", userId: "Uabc123" },
              replyToken: "expired",
              timestamp: 1716000000000,
              mode: "active",
            },
          ],
        });
        const sig = computeSig(body, SECRET);

        const pushedTexts: string[] = [];
        globalThis.fetch = (async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ) => {
          const url = String(input);
          const raw = typeof init?.body === "string" ? init.body : undefined;

          if (url.endsWith("/message/reply")) {
            return new Response("Invalid reply token", { status: 400 });
          }
          if (url.endsWith("/message/push")) {
            const msg = JSON.parse(raw ?? "{}").messages?.[0];
            if (msg?.type === "flex") {
              // Push of the card also rejected - drives the dispatcher catch-all.
              return new Response("Invalid flex payload", { status: 400 });
            }
            pushedTexts.push(msg?.text ?? "");
            return new Response("{}", { status: 200 });
          }
          if (url.includes("/api/performance/client-performance")) {
            return new Response(
              JSON.stringify({
                clients: [
                  {
                    client_id: 98241376,
                    account_id: 78451293,
                    full_name: "Test Client",
                    activity_status: "active",
                    trades: 5,
                    volume: 0.05,
                    account_type: "Premium",
                    deposits: 100,
                    withdrawals: 0,
                    account_currency: "USD",
                    equity: 32.88,
                    archived: null,
                    subaffiliate: 30506525,
                    account_regdate: "2026-07-22",
                    status: "approved",
                    balance: 32.88,
                    commission: 0,
                  },
                ],
                totals: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("{}", { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        await getLastTradeMap({
          fetchClientsFn: async () => ({
            ok: true,
            data: [{ id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow],
          }),
        });

        const response = await app.fetch(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-line-signature": sig },
            body,
          })
        );
        expect(response.status).toBe(200);

        await waitFor(() => pushedTexts.length > 0, 2000);
        // Decodes to "please send the Wallet ID again".
        expect(pushedTexts[0]).toContain(
          "\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
        );
      });

      test("a non-whitelisted user gets no retry notice when their rejection fails", async () => {
        process.env.LINE_WHITELIST_UIDS = "Usomeone_else";
        const { app } = await importWebhook();
        const body = JSON.stringify({
          destination: "U123",
          events: [
            {
              type: "message",
              message: { type: "text", id: "123", text: "98241376" },
              source: { type: "user", userId: "Uabc123" },
              replyToken: "expired",
              timestamp: 1716000000000,
              mode: "active",
            },
          ],
        });
        const sig = computeSig(body, SECRET);

        const pushes: string[] = [];
        globalThis.fetch = (async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ) => {
          const url = String(input);
          if (url.endsWith("/message/reply")) {
            // Even the rejection notice fails, so the catch-all runs.
            return new Response("Invalid reply token", { status: 400 });
          }
          if (url.endsWith("/message/push")) {
            pushes.push(typeof init?.body === "string" ? init.body : "");
          }
          return new Response("{}", { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const response = await app.fetch(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-line-signature": sig },
            body,
          })
        );
        expect(response.status).toBe(200);

        // Absence assertion: give the handler and its catch-all time to finish.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(pushes).toHaveLength(0);
      });
      ```

- [x] Step 7: Verify - Run: `cd apps/api && bun test tests/webhook.test.ts` - Expected: `18 pass, 0 fail` (13 pre-existing + 1 from Task 2 + 4 here).

- [x] Step 8: Verify - Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.

- [x] Step 9: Commit - `git commit -m "fix: always send the customer a reply when the lookup path fails"`

---

#### Task 5: Stop the telemetry write from blocking event dispatch

**Files:**

- Modify: `apps/api/src/routes/webhook.ts` (anchor: `await recordLineUserRequest(db, uid, event.type)`)
- Modify: `apps/api/tests/line-uids.test.ts` (anchors: `describe("webhook UID collection"`, `collects UID from text message event`, `collects UID from follow event (non-text)`, `collects multiple UIDs from multiple events`)
- Test: `apps/api/tests/webhook.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing.

**Gotcha:** `recordLineUserRequest` is awaited inside the request loop today, so a Postgres outage rejects the route handler *before* `processTextEvent` is ever dispatched - Hono returns 500 and LINE does not redeliver, which is a second silent-failure path with the same customer symptom. This write is pure telemetry (`line_users` request counters) and nothing downstream reads it during a lookup.
`getDb()` memoises `_db` (`src/db/connection.ts:11-18`), so the test must call `resetDbForTests()` after changing `DATABASE_URL` for the override to take effect.

**`tests/line-uids.test.ts` DOES assert `line_users` rows through the webhook route** (`describe("webhook UID collection")`), and three of its tests read the table immediately after `app.fetch` with no wait. Making the write fire-and-forget makes them race. Measured with this task applied: `collects UID from follow event (non-text)` and `collects multiple UIDs from multiple events` fail (`expected 1, received 0` / `expected 2, received 1`), **non-deterministically** - both fail in isolation, only one fails in a full-suite run. `collects UID from text message event` survives today only by an incidental `await new Promise((r) => setTimeout(r, 100));`. Step 2 below fixes all three properly with a poll; do not treat their failure as an unrelated flake.
The two negative tests in that file (`does NOT collect UID when signature is invalid`, `skips events without userId (group source)`) assert length 0 and must be left alone - no write is ever issued on those paths, and polling for an absence would only add a second of dead wait.

**Steps:**

- [ ] Step 1: In `apps/api/src/routes/webhook.ts`, replace the telemetry write inside the event loop (anchor: `await recordLineUserRequest`).
      ```ts
            const uid = event.source?.userId;
            if (uid) {
              // Telemetry only - a database hiccup must never stop the customer's reply.
              recordLineUserRequest(db, uid, event.type).catch((err) =>
                logError("line-user", err),
              );
            }
      ```

- [ ] Step 2: In `apps/api/tests/line-uids.test.ts`, make the three positive assertions wait for the now-asynchronous write. Add this helper directly below `function computeSig(...)` (anchor: `function computeSig`).
      ```ts
      // The webhook records line_users fire-and-forget, so the row lands shortly
      // after the response. Returns whatever it has at the timeout so the
      // caller's toHaveLength assertion still reports a useful diff.
      async function waitForUsers(
        db: ReturnType<typeof getDb>,
        count: number,
        timeoutMs = 1000,
      ): Promise<Awaited<ReturnType<typeof listLineUsers>>> {
        const startedAt = Date.now();
        for (;;) {
          const users = await listLineUsers(db);
          if (users.length >= count) return users;
          if (Date.now() - startedAt > timeoutMs) return users;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      ```
      Then, in each of the three positive tests, replace `const users = await listLineUsers(db);` with the polling call:
      - in `collects UID from text message event` -> `const users = await waitForUsers(db, 1);`, and **delete** that test's now-redundant `await new Promise((r) => setTimeout(r, 100));` line.
      - in `collects UID from follow event (non-text)` -> `const users = await waitForUsers(db, 1);`
      - in `collects multiple UIDs from multiple events` -> `const users = await waitForUsers(db, 2);`

      Leave `does NOT collect UID when signature is invalid` and `skips events without userId (group source)` exactly as they are.

- [ ] Step 3: Verify - Run: `cd apps/api && bun test tests/line-uids.test.ts` - Expected: `8 pass, 0 fail`. Run it **five times in a row** and confirm it is green every time. Three runs is not enough evidence here: before the fix this file's failure count itself varies run to run (measured 3, 3, 3, then 1 failure across four runs), so a single lucky pass proves nothing.

- [ ] Step 4: In `apps/api/tests/webhook.test.ts`, append a test after the ones added in Task 4.
      ```ts
      test("a database failure does not stop the lookup reply", async () => {
        const { app } = await importWebhook();
        process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/none";
        resetDbForTests();

        const body = JSON.stringify({
          destination: "U123",
          events: [
            {
              type: "message",
              message: { type: "text", id: "123", text: "98241376" },
              source: { type: "user", userId: "Uabc123" },
              replyToken: "token123",
              timestamp: 1716000000000,
              mode: "active",
            },
          ],
        });
        const sig = computeSig(body, SECRET);

        const fetchCalls: Array<{ url: string; body?: string }> = [];
        globalThis.fetch = (async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1]
        ) => {
          const url = String(input);
          fetchCalls.push({
            url,
            body: typeof init?.body === "string" ? init.body : undefined,
          });
          if (url.includes("/api/performance/client-performance")) {
            return new Response("upstream boom", { status: 500 });
          }
          return new Response("{}", { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const response = await app.fetch(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-line-signature": sig },
            body,
          })
        );
        expect(response.status).toBe(200);

        await waitFor(
          () => fetchCalls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply"),
          2000
        );
        const reply = fetchCalls.find(
          (c) => c.url === "https://api.line.me/v2/bot/message/reply"
        );
        expect(reply?.body).toContain("HFM API");
      });
      ```

- [ ] Step 5: Verify - Run: `cd apps/api && bun test tests/webhook.test.ts` - Expected: `19 pass, 0 fail`.

- [ ] Step 6: Verify - Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.

- [ ] Step 7: Commit - `git commit -m "fix: make the line_users telemetry write non-blocking"`

---

#### Task 6: Warm the last-trade cache at startup

**Files:**

- Modify: `apps/api/src/index.ts` (anchor: `registerJobs();`)

**Interfaces:**

- Consumes: `getLastTradeMap` from `src/services/last-trade.service.ts`.
- Produces: nothing.

**Gotcha:** without this, the very first lookup after a deploy hits a cold cache, and even on a healthy API the ~7.4s `/api/clients/` round trip races Task 2's 8s deadline. Warming at boot means the request path finds a populated cache, and Task 1's stale-while-revalidate keeps it populated from then on.
`logError` takes `(context, error)`; the success log uses `logger.info` directly, matching the file's existing use of `logger`.

**Steps:**

- [ ] Step 1: In `apps/api/src/index.ts`, **replace** the existing line `import { logger } from "./utils/logger";` (anchor: `from "./utils/logger"`) with the two lines below. Do not append a second logger import - a duplicate `logger` binding fails typecheck with `TS2300: Duplicate identifier 'logger'`.
      ```ts
      import { logger, logError } from "./utils/logger";
      import { getLastTradeMap } from "./services/last-trade.service";
      ```

- [ ] Step 2: In the same file, append directly below `registerJobs();`.
      ```ts
      // Warm the last-trade cache so the first customer lookup does not pay the
      // ~7s /api/clients/ round trip.
      getLastTradeMap()
        .then((map) =>
          logger.info({ size: map?.size ?? 0 }, "[startup] last-trade cache warmed"),
        )
        .catch((err) => logError("startup-warm", err));
      ```

- [ ] Step 3: Verify - Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.

- [ ] Step 4: Verify - Manual: with real credentials loaded, run `cd apps/api && bun run start`, then watch stdout for up to 20s. Expected: a pino line containing `[startup] last-trade cache warmed` with `"size"` greater than 0 (~2709 on the current dataset), and no unhandled rejection. Stop the server with Ctrl-C.

- [ ] Step 5: Commit - `git commit -m "feat: warm the last-trade cache at startup"`

---

#### Task 7: Fix the two pre-existing failing tests

**Files:**

- Modify: `apps/api/tests/sqlite.service.test.ts:59-76` (anchors: `client_snapshots has UNIQUE constraint`, `initDb is idempotent`)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

**Gotcha:** these two failures predate this plan and are unrelated to the wallet-lookup bug; they are fixed here because the repo standard is to leave no red tests behind. Both are test-authoring bugs, not product bugs, so no `src/` change is warranted.
`db.execute(...)` returns Drizzle's `PgRaw` thenable, not a real `Promise`, and `bun:test`'s `.rejects` requires a genuine Promise (it reports `Expected promise / Received: PgRaw {...}`). Wrapping in an async IIFE produces one.
`.resolves.not.toThrow()` unwraps to `undefined` and then calls `toThrow` on a non-function, which reports `Thrown value: undefined`. `initDb` is declared `Promise<void>` (`src/db/connection.ts:20`), so asserting `toBeUndefined()` is the correct check.
Leave both test names byte-for-byte unchanged, including the em dash already present in the second one.

**Steps:**

- [ ] Step 1: In `apps/api/tests/sqlite.service.test.ts`, replace the second `db.execute` assertion inside the UNIQUE-constraint test (anchor: `).rejects.toThrow();`).
      ```ts
        await expect(
          (async () =>
            db.execute(sql`
              INSERT INTO client_snapshots (snapshot_date, client_id) VALUES ('2026-04-26', 456)
            `))(),
        ).rejects.toThrow();
      ```

- [ ] Step 2: In the same file, replace the idempotency assertion (anchor: `await expect(initDb(db)).resolves.not.toThrow();`).
      ```ts
        await expect(initDb(db)).resolves.toBeUndefined();
      ```

- [ ] Step 3: Verify - Run: `cd apps/api && bun test tests/sqlite.service.test.ts` - Expected: `3 pass, 0 fail`.

- [ ] Step 4: Verify - Run: `cd apps/api && bun test` - Expected: `193 pass, 0 fail`. Arithmetic: baseline `Ran 181 tests` plus 12 new (3 in `last-trade.service.test.ts`, 6 in `webhook.test.ts` - one from Task 2, four from Task 4, one from Task 5 - and 3 in `line.service.test.ts`) = 193 tests, with the 2 previously-failing ones now green. This is the first task where a package-wide green is expected; Tasks 1-6 verify against scoped test files because these 2 failures are still red until now.

- [ ] Step 5: Commit - `git commit -m "test: repair the two broken assertions in sqlite.service.test.ts"`

---

## Failure handling summary

- **`bun test` reports a database authentication error (`28P01`) across `webhook.test.ts`** - Detect: every webhook test fails with `auth_failed`. Respond: this is the Preflight Postgres dependency, not a code defect. STOP, re-run the Preflight `psql` check, and report. Do not "fix" it by editing tests.
- **`tests/last-trade.service.test.ts` becomes flaky on the timing assertions** - Detect: `expect(elapsed).toBeLessThan(...)` fails intermittently on a loaded machine. Respond: raise the slack bound (the 300ms and 50ms ceilings), never the deadline being tested, and never delete the assertion. Report the change.
- **A new test leaves `LAST_TRADE_DEADLINE_MS` set and later tests slow down or misbehave** - Detect: unrelated webhook tests start failing after Task 2. Respond: confirm Task 2 Step 6's `afterEach` cleanup is present; that is the fix, not per-test workarounds.
- **Task 5's test hangs instead of failing fast** - Detect: `a database failure does not stop the lookup reply` exceeds its `waitFor` timeout rather than passing. Cause: `postgresql://nobody@127.0.0.1:1/none` is expected to give an immediate `ECONNREFUSED`, but a local firewall can make it hang. Respond: swap the URL for `postgresql://nobody:nobody@127.0.0.1:5432/definitely_not_a_real_db` (server up, database absent, so it fails at authentication rather than at connect) and note the swap. Do not weaken the test to skip the database path.

## End-to-end verification

Run after all seven tasks are committed. Requires the real `HFM_API_KEY` from `apps/api/.env`, a reachable Postgres, and the LINE channel wired to this instance.

- [ ] Run: `cd apps/api && bun test` - Expected: `0 fail`.
- [ ] Run: `cd apps/api && bun run typecheck` - Expected: no output, exit 0.
- [ ] Manual: reproduce the original bug shape against a **cold** process. Restart the app (`cd apps/api && bun run start`), and **within 3 seconds of boot** (before the startup warm finishes) send a real Wallet ID from a whitelisted LINE account. Expected: the Trading Account Summary card arrives in under ~20s on the **first** message, with no second message needed. Last Trade may read `N/A` on this one card if the warm has not landed yet; that is the accepted trade for never stalling.
- [ ] Manual: send the same Wallet ID a second time, at least 15s after the first. Expected: the card arrives in ~1-2s and Last Trade shows a real timestamp (format `DD/MM/YYYY HH:mm`), confirming the cache warmed.
- [ ] Manual: simulate the HFM outage the customer hit. Stop the app, set `HFM_API_BASE_URL=http://127.0.0.1:1` in `apps/api/.env`, restart, and send a Wallet ID. Expected: within ~15s the customer receives the Thai text `⚠️ ระบบ HFM API ขัดข้องชั่วคราว / กรุณาลองใหม่ในอีกสักครู่ หรือติดต่อ Support` - **never silence**. Restore `HFM_API_BASE_URL=https://api.hfaffiliates.com` afterwards.
- [ ] Manual: confirm the paginated path still works. Send a Wallet ID that resolves to more than 5 trading accounts, then tap `Next Page ➔`. Expected: the next carousel page arrives, with Last Trade populated on its cards.
- [ ] Manual: check the logs for the whole session. Expected: at least one `[startup] last-trade cache warmed` line with a non-zero `size`, and zero `UnhandledPromiseRejection` entries.
