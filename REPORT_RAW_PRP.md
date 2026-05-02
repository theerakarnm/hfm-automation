# HFM Web Report Frontend Demo PRP

## FEATURE:

Build a polished, professional frontend-only demo for the HFM affiliate reporting dashboard in `apps/web-report`.

This PRP is intentionally limited to the frontend. Do not build or modify backend services, databases, HFM API integrations, cron jobs, authentication, or deployment infrastructure. All backend responses must be mocked locally in the React app, but the mock data must be shaped as if it will later come from the real backend.

### Product Goal

Create a comprehensive executive-grade reporting dashboard that helps users understand wallet/account growth, missing wallets, account type distribution, activation funnel, funded-but-no-trade opportunities, and operational risks from HFM affiliate data.

The dashboard must feel like a realistic internal BI tool, not a placeholder demo. It should be useful for sales, support, affiliate operations, and management discussions even before backend integration exists.

### Target Users

- Affiliate operations manager who needs a daily business health overview.
- Sales/support team who needs to prioritize funded accounts that have not traded.
- Management user who wants high-level wallet/account growth and conversion insight.
- Developer/user validating the frontend data contract before backend implementation.

### Current App Context

The frontend app already exists at:

```text
apps/web-report
```

Current stack:

```text
Vite
React 19
TypeScript
Tailwind CSS v4
shadcn/ui
lucide-react
Radix UI via shadcn
JetBrains Mono variable font
```

Current installed shadcn component:

```text
src/components/ui/button.tsx
```

Current app entry files:

```text
apps/web-report/src/App.tsx
apps/web-report/src/main.tsx
apps/web-report/src/index.css
apps/web-report/src/components/theme-provider.tsx
apps/web-report/src/lib/utils.ts
```

### Non-Goals

- Do not call live HFM APIs.
- Do not call this repository's backend server.
- Do not create backend routes.
- Do not create SQLite tables.
- Do not implement auth or real user sessions.
- Do not implement export using a backend-generated file.
- Do not add global state libraries unless absolutely necessary.
- Do not build a generic dashboard builder.
- Do not add i18n infrastructure.

### Required User Experience

Create a single-page dashboard with a premium, dense, professional financial-operations feel.

The UI should support desktop first and remain usable on mobile.

Required visual direction:

- Preserve the existing shadcn theme tokens and square/radius-zero visual style from `index.css`.
- Use the existing mono/terminal-inspired typography direction, but keep readability high.
- Use concise, information-dense cards, tables, charts, and status badges.
- Avoid generic SaaS filler. The dashboard should look specific to affiliate wallet/account operations.
- Use dark mode support already provided by `ThemeProvider`.
- Use clear color semantics: green/growth, red/risk, amber/warning, blue/neutral analysis.

### Required Dashboard Sections

#### 1. Executive Overview

Show top-level KPI cards for the latest snapshot.

Required cards:

- Current Wallets
- Missing Wallets
- Total Accounts
- Funded But No Trade
- Net Deposit
- Active Trading Accounts
- Wallet to Account Ratio
- Data Freshness / Last Sync

Each KPI card must include:

- Primary value
- Delta versus previous day
- Small supporting label
- Status/risk treatment where applicable

Example:

```text
Current Wallets
1,284
+37 vs yesterday
92.4% have trading accounts
```

#### 2. Account Type Overview

Show account counts by required HFM account type groups:

- Pro
- Zero
- Bonus
- Premium
- Other

Required views:

- Compact KPI strip or cards
- Distribution chart
- Table with account type, accounts, active accounts, funded no trade, deposits, volume, active rate

#### 3. Activation Funnel

Show progression from wallet registration to active trading.

Required funnel stages:

```text
Wallet Registered
Trading Account Opened
Funded
First Trade
Active Trader
```

Required metrics:

- Count per stage
- Conversion rate between stages
- Drop-off count
- Drop-off rate

The funnel must make it obvious where users are stuck.

#### 4. Funded But No Trade Worklist

This is one of the most important operational views.

Show a prioritized table of accounts that match:

