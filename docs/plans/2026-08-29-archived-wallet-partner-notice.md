# Archived Wallet Partner Notice Implementation Plan

> **Run with:** `/execute-plan docs/plans/2026-08-29-archived-wallet-partner-notice.md` - the runner that ticks these
> checkboxes and honours the track layout below.
>
> **For the executing agent:** This plan is a single sequential track.
> Steps use checkbox (`- [ ]`) syntax for tracking; tick them as you go.
> Run the `## Preflight` checks BEFORE task 1 and report anything down.

**Goal:** When a Wallet ID lookup returns HFM rows but every account is archived, the bot replies `อยู่ใต้ Partner {subaffiliate} แต่ไม่มีบัญชี` instead of the generic "ไม่พบข้อมูล" notice.
When the API truly has no data (404 or empty `clients` array), the reply stays the existing not-found message.

**Architecture:** Add an `all_archived` failure variant that carries `subaffiliate` to the existing `HFMApiResult` union, set it inside `fetchPerformance` when the archived filter empties a non-empty API response, and add one message branch in the webhook's error-reply chain.
No new service, no new route, no schema change.
`T`-prefix account lookups inherit the same notice for free because `resolveLinkedAccounts` propagates the failure result from its internal `fetchPerformance` call.

**Tech Stack:** Bun, TypeScript (strict, ESM), Hono, `bun:test`. Repository tests for the webhook path run against a real PostgreSQL test container.

**Spec:** from conversation, 2026-08-29.
Requested message shape: `อยู่ใต้ Partner {_subaffiliate_} แต่ไม่มีบัญชี` for archived-only wallets; unchanged not-found message when the API sends no data.

**Root cause evidence (measured 2026-08-29, do not re-litigate):**

- `GET https://api.hfaffiliates.com/api/performance/client-performance?wallets=65238209` with the repo's real `HFM_API_KEY` returned `status=200` with exactly 1 client row.
- That row carries `"archived": true`, `"activity_status": "Archived Trading Account"`, `"subaffiliate": 30506525`, `"client_id": 65238209`.
- `apps/api/src/services/hfm.service.ts:129` filters `clients.filter((c) => !c.archived)`, leaving `data = []`.
- `apps/api/src/services/hfm.service.ts:130-131` then returns `{ ok: false, reason: "not_found" }`.
- `apps/api/src/routes/webhook.ts:285-286` maps `not_found` to the generic `❌ ไม่พบข้อมูล ... ในระบบ` reply the user saw.
- `checkConditions()` never runs for this wallet; it only executes on the `result.ok` path.

**NOT building:**

- No change to the not-found, no-wallet, timeout, or server-error messages. They keep their exact current text.
- No change to the archived filter itself. Mixed responses (some archived, some live) still show only live accounts, as today.
- No change to `fetchClients` / `fetchAllClients` / `fetchClientsByRange` (daily report and last-trade paths). They use different result types (`HFMAllClientsResult`, `HFMClientsResult`), not `HFMApiResult`.
- No special-casing for `subaffiliate: 0`. Mocked rows use 0, real archived rows carry a real partner id; printing `Partner 0` in a degenerate mock is acceptable.
- No card/Flex changes. The new notice is a plain text reply.

## Global Constraints

- Runtime is Bun only. Never use `node`, `npm`, `yarn`, or `npx` (`bunx` instead).
- Webhook tests need the test database: from the repo root `docker compose up -d postgres-test`, then `export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test`.
- Tests drop and recreate tables. Never point them at a real database.
- Keep the "why" comments. The new code comment in `fetchPerformance` explains why all-archived is surfaced instead of collapsed into not-found.
- Conventional commits, subject under ~50 chars, imperative, no agent co-author lines.
- All commands run from `apps/api` unless stated otherwise.

## File Map

| File | Change |
| --- | --- |
| `src/types/hfm.types.ts` | Add the `all_archived` variant to `HFMApiResult` (3-line edit at the union around line 52). |
| `src/services/hfm.service.ts` | Split the post-filter empty check in `fetchPerformance` (lines 129-132) into `all_archived` vs `not_found`. |
| `src/routes/webhook.ts` | Add the partner-notice branch at the top of the `errMsg` chain (lines 284-291). |
| `tests/hfm.service.test.ts` | One new unit test for the all-archived result. |
| `tests/webhook.test.ts` | One new webhook test asserting the partner notice reply text. |

## Preflight

- [x] **P1: Verify clean baseline**

Run from `apps/api`:

```bash
bun run typecheck
```

Expected: no errors.

- [x] **P2: Start the test database**
  > Deviation: docker is not installed on this machine; a local PostgreSQL (127.0.0.1:5432, user jametirakarn, db hfm_test) serves the suite via the test file's built-in default URL. Baseline run without TEST_DATABASE_URL: 193 pass / 0 fail.

Run from the repo root, in every shell you will run `bun test` from (`%%bash` cells do not share exports, so re-`export` per cell):

```bash
docker compose up -d postgres-test
cd apps/api
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
bun test
```

