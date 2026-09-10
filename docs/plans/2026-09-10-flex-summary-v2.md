# Flex Summary v2 (Monthly Status + 2-Lot Progress + Rank) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add an env-gated v2 of the LINE "Trading Account Summary" Flex card that shows monthly trading status, a monthly 2-lot progress line, and a customer rank tier, while `flex-v1` stays byte-identical to today.

**Architecture:** `buildTradingCard()` becomes a thin dispatcher that reads `FLEX_SUMMARY_VERSION` per call and delegates to `buildTradingCardV1` (the current body, unchanged) or `buildTradingCardV2`.
The webhook lookup handler fetches a month-scoped copy of the same HFM performance endpoint (`from_date` / `to_date`, already proven by `fetchClientsByRange`) only when v2 is active, and passes a per-account monthly map into the builder.
Rank is a pure function over cumulative lots (`data.volume`) with its own unit tests.

**Tech Stack:** Bun, TypeScript (ESM, strict), Hono, LINE Messaging API Flex Messages, dayjs (`Asia/Bangkok`), `bun test`.

---

## Findings (read before editing - already verified)

Files that matter:

| File | Role |
| --- | --- |
| `apps/api/src/routes/webhook.ts` | Lookup handler. `handleLookupAndReply()` (lines ~236-300) fetches performance, paginates 5 accounts per page, and calls `buildTradingCard`. |
| `apps/api/src/builders/flex-message.builder.ts` | `buildTradingCard(data, conditions, options)` builds the bubble (lines ~190-330). |
| `apps/api/src/services/hfm.service.ts` | `fetchPerformance()` calls `GET /api/performance/client-performance?wallets=<id>`. `fetchClientsByRange()` proves the same endpoint accepts `from_date` / `to_date`. |
| `apps/api/src/types/hfm.types.ts` | `HFMPerformanceData` - the lookup row. |
| `apps/api/tests/flex-message.builder.test.ts` | Existing builder tests and helpers (`extractTexts`, `findBadgeByLabel`). |
| `apps/api/.env.example` | Env template. |

What the lookup response returns today (`HFMClientsPerformanceResponse.clients[]`, sample from `apps/api/tests/hfm.service.test.ts`):

```json
{
  "client_id": 45219,
  "account_id": 78451293,
  "activity_status": "active",
  "trades": 24,
  "volume": 3.42,
  "account_type": "Standard",
  "balance": 12450.8,
  "account_currency": "USD",
  "equity": 12998.35,
  "archived": false,
  "subaffiliate": 98241376,
  "account_regdate": "2024-01-15T00:00:00Z",
  "status": "approved"
}
```

`volume` is the lot figure (user confirmed: "lot คือ volume ใน api ที่ดึงมา").

**There is no per-trade or per-month data in this response.**
`trades` and `volume` are all-time aggregates when the request carries no date range.