```text
accountRegistration >= trackingStartDate
AND (deposits > 0 OR firstFunding is not null)
AND trades = 0
AND firstTrade is null
```

Required columns:

- Priority
- Wallet ID
- Account ID
- Account Type
- Account Registration
- First Funding
- Deposit Amount
- Days Since Funding
- Country
- Campaign
- Platform
- Suggested Action

Required row behavior:

- High priority if deposit is large or days since funding is high.
- Medium priority for moderate deposit or recent funding.
- Low priority for small deposit and very recent funding.

Suggested actions:

- `Call today`
- `Send onboarding guide`
- `Check platform setup`
- `Monitor`

#### 5. Missing Wallet Risk Report

Show wallets that existed in the previous snapshot but are absent from the latest snapshot.

Required columns:

- Risk
- Wallet ID
- Last Seen Date
- Last Known Accounts
- Last Known Deposit
- Last Known Balance
- Last Known Volume
- Country
- Campaign
- Reason Hint

Risk logic:

- High risk: had deposits, balance, or volume.
- Medium risk: had account(s) but no deposit.
- Low risk: wallet only, no trading account.

#### 6. Trend Analytics

Show mock historical trend charts for at least 30 days.

Required charts:

- Wallet growth trend
- Account growth trend
- Funded but no trade trend
- Deposits vs withdrawals trend
- Active accounts trend

Charts can be simple line/bar/area charts using mocked data.

#### 7. Campaign / Country / Platform Quality

Show segmentation tables or cards for business insight.

Required breakdowns:

- Campaign performance
- Country performance
- Platform performance (`MT4`, `MT5`)

Required metrics per segment:

- Wallets
- Accounts
- Funded Accounts
- Active Accounts
- Funded No Trade
- Deposits
- Volume
- Conversion Rate
- Quality Score

#### 8. Data Quality Panel

Show whether the report data is reliable.

Required metrics:

- Last successful sync timestamp
- Records collected
- Unknown account types
- Duplicate account rows ignored
- API source status, mocked as healthy/warning
- Snapshot completeness percentage

This must be explicitly marked as demo/mock data.

### Navigation Structure

Use tabs or a sidebar-like section layout. Keep everything in a single frontend route for now.

Recommended tabs:

```text
Overview
Activation
Funded No Trade
Missing Wallets
Segments
Data Quality
```

### Filters

Add mock client-side filters.

Required filters:

- Date range preset: Today, 7D, 30D, MTD
- Account type: All, Pro, Zero, Bonus, Premium, Other
- Country
- Campaign
- Platform
- Risk level

Filters should update visible mocked tables/charts where practical. If full filtering would overcomplicate the demo, at minimum make table lists respond to account type/risk/search filters.

### Search

Add a search input for wallet/account lookup in operational tables.

Search should match:

- Wallet ID
- Account ID
- Email if included in mock data
- Campaign
- Country

### Mock Backend Data Contract

Create local mocked data that represents responses expected from the future backend.

Recommended files:

```text
apps/web-report/src/data/report.mock.ts
apps/web-report/src/types/report.ts
apps/web-report/src/lib/report-calculations.ts
```

The frontend should consume data through a mock service function rather than importing raw arrays directly in components.

Recommended file:

```text
apps/web-report/src/services/report-api.mock.ts
```

Example API facade:

```typescript
export async function getReportDashboard(): Promise<ReportDashboardResponse> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  return reportDashboardMock
}
```

This makes future backend replacement straightforward:

```typescript
// Later implementation can replace the mock body with:
// return fetch("/internal/report/dashboard?range=30d").then((res) => res.json())
```

### Required TypeScript Types

Define explicit types for the expected backend-shaped response.

Recommended minimum:

```typescript
export type AccountTypeGroup = "Pro" | "Zero" | "Bonus" | "Premium" | "Other"
export type RiskLevel = "High" | "Medium" | "Low"
export type Platform = "MT4" | "MT5"

export interface ReportDashboardResponse {
  meta: ReportMeta
  summary: ExecutiveSummary
  accountTypes: AccountTypeSummary[]
  funnel: FunnelStage[]
  fundedNoTrade: FundedNoTradeAccount[]
  missingWallets: MissingWallet[]
  trends: ReportTrends
  segments: ReportSegments
  dataQuality: DataQualitySummary
}

export interface ReportMeta {
  snapshotDate: string
  previousSnapshotDate: string
  trackingStartDate: string
  generatedAt: string
  timezone: "Asia/Bangkok"
  dataMode: "mock"
}

export interface ExecutiveSummary {
  currentWallets: MetricDelta
  missingWallets: MetricDelta
  totalAccounts: MetricDelta
  fundedNoTrade: MetricDelta
  netDeposit: MetricDelta
  activeTradingAccounts: MetricDelta
  walletToAccountRatio: MetricDelta
}

export interface MetricDelta {
  value: number
  previousValue: number
  delta: number
  deltaPercent: number
  direction: "up" | "down" | "flat"
  tone: "positive" | "negative" | "neutral" | "warning"
  format: "number" | "currency" | "percent" | "ratio"
}

export interface AccountTypeSummary {
  type: AccountTypeGroup
  accounts: number
  activeAccounts: number
  fundedNoTrade: number
  deposits: number
  volume: number
  activeRate: number
}

export interface FunnelStage {
  stage: "Wallet Registered" | "Trading Account Opened" | "Funded" | "First Trade" | "Active Trader"
  count: number
  conversionFromPrevious: number | null
  dropOffFromPrevious: number | null
}

export interface FundedNoTradeAccount {
  priority: RiskLevel
  walletId: number
  accountId: number
  accountType: AccountTypeGroup
  accountRegistration: string
  firstFunding: string
  depositAmount: number
  daysSinceFunding: number
  country: string
  campaign: string
  platform: Platform
  suggestedAction: "Call today" | "Send onboarding guide" | "Check platform setup" | "Monitor"
}

export interface MissingWallet {
  risk: RiskLevel
  walletId: number
  lastSeenDate: string
  lastKnownAccounts: number
  lastKnownDeposit: number
  lastKnownBalance: number
  lastKnownVolume: number
  country: string
  campaign: string
  reasonHint: string
}

export interface ReportTrends {
  walletGrowth: TrendPoint[]
  accountGrowth: TrendPoint[]
  fundedNoTrade: TrendPoint[]
  cashflow: CashflowTrendPoint[]
  activeAccounts: TrendPoint[]
}

export interface TrendPoint {
  date: string
  value: number
}

export interface CashflowTrendPoint {
  date: string
  deposits: number
  withdrawals: number
  netDeposit: number
}

export interface ReportSegments {
  campaigns: SegmentSummary[]
  countries: SegmentSummary[]
  platforms: SegmentSummary[]
}

export interface SegmentSummary {
  name: string
  wallets: number
  accounts: number
  fundedAccounts: number
  activeAccounts: number
  fundedNoTrade: number
  deposits: number
  volume: number
  conversionRate: number
  qualityScore: number
}

export interface DataQualitySummary {
  lastSuccessfulSync: string
  recordsCollected: number
  unknownAccountTypes: string[]
  duplicateRowsIgnored: number
  apiSourceStatus: "healthy" | "warning" | "error"
  snapshotCompleteness: number
}
```

### Mock Data Requirements

The demo data must be realistic and non-trivial.

Minimum mock volume:

- At least 30 historical trend points.
- At least 5 account type rows.
- At least 5 funnel stages.
- At least 12 funded-but-no-trade accounts.
- At least 8 missing wallets.
- At least 6 campaign segments.
- At least 5 country segments.
- At least 2 platform segments.

Use realistic sample values:

```text
walletId: 6503256, 6520562, 98241376, etc.
accountId: 78451293, 99001234, etc.
campaign: Thailand_Bonus_Q2, Line_Lead_Form, Partner_Webinar, Organic_App, Premium_LP
country: Thailand, Vietnam, Malaysia, Indonesia, Philippines
platform: MT4, MT5
accountType: Pro, Zero, Bonus, Premium, Other
```