Expected: all tests pass. If the container is already running, skip `docker compose`.

- [x] **P3: Create the branch**

```bash
git checkout -b feat/archived-wallet-partner-notice
```

Expected: new branch created off `main`.

---

### Task 1: `fetchPerformance` returns `all_archived` with the partner id

**Files:**
- Modify: `src/types/hfm.types.ts:52-55`
- Modify: `src/services/hfm.service.ts:129-132`
- Test: `tests/hfm.service.test.ts` (inside `describe("fetchPerformance")`)

- [x] **Step 1: Write the failing test**

In `tests/hfm.service.test.ts`, inside `describe("fetchPerformance")`, insert this test directly after the closing `});` of the test `"multiple non-archived clients returned as array"` (around line 132):

```ts
  test("all-archived clients returns all_archived with the partner id", async () => {
    const archivedResponse: HFMClientsPerformanceResponse = {
      clients: [
        { ...mockHfmResponse.clients[0]!, archived: true, subaffiliate: 30506525 },
      ],
      totals: mockHfmResponse.totals,
    };
    globalThis.fetch = mockFetch(200, archivedResponse);
    const result = await fetchPerformance({ kind: "wallet", id: 65238209, label: "65238209" });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "all_archived") {
      expect(result.subaffiliate).toBe(30506525);
    } else {
      throw new Error(`expected all_archived, got ${JSON.stringify(result)}`);
    }
  });
```

- [x] **Step 2: Run the test to verify it fails**

```bash
bun test tests/hfm.service.test.ts -t "all-archived"
```

Expected: FAIL. TypeScript reports `Property 'all_archived' does not exist` (or the runtime fails the `all_archived` check with `expected all_archived, got {"ok":false,"reason":"not_found"}`), because the variant does not exist yet.

- [x] **Step 3: Add the result variant and set it in the service**

Edit 1 - `src/types/hfm.types.ts`, replace exactly:

```ts
export type HFMApiResult =
  | { ok: true; data: HFMPerformanceData[] }
  | { ok: false; reason: "not_found" | "server_error" | "timeout" | "no_wallet" };
```

with:

```ts
export type HFMApiResult =
  | { ok: true; data: HFMPerformanceData[] }
  | { ok: false; reason: "not_found" | "server_error" | "timeout" | "no_wallet" }
  | { ok: false; reason: "all_archived"; subaffiliate: number };
```

Edit 2 - `src/services/hfm.service.ts`, replace exactly:

```ts
    const data: HFMPerformanceData[] = clients.filter((c) => !c.archived);
    if (data.length === 0 || data[0]!.client_id == null) {
      return { ok: false, reason: "not_found" };
    }
```

with:

```ts
    const data: HFMPerformanceData[] = clients.filter((c) => !c.archived);
    if (data.length === 0) {
      // The API returned rows but every account is archived. The wallet
      // still exists under a partner, so carry that partner id up to the
      // webhook instead of collapsing into a plain not-found.
      return { ok: false, reason: "all_archived", subaffiliate: clients[0]!.subaffiliate };
    }
    if (data[0]!.client_id == null) {
      return { ok: false, reason: "not_found" };
    }
```

This split is safe because the guard at `hfm.service.ts:124-127` already returned `not_found` when `clients` is empty, so `clients[0]` exists whenever the filter empties a non-empty list.

- [x] **Step 4: Run the tests to verify they pass**

```bash
bun test tests/hfm.service.test.ts
```

Expected: all pass, including the pre-existing guards on unchanged behavior:

- `"empty clients array returns not_found"` (line ~106) - API sends no data, still `not_found`.
- `"multiple non-archived clients returned as array"` (line ~118) - mixed rows, still `ok` with only live rows.
- `"404 response returns not_found"` (line ~96).

- [x] **Step 5: Commit**

```bash
git add src/types/hfm.types.ts src/services/hfm.service.ts tests/hfm.service.test.ts
git commit -m "feat: add all_archived HFM lookup result"
```

---

### Task 2: Webhook replies with the partner notice

**Files:**
- Modify: `src/routes/webhook.ts:284-291`
- Test: `tests/webhook.test.ts` (after the `"HFM server error replies with the HFM-down notice instead of silence"` test, around line 448)

- [x] **Step 1: Write the failing test**
  > Deviation: Added `process.env.LINE_WHITELIST_UIDS = "Uabc123";` at the top of the test (matches the line-152 pattern): Bun auto-loads .env, whose real LINE_WHITELIST_UIDS leaks into isolated `-t` runs and rejects Uabc123 before the lookup. Pre-existing quirk - the existing "HFM server error" test fails the same way in isolation.

In `tests/webhook.test.ts`, insert this test directly after the closing `});` of the test `"HFM server error replies with the HFM-down notice instead of silence"`:

```ts
  test("wallet whose accounts are all archived replies with the partner notice", async () => {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text: "65238209" },
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
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 65238209,
                account_id: 198058740,
                activity_status: "Archived Trading Account",
                trades: 2908,
                volume: 132.2,
                account_type: "PREMIUM",
                balance: 0,
                account_currency: "USD",
                equity: 0,
                archived: true,
                subaffiliate: 30506525,
                account_regdate: "2026-04-08T17:14:12",
                status: "Approved",
              },
            ],
            totals: {},
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
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
    expect(reply?.body).toContain("\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E15\u0E49 Partner 30506525 \u0E41\u0E15\u0E48\u0E44\u0E21\u0E48\u0E21\u0E35\u0E1A\u0E31\u0E0D\u0E0A\u0E35");
    expect(reply?.body).not.toContain("\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25");
  });
```

The first assertion is the full notice `อยู่ใต้ Partner 30506525 แต่ไม่มีบัญชี`.
The second asserts the generic not-found text `ไม่พบข้อมูล` does NOT appear.

- [x] **Step 2: Run the test to verify it fails**
  > Deviation: RED confirmed, but the failing reply was the HFM-down notice (all_archived falls to the final else branch), not the generic not-found text the plan predicted. Same intent: the partner notice is absent before Step 3.

```bash
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
bun test tests/webhook.test.ts -t "all archived"
```

Expected: FAIL with `expected '…' to include 'อยู่ใต้ Partner…'`, because the reply body still contains the generic not-found text (`reason` is `all_archived` but the webhook has no branch for it yet).

- [x] **Step 3: Add the message branch**

Edit `src/routes/webhook.ts`, replace exactly:

```ts
  const idLabel = lookup.kind === "wallet" ? `Wallet ID ${lookup.label}` : `Account ID ${lookup.label}`;
  const errMsg =
    result.reason === "not_found"
```

with:

```ts
  const idLabel = lookup.kind === "wallet" ? `Wallet ID ${lookup.label}` : `Account ID ${lookup.label}`;
  const errMsg =
    result.reason === "all_archived"
      ? `\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E15\u0E49 Partner ${result.subaffiliate} \u0E41\u0E15\u0E48\u0E44\u0E21\u0E48\u0E21\u0E35\u0E1A\u0E31\u0E0D\u0E0A\u0E35`
      : result.reason === "not_found"
```

Nothing else in the chain changes; the existing `not_found`, `no_wallet`, `timeout`, and server-error branches stay as they are, just one indent deeper inside the new ternary.
`\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E15\u0E49 Partner ${result.subaffiliate} \u0E41\u0E15\u0E48\u0E44\u0E21\u0E48\u0E21\u0E35\u0E1A\u0E31\u0E0D\u0E0A\u0E35` renders as `อยู่ใต้ Partner 30506525 แต่ไม่มีบัญชี` and matches the escaped-unicode style of the surrounding replies.

- [x] **Step 4: Run the test to verify it passes**

```bash
bun test tests/webhook.test.ts -t "all archived"
```

Expected: PASS.

- [x] **Step 5: Full suite and typecheck**

```bash
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
bun test
bun run typecheck
```

Expected: all tests pass, typecheck clean.

- [x] **Step 6: Commit**

```bash
git add src/routes/webhook.ts tests/webhook.test.ts
git commit -m "feat: reply partner notice for archived wallet"
```

---

### Task 3: End-to-end sanity against the real HFM API (optional, no commit)

This mirrors how the bug was found: call the real upstream with the archived wallet and confirm the service now surfaces the partner instead of `not_found`.
It never sends a LINE message; it only exercises `fetchPerformance`.

- [x] **Step 1: Run the live check**

From `apps/api`, create `tmp-fetch-perf.ts`:

```ts
import { fetchPerformance } from "./src/services/hfm.service";

const lookup = { kind: "wallet" as const, id: 65238209, label: "65238209" };
const result = await fetchPerformance(lookup);
console.log(JSON.stringify(result, null, 2));
```

Run (Bun auto-loads `.env`):

```bash
bun tmp-fetch-perf.ts && rm tmp-fetch-perf.ts
```

Expected output:

```json
{
  "ok": false,
  "reason": "all_archived",
  "subaffiliate": 30506525
}
```

- [x] **Step 2: Confirm the empty-data wallet still reports not_found**

Same script with `id: 0, label: "0"`.

Expected output:

```json
{
  "ok": false,
  "reason": "not_found"
}
```

## Rollback

Revert the two commits (`git revert HEAD~1 HEAD` or reset the branch).
No migrations, env vars, or persisted state are involved.

## Self-Review Notes

- Spec coverage: archived-only wallet gets the partner notice (Tasks 1+2); API-no-data keeps not-found (covered by pre-existing tests `"empty clients array returns not_found"` and `"404 response returns not_found"`, both listed in Task 1 Step 4).
- `T`-prefix account lookups get the same notice via `resolveLinkedAccounts` propagation (`hfm.service.ts:155`) - existing behavior, no extra code.
- All `.reason` consumers audited: only `webhook.ts:285` switches on `HFMApiResult`; `daily-client-report.ts:266` and `last-trade.service.ts:116` consume the other result types and are untouched.
- No placeholders; every edit shows exact old/new strings and every step has a runnable command with expected output.