**Smallest change to get monthly data (needs approval - Task 0):** call the *same* endpoint a second time with `from_date` = first day of the current ICT month and `to_date` = today, scoped to the wallet: `GET /api/performance/client-performance?wallets=<walletId>&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD`.
The response shape is identical, so `clients[].volume` becomes month lots and `clients[].trades` becomes month trades per `account_id`.
No new endpoint, no new dependency, no schema change.
The ICT month boundary helper `getThisMonthRange()` already exists in `apps/api/src/utils/date.ts`.
Cost: one extra HTTP call per v2 lookup, bounded by a 6s timeout, degrading to "N/A" rows on failure so the 60s LINE reply token is never at risk.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/api/src/builders/flex-message.builder.ts` | Modify | Add `getFlexSummaryVersion()`, `getRankTier()`, split `buildTradingCardV1` / `buildTradingCardV2`, keep `buildTradingCard` as dispatcher. |
| `apps/api/src/types/hfm.types.ts` | Modify | Add the `MonthlyActivity` type shared by service, webhook, and builder. |
| `apps/api/src/services/hfm.service.ts` | Modify | Add `fetchMonthlyVolumeMap(walletId, timeoutMs)`. |
| `apps/api/src/routes/webhook.ts` | Modify | Fetch the monthly map when v2 is active, pass `monthly` per account into the builder. |
| `apps/api/tests/rank-tier.test.ts` | Create | Boundary tests for `getRankTier`. |
| `apps/api/tests/flex-message.builder.test.ts` | Modify | v1 snapshot lock, version-flag tests, v2 field tests, Flex size validation. |
| `apps/api/tests/hfm.service.test.ts` | Modify | Tests for `fetchMonthlyVolumeMap`. |
| `apps/api/.env.example` | Modify | Document `FLEX_SUMMARY_VERSION`. |

Decision on "env/config loader": this repo has no config module.
Every module reads `process.env` directly at call time (see the `lastTradeDeadlineMs()` comment in `webhook.ts` about per-call reads and Bun module caching).
So `getFlexSummaryVersion()` lives in the builder module and reads `process.env` per call.
No new config file.

---

## Task 0: Confirm the data gate

**Files:** none (no code in this task).

- [x] **Step 1: Report the finding and ask for approval**

Post this to the user and wait for a yes:

> The lookup response has no per-trade or per-month data - `trades` and `volume` are all-time aggregates.
> Proposed smallest change: one extra call to the same endpoint with `wallets=<walletId>&from_date=<ICT month start>&to_date=<today>`, which `fetchClientsByRange` already proves is supported.
> This adds an external API call, which is a stop condition. Approve?

- [x] **Step 2: Stop if not approved**

If the user says no, stop. Do not start Task 5 or Task 6.
Tasks 1-4 and 7 are still safe to run (they add no API call), but do not ship v2 without a monthly data source.

---

## Task 1: Lock the v1 output with a snapshot

This runs **before** any refactor so the snapshot records today's exact JSON.

**Files:**
- Test: `apps/api/tests/flex-message.builder.test.ts`

- [x] **Step 1: Write the snapshot test**

Append to `apps/api/tests/flex-message.builder.test.ts`:

```ts
describe("flex-v1 output is frozen", () => {
  const snapshotData: HFMPerformanceData = {
    ...mockData,
    last_trade: "2024-03-02T09:15:00Z",
  };

  test("default (flag unset) matches the locked v1 JSON", () => {
    delete process.env.FLEX_SUMMARY_VERSION;
    const card = buildTradingCard(snapshotData, matchAllConditions, {
      showVolume: true,
    });
    expect(JSON.stringify(card, null, 2)).toMatchSnapshot();
  });

  test("default (flag unset), volume hidden, not-match conditions", () => {
    delete process.env.FLEX_SUMMARY_VERSION;
    const card = buildTradingCard(snapshotData, notMatchConditions);
    expect(JSON.stringify(card, null, 2)).toMatchSnapshot();
  });
});
```

- [x] **Step 2: Generate the snapshot**

Run from `apps/api`: `bun test tests/flex-message.builder.test.ts`
Expected: PASS, and a new file `apps/api/tests/__snapshots__/flex-message.builder.test.ts.snap` appears.

- [x] **Step 3: Eyeball the snapshot**

Run: `head -40 tests/__snapshots__/flex-message.builder.test.ts.snap`
Expected: the bubble JSON with `"text": "Trading Account Summary"` and a `"Volume"` label in the first snapshot.

- [x] **Step 4: Commit**

```bash
git add apps/api/tests/flex-message.builder.test.ts apps/api/tests/__snapshots__/flex-message.builder.test.ts.snap
git commit -m "test: snapshot current trading card JSON"
```

---

## Task 2: Rank tier pure function

**Files:**
- Modify: `apps/api/src/builders/flex-message.builder.ts`
- Test: `apps/api/tests/rank-tier.test.ts` (create)

- [x] **Step 1: Write the failing test**

Create `apps/api/tests/rank-tier.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { getRankTier } from "../src/builders/flex-message.builder";