### Required Components / Suggested File Structure

Use small focused components. Avoid putting the full dashboard in `App.tsx`.

Recommended structure:

```text
apps/web-report/src/App.tsx
apps/web-report/src/types/report.ts
apps/web-report/src/data/report.mock.ts
apps/web-report/src/services/report-api.mock.ts
apps/web-report/src/lib/formatters.ts
apps/web-report/src/lib/report-calculations.ts
apps/web-report/src/components/report/dashboard-shell.tsx
apps/web-report/src/components/report/kpi-card.tsx
apps/web-report/src/components/report/executive-overview.tsx
apps/web-report/src/components/report/account-type-overview.tsx
apps/web-report/src/components/report/activation-funnel.tsx
apps/web-report/src/components/report/funded-no-trade-table.tsx
apps/web-report/src/components/report/missing-wallets-table.tsx
apps/web-report/src/components/report/trend-analytics.tsx
apps/web-report/src/components/report/segment-quality.tsx
apps/web-report/src/components/report/data-quality-panel.tsx
apps/web-report/src/components/report/report-filters.tsx
apps/web-report/src/components/report/risk-badge.tsx
apps/web-report/src/components/report/metric-delta.tsx
```

Required shadcn components to add as needed:

```bash
bunx --bun shadcn@latest add card badge table tabs input select separator scroll-area tooltip progress skeleton
```

If implementing charts with shadcn chart/Recharts:

```bash
bunx --bun shadcn@latest add chart
```

If implementing date range picker:

```bash
bunx --bun shadcn@latest add calendar popover
```

### Formatting Requirements

Create formatter helpers instead of formatting inline everywhere.

Required helpers:

```typescript
export function formatNumber(value: number): string
export function formatCurrency(value: number): string
export function formatPercent(value: number): string
export function formatCompact(value: number): string
export function formatDate(value: string): string
export function formatDelta(value: number, format: MetricDelta["format"]): string
```

Currency can be shown in USD for the demo.

### Loading State

Even though the data is mocked, simulate async loading via the mock API facade.

Show skeletons or a loading panel for the first render.

### Empty State

Provide at least one reusable empty-state component for filtered tables.

Example:

```text
No accounts match the selected filters.
Try clearing account type, country, or risk filters.
```

### Demo Watermark / Disclosure

The UI must clearly indicate that all values are demo data.

Add a subtle badge near the report title:

```text
MOCK DATA
```

Add data freshness text:

```text
Generated from mocked backend contract. No live HFM API calls.
```

### Acceptance Criteria

- [ ] `apps/web-report` builds successfully with `bun run build`.
- [ ] No backend files are modified.
- [ ] No real HTTP calls are made.
- [ ] Mock API facade returns a typed `ReportDashboardResponse`.
- [ ] Dashboard renders all required sections.
- [ ] Dashboard works in light and dark mode.
- [ ] Dashboard is usable at desktop width and mobile width.
- [ ] Operational tables have realistic data and useful priority/risk badges.
- [ ] At least one chart renders from mock trend data.
- [ ] Filters/search affect at least the funded-no-trade and missing-wallet tables.
- [ ] The app visibly states that the data is mocked.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes or any existing lint limitations are documented.

## EXAMPLES:

There are no active example files currently available under the repository-level `examples/` directory to copy for this frontend dashboard. Use existing project files and previously captured planning context as the implementation examples.

### Existing App Example

File:

```text
apps/web-report/src/App.tsx
```

Current behavior:

```typescript
import { Button } from "@/components/ui/button"

export function App() {
  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Project ready!</h1>
          <p>You may now add components and start building.</p>
          <p>We&apos;ve already added the button component for you.</p>
          <Button className="mt-2">Button</Button>
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
      </div>
    </div>
  )
}
```

How to use this example:

- Replace the placeholder app content with the dashboard shell.
- Preserve the import alias pattern `@/...`.
- Preserve the existing theme provider and dark-mode behavior from `main.tsx`.
- Do not remove `ThemeProvider`.

### Existing shadcn Button Example