describe("getRankTier", () => {
  const cases: Array<[number, string]> = [
    [0, "\u{1F949} Bronze"],
    [0.22, "\u{1F949} Bronze"],
    [99.99, "\u{1F949} Bronze"],
    [100, "\u{1F948} Silver"],
    [499.99, "\u{1F948} Silver"],
    [500, "\u{1F947} Gold"],
    [999.99, "\u{1F947} Gold"],
    [1000, "\u{1F48E} Platinum"],
    [3999.99, "\u{1F48E} Platinum"],
    [4000, "\u{1F451} Diamond"],
    [125000, "\u{1F451} Diamond"],
  ];

  for (const [lots, expected] of cases) {
    test(`${lots} lots -> ${expected}`, () => {
      expect(getRankTier(lots)).toBe(expected);
    });
  }

  test("negative or non-finite lots fall back to Bronze", () => {
    expect(getRankTier(-1)).toBe("\u{1F949} Bronze");
    expect(getRankTier(Number.NaN)).toBe("\u{1F949} Bronze");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run from `apps/api`: `bun test tests/rank-tier.test.ts`
Expected: FAIL with an import/type error - `getRankTier` is not exported.

- [x] **Step 3: Write the implementation**

In `apps/api/src/builders/flex-message.builder.ts`, add just below `const fmtVolume = ...`:

```ts
// Rank tiers are cut on cumulative all-time lots (HFM `volume`).
// Boundaries are inclusive on the lower bound: 100 lots is Silver, 99.99 is Bronze.
export function getRankTier(cumulativeLots: number): string {
  const lots = Number.isFinite(cumulativeLots) ? cumulativeLots : 0;
  if (lots >= 4000) return "\u{1F451} Diamond";
  if (lots >= 1000) return "\u{1F48E} Platinum";
  if (lots >= 500) return "\u{1F947} Gold";
  if (lots >= 100) return "\u{1F948} Silver";
  return "\u{1F949} Bronze";
}
```

- [x] **Step 4: Run the test to verify it passes**

Run from `apps/api`: `bun test tests/rank-tier.test.ts`
Expected: PASS, 12 tests.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/builders/flex-message.builder.ts apps/api/tests/rank-tier.test.ts
git commit -m "feat: add getRankTier lot tier helper"
```

- [x] **Step 6: Report progress**

`✅ Rank tier function + boundary tests - apps/api/src/builders/flex-message.builder.ts, apps/api/tests/rank-tier.test.ts`

---

## Task 3: Feature flag reader

**Files:**
- Modify: `apps/api/src/builders/flex-message.builder.ts`
- Test: `apps/api/tests/flex-message.builder.test.ts`

- [x] **Step 1: Write the failing test**

Append to `apps/api/tests/flex-message.builder.test.ts` (and add `getFlexSummaryVersion`, `resetFlexVersionWarning` to the existing import from `../src/builders/flex-message.builder`):

```ts
describe("getFlexSummaryVersion", () => {
  const original = process.env.FLEX_SUMMARY_VERSION;

  afterEach(() => {
    if (original === undefined) delete process.env.FLEX_SUMMARY_VERSION;
    else process.env.FLEX_SUMMARY_VERSION = original;
    resetFlexVersionWarning();
  });

  test("unset defaults to flex-v1", () => {
    delete process.env.FLEX_SUMMARY_VERSION;
    expect(getFlexSummaryVersion()).toBe("flex-v1");
  });

  test("empty string defaults to flex-v1", () => {
    process.env.FLEX_SUMMARY_VERSION = "";
    expect(getFlexSummaryVersion()).toBe("flex-v1");
  });

  test("flex-v1 is honoured", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v1";
    expect(getFlexSummaryVersion()).toBe("flex-v1");
  });

  test("flex-v2 is honoured", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v2";
    expect(getFlexSummaryVersion()).toBe("flex-v2");
  });

  test("unrecognized value falls back to flex-v1 and warns once", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v9";
    const warned: string[] = [];
    const originalWarn = logger.warn.bind(logger);
    // @ts-expect-error - test double for the pino warn signature
    logger.warn = (_obj: unknown, msg: string) => warned.push(msg);
    try {
      expect(getFlexSummaryVersion()).toBe("flex-v1");
      expect(getFlexSummaryVersion()).toBe("flex-v1");
    } finally {
      logger.warn = originalWarn;
    }
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("flex-v9");
  });
});
```

Add these imports at the top of the test file if missing:

```ts
import { afterEach } from "bun:test";
import { logger } from "../src/utils/logger";
```

- [x] **Step 2: Run the test to verify it fails**

Run from `apps/api`: `bun test tests/flex-message.builder.test.ts -t "getFlexSummaryVersion"`
Expected: FAIL - `getFlexSummaryVersion` is not exported.

- [x] **Step 3: Write the implementation**

In `apps/api/src/builders/flex-message.builder.ts`, add the import at the top:

```ts
import { logger } from "../utils/logger";
```

and add below `getRankTier`:

```ts
export type FlexSummaryVersion = "flex-v1" | "flex-v2";

// Read per call, not at module load: Bun caches the module, so a load-time
// read could not be flipped by tests that re-import this builder.
let warnedFlexVersion: string | null = null;

export function resetFlexVersionWarning(): void {
  warnedFlexVersion = null;
}

export function getFlexSummaryVersion(): FlexSummaryVersion {
  const raw = (process.env.FLEX_SUMMARY_VERSION ?? "").trim();
  if (raw === "") return "flex-v1";
  if (raw === "flex-v1" || raw === "flex-v2") return raw;
  if (warnedFlexVersion !== raw) {
    warnedFlexVersion = raw;
    logger.warn(
      { context: "flex-version" },
      `Unrecognized FLEX_SUMMARY_VERSION "${raw}", falling back to flex-v1`
    );
  }
  return "flex-v1";
}
```

- [x] **Step 4: Run the test to verify it passes**

Run from `apps/api`: `bun test tests/flex-message.builder.test.ts`
Expected: PASS, including both snapshot tests from Task 1 (still matching).

- [x] **Step 5: Commit**

```bash
git add apps/api/src/builders/flex-message.builder.ts apps/api/tests/flex-message.builder.test.ts
git commit -m "feat: add FLEX_SUMMARY_VERSION flag reader"
```

- [x] **Step 6: Report progress**

`✅ Feature flag reader with once-only warning - apps/api/src/builders/flex-message.builder.ts`

---

## Task 4: Split into V1 / V2 and build the v2 bubble

**Files:**
- Modify: `apps/api/src/types/hfm.types.ts`
- Modify: `apps/api/src/builders/flex-message.builder.ts`
- Test: `apps/api/tests/flex-message.builder.test.ts`

- [x] **Step 1: Add the shared monthly type**

Append to `apps/api/src/types/hfm.types.ts`:

```ts
/**
 * Current-calendar-month (Asia/Bangkok) trading activity for one account,
 * derived from a date-ranged client-performance call. `lots` is HFM `volume`.
 */
export interface MonthlyActivity {
  lots: number;
  hasTrade: boolean;
}
```

- [x] **Step 2: Write the failing v2 tests**

Append to `apps/api/tests/flex-message.builder.test.ts`:

```ts
describe("flex-v2 trading card", () => {
  const originalVersion = process.env.FLEX_SUMMARY_VERSION;

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.FLEX_SUMMARY_VERSION;
    else process.env.FLEX_SUMMARY_VERSION = originalVersion;
  });

  const v2Card = (
    data: HFMPerformanceData,
    monthly?: { lots: number; hasTrade: boolean }
  ): Record<string, unknown> => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v2";
    return buildTradingCard(data, matchAllConditions, {
      showVolume: true,
      monthly,
    }) as Record<string, unknown>;
  };

  test("keeps every v1 field except cumulative Volume", () => {
    const texts = extractTexts(v2Card(mockData, { lots: 2.5, hasTrade: true }));
    expect(texts).toContain("Wallet ID");
    expect(texts).toContain("Trading Account ID");
    expect(texts).toContain("Registration Date");
    expect(texts).toContain("Account Status");
    expect(texts).toContain("Subaffiliate");
    expect(texts).toContain("Registration");
    expect(texts).toContain("Condition");
    expect(texts).toContain("Trades");
    expect(texts).toContain("Last Trade");
    expect(texts).toContain("Balance");
    expect(texts).toContain("Equity");
    expect(texts).toContain("Account Type");
    expect(texts).toContain("Account Currency");
    expect(texts).toContain("For assistance, please contact support.");
    expect(texts).not.toContain("Volume");
    expect(texts.some((t) => t === "3.42 lots")).toBe(false);
  });

  test("active month shows green check and passing lots", () => {
    const card = v2Card(mockData, { lots: 2.5, hasTrade: true });
    const texts = extractTexts(card);
    expect(texts).toContain("This Month");
    expect(texts).toContain("Monthly Lots");
    expect(findBadgeByLabel(card, "\u2713 Active")!.color).toBe("#1DB954");
    const lots = findBadgeByLabel(card, "\u2713 2.50 / 2 lots");
    expect(lots).toBeDefined();
    expect(lots!.color).toBe("#1DB954");
  });

  test("inactive month shows red cross and failing lots", () => {
    const card = v2Card(mockData, { lots: 0, hasTrade: false });
    expect(findBadgeByLabel(card, "\u2717 Inactive")!.color).toBe("#DC2626");
    const lots = findBadgeByLabel(card, "\u2717 0.00 / 2 lots");
    expect(lots).toBeDefined();
    expect(lots!.color).toBe("#DC2626");
  });

  test("exactly 2 lots passes", () => {
    const card = v2Card(mockData, { lots: 2, hasTrade: true });
    expect(findBadgeByLabel(card, "\u2713 2.00 / 2 lots")).toBeDefined();
  });

  test("missing monthly data renders N/A rows", () => {
    const card = v2Card(mockData, undefined);
    const texts = extractTexts(card);
    expect(texts).toContain("This Month");
    expect(texts.filter((t) => t === "N/A").length).toBeGreaterThanOrEqual(2);
  });

  test("rank row shows the label only, with no cumulative lot number", () => {
    const card = v2Card({ ...mockData, volume: 1200 }, { lots: 1, hasTrade: true });
    const texts = extractTexts(card);
    expect(texts).toContain("Rank");
    expect(texts).toContain("\u{1F48E} Platinum");
    expect(texts.some((t) => t.includes("1200"))).toBe(false);
  });

  test("v2 JSON stays inside LINE Flex limits", () => {
    const card = v2Card(mockData, { lots: 2.5, hasTrade: true });
    const json = JSON.stringify(card);
    expect(card.type).toBe("bubble");
    expect(json.length).toBeLessThan(10_000);
    for (const t of extractTexts(card)) {
      expect(t.length).toBeLessThanOrEqual(2000);
    }
  });

  test("flag set to flex-v1 still renders the v1 card", () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v1";
    const texts = extractTexts(
      buildTradingCard(mockData, matchAllConditions, { showVolume: true })
    );
    expect(texts).toContain("Volume");
    expect(texts).not.toContain("Rank");
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run from `apps/api`: `bun test tests/flex-message.builder.test.ts -t "flex-v2"`
Expected: FAIL - the card still renders "Volume" and has no "Rank" row.

- [x] **Step 4: Rename the current builder to V1**

In `apps/api/src/builders/flex-message.builder.ts`, change only the signature line of the existing exported function.

Replace:

```ts
export function buildTradingCard(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: { showVolume?: boolean } = {}
): object {
```

with:

```ts
export interface TradingCardOptions {
  showVolume?: boolean;
  /** Current-calendar-month activity for this account. v2 only. */
  monthly?: MonthlyActivity;
}

// Frozen: the flex-v1 card. Do not change its output JSON - it is snapshot
// locked in tests/flex-message.builder.test.ts.
export function buildTradingCardV1(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: TradingCardOptions = {}
): object {
```

Leave the whole function body untouched.
Update the type import on line 1 to:

```ts
import type { HFMPerformanceData, ConditionCheck, MonthlyActivity } from "../types/hfm.types";
```

- [x] **Step 5: Add the v2 helpers and builder**

Add below `buildTradingCardV1` in the same file:

```ts
const MONTHLY_LOT_TARGET = 2;

const getMonthlyStatusMeta = (
  monthly: MonthlyActivity | undefined
): { label: string; color: string; backgroundColor: string } => {
  if (!monthly) {
    return { label: "N/A", color: colors.muted, backgroundColor: "#F3F4F6" };
  }
  if (monthly.hasTrade) {
    return {
      label: "\u2713 Active",
      color: colors.green,
      backgroundColor: colors.greenSoft,
    };
  }
  return {
    label: "\u2717 Inactive",
    color: "#DC2626",
    backgroundColor: "#FEF2F2",
  };
};

const getMonthlyLotsMeta = (
  monthly: MonthlyActivity | undefined
): { label: string; color: string; backgroundColor: string } => {
  if (!monthly) {
    return { label: "N/A", color: colors.muted, backgroundColor: "#F3F4F6" };
  }
  const lots = Number.isFinite(monthly.lots) ? monthly.lots : 0;
  const passed = lots >= MONTHLY_LOT_TARGET;
  return {
    label: `${passed ? "\u2713" : "\u2717"} ${lots.toFixed(2)} / ${MONTHLY_LOT_TARGET} lots`,
    color: passed ? colors.green : "#DC2626",
    backgroundColor: passed ? colors.greenSoft : "#FEF2F2",
  };
};

// flex-v2: same fields and order as v1, except the cumulative Volume metric is
// replaced by monthly status + monthly 2-lot progress, and a Rank row is added.
// Cumulative lots are never printed - they only decide the rank label.
export function buildTradingCardV2(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: TradingCardOptions = {}
): object {
  const status = getStatusMeta(data.activity_status);
  const accountStatus = getAccountStatusMeta(data.status);
  const matchAllBadge = getMatchAllMeta(conditions.matchAll);
  const walletIdValue = String(data.client_id);
  const accountIdValue = String(data.account_id);
  const lastTrade = fmtLastTrade(data.last_trade);
  const monthlyStatus = getMonthlyStatusMeta(options.monthly);
  const monthlyLots = getMonthlyLotsMeta(options.monthly);

  return {
    type: "bubble",
    size: "mega",
    styles: {
      header: { backgroundColor: colors.green },
      footer: { backgroundColor: colors.footer },
    },
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "xs",
      contents: [
        {
          type: "text",
          text: "Trading Account Summary",
          color: colors.white,
          weight: "bold",
          size: "md",
          wrap: true,
          maxLines: 2,
          adjustMode: "shrink-to-fit",
        },
        {
          type: "text",
          text: "Customer Support",
          color: "#E8F5E9",
          size: "xs",
          wrap: true,
          maxLines: 1,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "14px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            infoCard("Wallet ID", walletIdValue),
            infoCard("Trading Account ID", accountIdValue),
          ],
        },
        detailCard("Registration Date", fmtDate(data.account_regdate)),
        detailCard("Account Status", accountStatus.label, {
          color: accountStatus.color,
          backgroundColor: accountStatus.backgroundColor,
        }),
        detailCard("Subaffiliate", String(data.subaffiliate)),
        detailCard("Registration", status.label, {
          color: status.color,
          backgroundColor: status.backgroundColor,
        }),
        { type: "separator", color: colors.border },
        detailCard("Condition", matchAllBadge.label, {
          color: matchAllBadge.color,
          backgroundColor: matchAllBadge.backgroundColor,
        }),
        ...(!conditions.matchAll
          ? [
            {
              type: "box",
              layout: "vertical" as const,
              spacing: "xs" as const,
              backgroundColor: "#FEF2F2",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: getFailedConditionsText(conditions).map((msg) => ({
                type: "text",
                text: `\u2022 ${msg}`,
                size: "xs",
                color: "#DC2626",
                wrap: true,
              })),
            } as object,
          ]
          : []),
        { type: "separator", color: colors.border },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [metricCard("Trades", String(data.trades))],
        },
        detailCard("This Month", monthlyStatus.label, {
          color: monthlyStatus.color,
          backgroundColor: monthlyStatus.backgroundColor,
        }),
        detailCard("Monthly Lots", monthlyLots.label, {
          color: monthlyLots.color,
          backgroundColor: monthlyLots.backgroundColor,
        }),
        detailCard("Rank", getRankTier(data.volume)),
        detailCard("Last Trade", lastTrade.text, { color: lastTrade.color }),
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            metricCard(
              "Balance",
              fmtCurrency(data.balance, data.account_currency)
            ),
            metricCard(
              "Equity",
              fmtCurrency(data.equity, data.account_currency)
            ),
          ],
        },
        detailCard("Account Type", data.account_type),
        keyValueRow(
          "Account Currency",
          displayCurrencyLabel(data.account_currency)
        ),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: "For assistance, please contact support.",
          size: "xs",
          color: colors.muted,
          align: "center",
          wrap: true,
        },
      ],
    },
  };
}

// Single switch point for the card version. Reads the env flag per call.
export function buildTradingCard(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: TradingCardOptions = {}
): object {
  return getFlexSummaryVersion() === "flex-v2"
    ? buildTradingCardV2(data, conditions, options)
    : buildTradingCardV1(data, conditions, options);
}
```

- [x] **Step 6: Run the builder tests**

Run from `apps/api`: `bun test tests/flex-message.builder.test.ts`
Expected: PASS, including the Task 1 snapshots - they prove v1 output did not move.

- [x] **Step 7: Run typecheck**

Run from `apps/api`: `bun run typecheck`
Expected: no output, exit code 0.

- [x] **Step 8: Commit**

```bash
git add apps/api/src/builders/flex-message.builder.ts apps/api/src/types/hfm.types.ts apps/api/tests/flex-message.builder.test.ts
git commit -m "feat: add flex-v2 trading card behind flag"
```

- [x] **Step 9: Report progress**

`✅ v1/v2 split + v2 bubble (This Month, Monthly Lots, Rank) - apps/api/src/builders/flex-message.builder.ts, apps/api/src/types/hfm.types.ts`

---

## Task 5: Monthly volume fetch (needs Task 0 approval)

**Files:**
- Modify: `apps/api/src/services/hfm.service.ts`
- Test: `apps/api/tests/hfm.service.test.ts`

- [x] **Step 1: Write the failing test**

Append to `apps/api/tests/hfm.service.test.ts` (add `fetchMonthlyVolumeMap` to the existing import from `../src/services/hfm.service`):

```ts
describe("fetchMonthlyVolumeMap", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("maps account_id to monthly lots and trade flag", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          clients: [
            { ...mockHfmResponse.clients[0]!, account_id: 78451293, volume: 2.5, trades: 4 },
            { ...mockHfmResponse.clients[0]!, account_id: 78451294, volume: 0, trades: 0 },
          ],
          totals: mockHfmResponse.totals,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const map = await fetchMonthlyVolumeMap(45219);
    expect(map).not.toBeNull();
    expect(map!.get(78451293)).toEqual({ lots: 2.5, hasTrade: true });
    expect(map!.get(78451294)).toEqual({ lots: 0, hasTrade: false });
    expect(calledUrl).toContain("wallets=45219");
    expect(calledUrl).toContain("from_date=");
    expect(calledUrl).toContain("to_date=");
  });

  test("non-200 returns null instead of throwing", async () => {
    globalThis.fetch = mockFetch(500, { detail: "boom" });
    expect(await fetchMonthlyVolumeMap(45219)).toBeNull();
  });

  test("malformed body returns null", async () => {
    globalThis.fetch = mockFetch(200, { nope: true });
    expect(await fetchMonthlyVolumeMap(45219)).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run from `apps/api`: `bun test tests/hfm.service.test.ts -t "fetchMonthlyVolumeMap"`
Expected: FAIL - `fetchMonthlyVolumeMap` is not exported.

- [x] **Step 3: Write the implementation**

In `apps/api/src/services/hfm.service.ts`, add to the imports:

```ts
import { getThisMonthRange } from "../utils/date";
import type { MonthlyActivity } from "../types/hfm.types";
```

(add `MonthlyActivity` to the existing `import type { ... } from "../types/hfm.types";` block instead of a second import line)

and append at the end of the file:

```ts
// Month-scoped copy of the client-performance lookup. Same endpoint as
// fetchPerformance, plus the from_date/to_date pair that fetchClientsByRange
// already relies on, so `volume` comes back as the current month's lots.
// Timeout is short on purpose: this call sits inside the LINE reply path,
// and a null result degrades the card to "N/A" rather than losing the reply.
export async function fetchMonthlyVolumeMap(
  walletId: number,
  timeoutMs = 6_000,
): Promise<Map<number, MonthlyActivity> | null> {
  const { from, to } = getThisMonthRange();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
    const params = new URLSearchParams({
      wallets: String(walletId),
      from_date: from,
      to_date: to,
    });
    const url = `${baseUrl}/api/performance/client-performance?${params}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
    });

    if (res.status !== 200) {
      logError("hfm-service", `fetchMonthlyVolumeMap unexpected status ${res.status}`);
      return null;
    }

    const body = await readJsonResponse<HFMClientsPerformanceResponse>(res);
    if (!Array.isArray(body?.clients)) {
      logError("hfm-service", "fetchMonthlyVolumeMap malformed body");
      return null;
    }

    const map = new Map<number, MonthlyActivity>();
    for (const client of body.clients) {
      const lots = toNum(client.volume);
      const trades = toNum(client.trades);
      map.set(client.account_id, { lots, hasTrade: trades > 0 || lots > 0 });
    }
    return map;
  } catch (e: unknown) {
    logError("hfm-service", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run from `apps/api`: `bun test tests/hfm.service.test.ts`
Expected: PASS, all existing service tests still green.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/hfm.service.ts apps/api/tests/hfm.service.test.ts
git commit -m "feat: fetch current-month lots per account"
```

- [x] **Step 6: Report progress**

`✅ Monthly lots fetch with 6s budget and null fallback - apps/api/src/services/hfm.service.ts`

---

## Task 6: Wire the monthly map into the lookup reply

**Files:**
- Modify: `apps/api/src/routes/webhook.ts` (inside `handleLookupAndReply`, the block that builds `bubbles`)
- Test: `apps/api/tests/webhook.test.ts`

- [x] **Step 1: Write the failing test**

Add this **inside** the existing top-level `describe("webhook", ...)` block in `apps/api/tests/webhook.test.ts`, so the `beforeEach` test-database and env setup still applies:

```ts
describe("flex-v2 lookup path", () => {
  const originalVersion = process.env.FLEX_SUMMARY_VERSION;

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.FLEX_SUMMARY_VERSION;
    else process.env.FLEX_SUMMARY_VERSION = originalVersion;
  });

  test("v1 does not request the month range", async () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v1";
    const urls = await runLookupCapturingHfmUrls("98241376");
    expect(urls.some((u) => u.includes("from_date="))).toBe(false);
  });

  test("v2 requests the month range once", async () => {
    process.env.FLEX_SUMMARY_VERSION = "flex-v2";
    const urls = await runLookupCapturingHfmUrls("98241376");
    expect(urls.filter((u) => u.includes("from_date=")).length).toBe(1);
  });
});
```

Add the helper just above that `describe`, inside the existing top-level `describe("webhook", ...)` block so it reuses `computeSig`, `waitFor`, and `importWebhook`:

```ts
  async function runLookupCapturingHfmUrls(text: string): Promise<string[]> {
    const { app } = await importWebhook();
    const body = JSON.stringify({
      destination: "U123",
      events: [
        {
          type: "message",
          message: { type: "text", id: "123", text },
          source: { type: "user", userId: "Uabc123" },
          replyToken: "token123",
          timestamp: 1716000000000,
          mode: "active",
        },
      ],
    });
    const sig = computeSig(body, SECRET);

    const urls: string[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0]
    ) => {
      const url = String(input);
      urls.push(url);

      if (url.includes("/api/performance/client-performance")) {
        return new Response(
          JSON.stringify({
            clients: [
              {
                client_id: 45219,
                account_id: 78451293,
                activity_status: "active",
                trades: 24,
                volume: 3.42,
                account_type: "Standard",
                balance: 12450.8,
                account_currency: "USD",
                equity: 12998.35,
                archived: false,
                subaffiliate: 0,
                account_regdate: "2024-01-15T00:00:00Z",
                status: "approved",
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
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": sig,
        },
        body,
      })
    );
    expect(response.status).toBe(200);

    await waitFor(() =>
      urls.some((u) => u === "https://api.line.me/v2/bot/message/reply")
    );
    return urls;
  }
```

- [x] **Step 2: Run the test to verify it fails**

Run from `apps/api`: `bun test tests/webhook.test.ts -t "flex-v2 lookup path"`
Expected: FAIL - the v2 case records zero ranged calls.

- [x] **Step 3: Write the implementation**

In `apps/api/src/routes/webhook.ts`, update the imports:

```ts
import { fetchPerformance, resolveLinkedAccounts, checkConditions, parsePerformanceLookup, fetchMonthlyVolumeMap } from "../services/hfm.service";
import { buildTradingCard, buildPaginationCard, getFlexSummaryVersion } from "../builders/flex-message.builder";
import type { PerformanceLookup, MonthlyActivity } from "../types/hfm.types";
```

Then replace this block inside `handleLookupAndReply`:

```ts
    const bubbles = clientsToShow.map((clientData) => {
      const conditions = checkConditions(clientData);
      const enrichedClientData = {
        ...clientData,
        last_trade: lastTradeByAccountId.get(clientData.account_id) ?? null,
      };
      return buildTradingCard(enrichedClientData, conditions, {
        showVolume: lookup.showVolume,
      });
    });
```

with:

```ts
    // flex-v2 needs current-month lots, which the unranged lookup does not
    // carry. One extra ranged call per reply, only when v2 is on; a null
    // result renders "N/A" instead of holding up the reply token.
    const monthlyByAccountId: Map<number, MonthlyActivity> | null =
      getFlexSummaryVersion() === "flex-v2"
        ? await fetchMonthlyVolumeMap(result.data[0]!.client_id)
        : null;

    const bubbles = clientsToShow.map((clientData) => {
      const conditions = checkConditions(clientData);
      const enrichedClientData = {
        ...clientData,
        last_trade: lastTradeByAccountId.get(clientData.account_id) ?? null,
      };
      return buildTradingCard(enrichedClientData, conditions, {
        showVolume: lookup.showVolume,
        monthly: monthlyByAccountId?.get(clientData.account_id),
      });
    });
```

- [x] **Step 4: Run the test to verify it passes**

Run from `apps/api`: `bun test tests/webhook.test.ts`
Expected: PASS, all webhook tests green.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/webhook.ts apps/api/tests/webhook.test.ts
git commit -m "feat: pass monthly lots into the summary card"
```

- [x] **Step 6: Report progress**

`✅ Lookup handler feeds monthly data to v2 only - apps/api/src/routes/webhook.ts`

---

## Task 7: Document the flag and run the full gate

**Files:**
- Modify: `apps/api/.env.example`

- [x] **Step 1: Add the flag to the template**

Append to `apps/api/.env.example`:

```
# Trading Account Summary Flex card version.
# flex-v1 (default): current card, unchanged.
# flex-v2: replaces cumulative Volume with This Month status + Monthly Lots x / 2,
# and adds a Rank row. Any other value falls back to flex-v1 with a warning.
FLEX_SUMMARY_VERSION=flex-v1
```

- [x] **Step 2: Verify .env was not touched**

Run from the repo root: `git status --short`
Expected: `apps/api/.env` does not appear in the output.

- [x] **Step 3: Run typecheck**

Run from `apps/api`: `bun run typecheck`
Expected: exit code 0, no output.

- [x] **Step 4: Run the full suite**

Start the test database from the repo root first: `docker compose up -d postgres-test`
This machine has no `docker` binary (podman only) and already runs Postgres on `localhost:5433`, so this step was skipped during execution.
Then from `apps/api`: `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test bun test`
Expected: all tests pass, snapshots reported as matched (not written).

- [x] **Step 5: Confirm the v1 snapshot never changed**

Run from the repo root: `git log --oneline -- apps/api/tests/__snapshots__/flex-message.builder.test.ts.snap`
Expected: exactly one commit - the one from Task 1. If a later commit rewrote it, v1 output drifted; revert and fix.

- [x] **Step 6: Commit**

```bash
git add apps/api/.env.example
git commit -m "docs: document FLEX_SUMMARY_VERSION flag"
```

- [x] **Step 7: Report progress**

`✅ Flag documented, typecheck and full suite green - apps/api/.env.example`

---

## Acceptance Criteria Check

- [x] `FLEX_SUMMARY_VERSION` unset or `flex-v1` gives byte-identical JSON (Task 1 snapshot, re-verified in Task 4 Step 6 and Task 7 Step 5)
- [x] `flex-v2` shows all v1 fields except cumulative Volume, plus This Month, Monthly Lots x / 2 with pass/fail mark, and Rank (Task 4 Step 2 tests)
- [x] Rank boundary tests pass for 0, 0.22, 99.99, 100, 499.99, 500, 999.99, 1000, 3999.99, 4000 (Task 2)
- [x] `bun run typecheck` clean (Task 4 Step 7, Task 7 Step 3)
- [x] `.env.example` documents both values (Task 7 Step 1)
- [x] Flex JSON size and text length validated (Task 4 Step 2, "v2 JSON stays inside LINE Flex limits")

## Stop Conditions

Stop and ask the user before:

- Editing `apps/api/.env` or any deployment or Docker config
- Adding any dependency
- Changing `apps/api/src/db/schema.ts` or anything in `apps/api/drizzle/`
- Touching any file outside the File Structure table
- Proceeding past Task 0 without approval for the extra ranged API call