File:

```text
apps/web-report/src/components/ui/button.tsx
```

How to use this example:

- Follow the local shadcn style and import conventions.
- Use `Button` for filters, actions, and table row actions.
- Use `variant="outline"`, `variant="ghost"`, and `size="sm"` for dense dashboard controls.

### Existing Theme Example

Files:

```text
apps/web-report/src/main.tsx
apps/web-report/src/index.css
apps/web-report/src/components/theme-provider.tsx
```

How to use this example:

- Keep all report UI inside the existing `ThemeProvider`.
- Use theme tokens such as `bg-background`, `text-foreground`, `border-border`, `bg-card`, `text-muted-foreground`, and `text-primary`.
- Existing CSS defines chart tokens `--chart-1` through `--chart-5`; use these for chart colors.
- Existing theme uses `--radius: 0`; do not introduce heavily rounded cards that fight the visual system.

### Backend Planning Context Example

File:

```text
plan/hfm-daily-report-webapp.md
```

How to use this example:

- Use it only as domain context.
- Do not implement its backend schema, repositories, collectors, or cron jobs.
- Mirror its report concepts in mocked frontend data: current wallets, missing wallets, account type counts, total accounts, funded no trade, activation funnel, segment quality, and data quality.

## DOCUMENTATION:

### Local Project Documentation

```yaml
- file: apps/web-report/package.json
  why: Defines scripts, React/Vite versions, Tailwind/shadcn dependencies, and available validation commands.

- file: apps/web-report/components.json
  why: shadcn configuration. Uses style `radix-lyra`, TSX, Tailwind CSS at `src/index.css`, aliases under `@/`, and lucide icons.

- file: apps/web-report/src/index.css
  why: Theme tokens, dark mode variables, chart color variables, radius policy, font policy, and Tailwind v4 setup.

- file: apps/web-report/src/main.tsx
  why: Existing root render and `ThemeProvider` integration.

- file: apps/web-report/src/components/ui/button.tsx
  why: Existing shadcn component style and import convention.

- file: plan/hfm-daily-report-webapp.md
  why: Domain plan describing backend-shaped wallet/account/report data. Use only for mock data contract and report semantics.
```

### External Documentation

```yaml
- url: https://ui.shadcn.com/docs/components/card
  why: Use `Card`, `CardHeader`, `CardTitle`, `CardContent`, and `CardAction` for KPI and insight panels.

- url: https://ui.shadcn.com/docs/components/chart
  why: Use shadcn chart with Recharts for trend visualizations. Important: set `min-h-*`, `h-*`, or `aspect-*` on `ChartContainer` so responsive charts render correctly.

- url: https://ui.shadcn.com/docs/components/table
  why: Use responsive tables for funded-no-trade, missing wallet, account type, and segment reports.

- url: https://ui.shadcn.com/docs/components/tabs
  why: Use tabs to organize overview, activation, operational worklists, segment quality, and data quality sections in one route.

- url: https://ui.shadcn.com/docs/components/date-picker
  why: If using a date filter, compose it from `Popover` and `Calendar`; there is no standalone DatePicker root component.

- url: https://recharts.org/
  why: shadcn chart uses Recharts underneath. Use simple `LineChart`, `AreaChart`, `BarChart`, `XAxis`, `YAxis`, `CartesianGrid`, and tooltip components.

- url: https://lucide.dev/icons/
  why: Icons are already available through `lucide-react`; use icons sparingly for KPI context and risk/action cues.

- url: https://api.hfaffiliates.com/openapi.json
  why: Backend-shaped mock data should reflect HFM fields from `/api/performance/client-performance` and `/api/clients/`, without calling the live API.
```

## OTHER CONSIDERATIONS:

### Implementation Boundaries

- This is a frontend demo only.
- Use local mocked data and mock service functions.
- Keep mock data deterministic; do not generate random values on every render because it makes screenshots and review inconsistent.
- If mock data is programmatically generated, seed it or store generated arrays as static constants.
- Do not add backend assumptions that force the backend to match unnecessary frontend-only details.
- Keep the mock contract realistic enough that backend implementation can later satisfy it.

### Data Semantics

Use these definitions consistently:

```text
Current Wallets = count of distinct wallet IDs in the latest snapshot, including wallets without trading accounts.

Missing Wallets = wallet IDs present in previous snapshot but absent in latest snapshot.

Total Accounts = count of distinct trading account IDs in latest snapshot.

Account Type Counts = distinct account count grouped into Pro, Zero, Bonus, Premium, Other.

Funded But No Trade = account registered since tracking start, has deposits or first funding date, and has no first trade/trades.

Wallet to Account Ratio = total accounts / current wallets.

Active Trading Account = account with trades > 0 or volume > 0.

Net Deposit = deposits - withdrawals.
```

### Frontend Architecture Guidance

- Keep `App.tsx` small; it should load data and render `DashboardShell` or similar.
- Keep report-specific components under `src/components/report`.
- Keep mock data under `src/data`.
- Keep data types under `src/types`.
- Keep formatting/calculation helpers under `src/lib`.
- Prefer plain React state for filters.
- Do not add routing unless required; one route/page is enough for the demo.
- Do not add Redux/Zustand/TanStack Query for this mocked demo.
- Use `startTransition` only if filtering large local arrays causes visible jank; otherwise plain state is enough.
- Do not add `useMemo` by default unless repeated filtering/calculation is expensive and measurable.

### Component Guidance

- KPI cards should be visually dense but readable.
- Tables should support horizontal scrolling on mobile.
- Use badges for risk, account type, platform, and mock-data labels.
- Use progress bars for funnel conversion or snapshot completeness.
- Use charts for trends, not for every metric.
- Avoid pie charts unless they add clear value; bar/line/area charts are preferred.
- Use icons only when they improve scanning.

### Mobile Requirements

- KPI cards should wrap to one column on small screens.
- Tabs or section navigation should remain usable on narrow widths.
- Tables should use horizontal scroll rather than squeezing all columns unreadably.
- Header filters can stack vertically on mobile.

### Accessibility Requirements

- Use semantic table markup via shadcn `Table`.
- Ensure text contrast works in light and dark mode.
- Buttons and inputs must have visible focus states through shadcn defaults.
- Charts should include accessible labels or nearby textual summaries.
- Do not communicate risk only by color; include text labels like `High`, `Medium`, `Low`.

### Performance Requirements

- Mock data size should be realistic but modest.
- Initial load should be fast.
- Avoid heavy chart rendering in hidden sections if unnecessary.
- Keep components focused and avoid unnecessary prop drilling where simple composition is cleaner.

### Validation Commands

Run from `apps/web-report`:

```bash
bun run typecheck
bun run lint
bun run build
```

If shadcn component installation modifies formatting, run:

```bash
bun run format
```

### Expected Deliverable

After implementation, opening the Vite app should show a complete mocked HFM reporting dashboard with:

- Executive summary KPI cards
- Account type report
- Activation funnel
- Funded but no trade worklist
- Missing wallet risk table
- Trend charts
- Campaign/country/platform quality tables
- Data quality panel
- Filters/search
- Clear mock data disclosure

### Important Gotchas

- The app currently only has `button` installed from shadcn; install additional shadcn components before importing them.
- shadcn chart requires Recharts; the `chart` install should add the needed dependency if not present.
- Tailwind CSS v4 is used; do not add a Tailwind v3 config unless the project already requires it.
- Existing `index.css` already imports `shadcn/tailwind.css` and defines CSS variables; preserve this setup.
- The OpenAPI field names are not always the same between endpoints: `/api/clients/` uses `wallet`, `id`, `type`, while `/api/performance/client-performance` uses `client_id`, `account_id`, `account_type`.
- Since this is a mock frontend demo, normalize backend-shaped data into the `ReportDashboardResponse` contract instead of making components deal with raw HFM endpoint shapes.
- Keep all generated sample IDs fake but realistic; do not include real client names/emails unless explicitly provided.
- No secrets or API keys should be added anywhere in the frontend.
