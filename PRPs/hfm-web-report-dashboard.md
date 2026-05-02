# PRP: HFM Web Report Frontend Demo Dashboard

## Goal

Build a polished, professional frontend-only demo for the HFM affiliate reporting dashboard in `apps/web-report`. Create a comprehensive executive-grade reporting dashboard that helps users understand wallet/account growth, missing wallets, account type distribution, activation funnel, funded-but-no-trade opportunities, and operational risks from HFM affiliate data — all powered by local mocked data shaped to match the future backend contract.

**Non-Goals (DO NOT DO):**
- Do NOT call live HFM APIs or this repository's backend server
- Do NOT create/modify backend routes, SQLite tables, auth, or deployment infra
- Do NOT add global state libraries (Redux, Zustand, TanStack Query)
- Do NOT add routing — single page/route is sufficient
- Do NOT add i18n infrastructure
- Do NOT build a generic dashboard builder

## Why

- Enable affiliate operations, sales/support, and management to review daily HFM affiliate metrics before backend integration exists
- Establish a frontend data contract (types + mock service facade) that the real backend can later satisfy
- Serve as a visual spec and UX prototype for the full reporting system
- Reduce implementation risk by validating component composition, chart integration, and theme behavior early

## What

### Success Criteria

- [ ] `bun run build` succeeds in `apps/web-report` without errors
- [ ] No backend files modified anywhere in the repo
- [ ] No real HTTP calls made — all data from mock service
- [ ] Mock API facade returns a typed `ReportDashboardResponse`
- [ ] Dashboard renders all 8 required sections (see below)
- [ ] Dashboard works in light and dark mode via existing ThemeProvider
- [ ] Desktop-first layout with usable mobile (KPI cards wrap, tables horizontal-scroll)
- [ ] Charts render from mock trend data (at least one chart visible)
- [ ] Filters/search affect the funded-no-trade and missing-wallet tables
- [ ] Mock data disclosure visible near report title
- [ ] `bun run typecheck` passes (tsc --noEmit)
- [ ] `bun run lint` passes

### Required Dashboard Sections

1. **Executive Overview** — KPI cards: Current Wallets, Missing Wallets, Total Accounts, Funded But No Trade, Net Deposit, Active Trading Accounts, Wallet to Account Ratio, Data Freshness/Last Sync. Each shows primary value, delta vs previous day, and supporting label.

2. **Account Type Overview** — Distribution by Pro/Zero/Bonus/Premium/Other. KPI strip + table with accounts, active accounts, funded no trade, deposits, volume, active rate.

3. **Activation Funnel** — Stages: Wallet Registered → Trading Account Opened → Funded → First Trade → Active Trader. Show count per stage, conversion rate, drop-off count/rate.

4. **Funded But No Trade Worklist** — Prioritized table of accounts with deposits/no trades. Columns: Priority, Wallet ID, Account ID, Type, Registration, First Funding, Deposit, Days Since Funding, Country, Campaign, Platform, Suggested Action. Priority: High (large deposit / old funding), Medium (moderate), Low (small/recent). Suggested actions: "Call today", "Send onboarding guide", "Check platform setup", "Monitor".

5. **Missing Wallet Risk Report** — Wallets present in previous snapshot but absent from latest. Columns: Risk, Wallet ID, Last Seen, Accounts, Deposit, Balance, Volume, Country, Campaign, Reason Hint. Risk: High (had deposits/balance/volume), Medium (had accounts, no deposit), Low (wallet only).

6. **Trend Analytics** — 30-day trend charts: Wallet growth, Account growth, Funded-no-trade, Deposits vs Withdrawals, Active accounts. Use bar/line/area charts.

7. **Segment Quality** — Campaign/Country/Platform breakdowns with wallets, accounts, funded accounts, active accounts, funded-no-trade, deposits, volume, conversion rate, quality score.

8. **Data Quality Panel** — Last sync timestamp, records collected, unknown account types, duplicate rows ignored, API source status (mock: healthy/warning), snapshot completeness. Explicitly marked as demo/mock data.

### Navigation

Tabs: Overview | Activation | Funded No Trade | Missing Wallets | Segments | Data Quality

### Filters

Date range presets (Today, 7D, 30D, MTD), Account Type, Country, Campaign, Platform, Risk Level. Filters update visible tables/charts. At minimum, tables must respond to account type/risk/search filters.

### Search

Search input matching wallet ID, account ID, email, campaign, country in operational tables.

### Mock Data Contract

All data delivered through an async mock API facade:

```typescript
export async function getReportDashboard(): Promise<ReportDashboardResponse> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  return reportDashboardMock
}
```

Components consume data from this service, never importing raw arrays directly.

### Demo Watermark

Visible "MOCK DATA" badge near report title. Text explaining data source is mocked.

## All Needed Context

### Existing Project Stack

```
Vite 7, React 19, TypeScript ~5.9, Tailwind CSS v4, shadcn/ui (radix-lyra style),
JetBrains Mono variable font, lucide-react, Radix UI via shadcn, class-variance-authority
```

### Documentation & References

```yaml
MUST_READ - shadcn/ui components (use these patterns):
- url: https://ui.shadcn.com/docs/components/card
  why: KPI cards and insight panels. Use Card, CardHeader, CardTitle, CardContent.
- url: https://ui.shadcn.com/docs/components/chart
  why: Trend visualizations via shadcn chart (uses Recharts). CRITICAL: ChartContainer needs explicit height (min-h-*, h-*, or aspect-*).
- url: https://ui.shadcn.com/docs/components/table
  why: Funded-no-trade, missing wallets, account type, segment tables.
- url: https://ui.shadcn.com/docs/components/tabs
  why: Section navigation — Overview, Activation, Funded No Trade, Missing Wallets, Segments, Data Quality.
- url: https://ui.shadcn.com/docs/components/badge
  why: Risk levels, account types, platform tags, mock-data label.
- url: https://ui.shadcn.com/docs/components/input
  why: Search input for wallet/account lookup.
- url: https://ui.shadcn.com/docs/components/select
  why: Filter dropdowns (account type, country, campaign, platform, risk level).
- url: https://ui.shadcn.com/docs/components/separator
  why: Visual separation between sections.
- url: https://ui.shadcn.com/docs/components/scroll-area
  why: Horizontal-scroll tables on mobile.
- url: https://ui.shadcn.com/docs/components/tooltip
  why: KPI explanations, truncation hints.
- url: https://ui.shadcn.com/docs/components/progress
  why: Funnel conversion bars, snapshot completeness.
- url: https://ui.shadcn.com/docs/components/skeleton
  why: Loading states for initial async data fetch.
- url: https://ui.shadcn.com/docs/components/date-picker
  why: If date filter is needed. Compose from Popover + Calendar (no standalone DatePicker root).

MUST_READ - Chart library:
- url: https://recharts.org/en-US/api
  why: shadcn chart uses Recharts underneath. Use LineChart, AreaChart, BarChart, XAxis, YAxis, CartesianGrid, Tooltip components.

MUST_READ - Icons:
- url: https://lucide.dev/icons/
  why: Icons via lucide-react (already installed). Use sparingly for KPI context and risk/action cues.

MUST_READ - Domain semantics:
- file: plan/hfm-daily-report-webapp.md
  why: Backend-shaped wallet/account/report data definitions. Use ONLY for mock data semantics and report logic — do NOT implement backend schema, repositories, collectors, or cron jobs.

MUST_READ - Existing codebase files:
- file: apps/web-report/package.json
  why: Scripts (dev, build, lint, typecheck, format), available dependencies, bun as package manager.
- file: apps/web-report/components.json
  why: shadcn config: radix-lyra style, TSX, Tailwind CSS at src/index.css, aliases under @/, lucide icons.
- file: apps/web-report/src/index.css
  why: Theme tokens, dark mode vars, chart color vars (--chart-1 through --chart-5), radius: 0, font-mono. Tailwind v4 @import setup.
- file: apps/web-report/src/main.tsx
  why: Root render wraps App in ThemeProvider. Do NOT remove ThemeProvider.
- file: apps/web-report/src/components/theme-provider.tsx
  why: Light/dark/system theme support. Press 'd' toggles theme. Keep intact.
- file: apps/web-report/src/components/ui/button.tsx
  why: Existing shadcn component pattern. Uses CVA variants, cn(), radix Slot. Follow this convention.
- file: apps/web-report/src/lib/utils.ts
  why: cn() utility for merging Tailwind classes. Use everywhere.
- file: apps/web-report/src/App.tsx
  why: Current placeholder. Replace content with DashboardShell. Preserve @/ import alias.
- file: apps/web-report/vite.config.ts
  why: React + Tailwind v4 plugins, @/ path alias.
- file: apps/web-report/tsconfig.app.json
  why: verbatimModuleSyntax: true → use `import type` for type-only imports. strict: true, noUnusedLocals: true.
- file: apps/web-report/eslint.config.js
  why: Uses typescript-eslint, react-hooks, react-refresh plugins.
- file: apps/web-report/.prettierrc
  why: no semicolons, double quotes, trailingComma es5, printWidth 80, tailwind plugin with cn/cva functions.
- file: apps/web-report/tsconfig.json
  why: Base config with @/* path alias mapping.

MUST_READ - HFM API reference (for mock data shape only):
- url: https://api.hfaffiliates.com/openapi.json
  why: Backend-shaped mock data should reflect HFM fields from /api/performance/client-performance and /api/clients/. Do NOT call the live API.
```

### Known Gotchas & Critical Rules

```
GOTCHA 1: shadcn chart requires Recharts.
  When running `bunx --bun shadcn@latest add chart`, it should auto-install recharts.
  If not, run `bun add recharts` manually. Verify with: bun run typecheck.

GOTCHA 2: ChartContainer height.
  shadcn ChartContainer wrapper requires explicit height via Tailwind classes.
  Always add: className="min-h-[200px] h-[300px]" or "aspect-[4/3]" to ChartContainer.
  Without this, charts render at 0 height and are invisible.

GOTCHA 3: Tailwind CSS v4 — NO tailwind.config.js.
  Do NOT create a tailwind.config.js file. All Tailwind config is in index.css via @theme inline.
  Dark mode uses @custom-variant dark (&:is(.dark *)) in index.css.
  shadcn components may generate with Tailwind v3 patterns — adapt any v3-specific classes to v4.

GOTCHA 4: --radius: 0 in index.css.
  All cards/components have zero border-radius (sharp/square corners).
  Do NOT add rounded styles that conflict. The visual system is intentionally terminal-inspired.

GOTCHA 5: JetBrains Mono is the default font.
  html { @apply font-mono; } in index.css. All text renders in JetBrains Mono.
  However, keep readability high even with mono font — use appropriate sizes and spacing.

GOTCHA 6: verbatimModuleSyntax in tsconfig.app.json.
  TypeScript type-only imports MUST use: `import type { Foo } from "@/types/report"`
  Runtime + type imports: `import { useState, type FC } from "react"`

GOTCHA 7: shadcn install modifies existing files.
  `bunx --bun shadcn@latest add` may modify index.css, package.json, and tsconfig.
  After install, verify: run `bun run typecheck` and `bun run lint` to catch issues.
  Revert any unintended formatting changes to existing theme code.

GOTCHA 8: Deterministic mock data.
  Do NOT use Math.random() in render or generate random values on every mount.
  Seed mock data or store as static constant arrays. Inconsistent data makes screenshots and review unreliable.

GOTCHA 9: shadcn add invokes bun install.
  The shadcn CLI may run `bun install` after adding components. This is expected.

GOTCHA 10: radix-lyra style uses specific CSS variable patterns.
  shadcn components in this project use `radix-lyra` style (components.json: style: "radix-lyra").
  Newly added components will match this automatically. Do NOT override the style config.

GOTCHA 11: Chart colors are pre-defined.
  --chart-1 through --chart-5 in index.css are blue-scale (oklch). Use these for chart colors.
  Color 1 = lighter, Color 5 = darker. These work in both light and dark mode.

GOTCHA 12: Mobile tables need horizontal scroll.
  Tables with many columns should wrap in ScrollArea or a div with overflow-x-auto.
  Do NOT try to squeeze all columns — horizontal scroll is the expected mobile behavior.
```

### TypeScript Types (Complete)

These types define the mock data contract. Place in `apps/web-report/src/types/report.ts`:

```typescript
export type AccountTypeGroup = "Pro" | "Zero" | "Bonus" | "Premium" | "Other"
export type RiskLevel = "High" | "Medium" | "Low"
export type Platform = "MT4" | "MT5"
export type DateRangePreset = "today" | "7d" | "30d" | "mtd"
export type FunnelStageName =
  | "Wallet Registered"
  | "Trading Account Opened"
  | "Funded"
  | "First Trade"
  | "Active Trader"
export type SuggestedAction =
  | "Call today"
  | "Send onboarding guide"
  | "Check platform setup"
  | "Monitor"
export type MetricFormat = "number" | "currency" | "percent" | "ratio"
export type Direction = "up" | "down" | "flat"
export type Tone = "positive" | "negative" | "neutral" | "warning"

export interface MetricDelta {
  value: number
  previousValue: number
  delta: number
  deltaPercent: number
  direction: Direction
  tone: Tone
  format: MetricFormat
}

export interface ExecutiveSummary {
  currentWallets: MetricDelta
  missingWallets: MetricDelta
  totalAccounts: MetricDelta
  fundedNoTrade: MetricDelta
  netDeposit: MetricDelta
  activeTradingAccounts: MetricDelta
  walletToAccountRatio: MetricDelta
  dataFreshness: {
    lastSync: string
    dataMode: "mock"
  }
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
  stage: FunnelStageName
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
  suggestedAction: SuggestedAction
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

export interface ReportTrends {
  walletGrowth: TrendPoint[]
  accountGrowth: TrendPoint[]
  fundedNoTrade: TrendPoint[]
  cashflow: CashflowTrendPoint[]
  activeAccounts: TrendPoint[]
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

export interface ReportSegments {
  campaigns: SegmentSummary[]
  countries: SegmentSummary[]
  platforms: SegmentSummary[]
}

export interface DataQualitySummary {
  lastSuccessfulSync: string
  recordsCollected: number
  unknownAccountTypes: string[]
  duplicateRowsIgnored: number
  apiSourceStatus: "healthy" | "warning" | "error"
  snapshotCompleteness: number
}

export interface ReportMeta {
  snapshotDate: string
  previousSnapshotDate: string
  trackingStartDate: string
  generatedAt: string
  timezone: "Asia/Bangkok"
  dataMode: "mock"
}

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
```

### Data Semantics (for mock data generation and calculations)

```
Current Wallets = count of distinct wallet IDs in latest snapshot, including wallets without trading accounts
Missing Wallets = wallet IDs present in previous snapshot but absent in latest snapshot
Total Accounts = count of distinct trading account IDs in latest snapshot
Account Type Counts = distinct account count grouped into Pro/Zero/Bonus/Premium/Other
Funded But No Trade = account registered since tracking start, has deposits or firstFunding, no trades/firstTrade
Wallet to Account Ratio = total accounts / current wallets
Active Trading Account = account with trades > 0 or volume > 0
Net Deposit = deposits - withdrawals
```

### Mock Data Requirements

Place in `apps/web-report/src/data/report.mock.ts`. Export a single constant `reportDashboardMock: ReportDashboardResponse`.

Minimum mock volume:
- 30 historical trend points for each trend array
- 5 account type rows (Pro, Zero, Bonus, Premium, Other)
- 5 funnel stages
- 12+ funded-but-no-trade accounts (mix of High/Medium/Low priorities)
- 8+ missing wallets (mix of High/Medium/Low risks)
- 6 campaign segments
- 5 country segments
- 2 platform segments (MT4, MT5)

Use realistic sample values:

```
walletId: 6503256, 6520562, 98241376, 78451293, 99001234, etc.
accountId: 78451293, 99001234, 12387654, etc.
campaign: Thailand_Bonus_Q2, Line_Lead_Form, Partner_Webinar, Organic_App, Premium_LP, Social_Retarget
country: Thailand, Vietnam, Malaysia, Indonesia, Philippines
platform: MT4, MT5
accountType: Pro, Zero, Bonus, Premium, Other
```

**CRITICAL:** Store mock data as a static literal object (not as a generator function). Every import must return identical data.

**CRITICAL:** Delta values (delta, deltaPercent) must be consistent with value and previousValue, i.e., `delta = value - previousValue` and `deltaPercent = (delta / previousValue) * 100` (when previousValue !== 0).

### Data Flow Architecture

```
App.tsx
  → calls getReportDashboard() from services/report-api.mock.ts
  → renders <DashboardShell data={reportData} />

DashboardShell (src/components/report/dashboard-shell.tsx)
  → owns filter state (dateRange, accountType, country, campaign, platform, riskLevel, searchQuery)
  → renders tabs: Overview | Activation | Funded No Trade | Missing Wallets | Segments | Data Quality
  → renders <ReportFilters /> + <MockDataDisclosure />
  → passes filtered data to tab content sections

Each section component receives its slice of ReportDashboardResponse + active filters
```

### Formatter Helpers (src/lib/formatters.ts)

```typescript
export function formatNumber(value: number): string
  // "1,284" for integers, "1,284.50" for decimals
export function formatCurrency(value: number): string
  // "$12,450.00" — use USD for demo
export function formatPercent(value: number): string
  // "92.4%" — expects value like 92.4 (not 0.924)
export function formatCompact(value: number): string
  // "12.5K", "1.2M" for large values
export function formatDate(value: string): string
  // "2026-05-02" → "May 2, 2026"
export function formatDelta(value: number, format: MetricDelta["format"]): string
  // "+37", "+$1,250", "+3.2%", "+0.5" depending on format
```

Implement in `apps/web-report/src/lib/formatters.ts`. These MUST be used consistently across all components — never inline number/date formatting.

### Report Calculation Helpers (src/lib/report-calculations.ts)

```typescript
// Filter funded-no-trade accounts by search query (wallet ID, account ID, country, campaign)
export function filterFundedNoTrade(
  accounts: FundedNoTradeAccount[],
  filters: { search: string; accountType?: AccountTypeGroup | "All"; risk?: RiskLevel | "All" }
): FundedNoTradeAccount[]

// Filter missing wallets by search query (wallet ID, country, campaign)
export function filterMissingWallets(
  wallets: MissingWallet[],
  filters: { search: string; risk?: RiskLevel | "All" }
): MissingWallet[]

// Filter segments by search
export function filterSegments(
  segments: SegmentSummary[],
  search: string
): SegmentSummary[]
```

Implement in `apps/web-report/src/lib/report-calculations.ts`.

## Implementation Blueprint

### Phase 0: Install shadcn Components

Install all required shadcn/ui components in `apps/web-report`:

```bash
bunx --bun shadcn@latest add card badge table tabs input select separator scroll-area tooltip progress skeleton chart
```

**After install, verify:**
```bash
bun run typecheck   # catch any missing types/recharts issues
bun run lint        # catch any eslint violations from generated files
```

If `bunx shadcn add chart` does NOT install recharts, run: `bun add recharts`

### Phase 1: Foundation (Types + Data + Helpers)

**Task 1.1: Create TypeScript types**
- CREATE `apps/web-report/src/types/report.ts`
- Copy the complete type definitions from this PRP's "TypeScript Types" section
- Every type MUST be exported
- Use `export type` for all type/interface exports

**Task 1.2: Create formatter helpers**
- CREATE `apps/web-report/src/lib/formatters.ts`
- Implement all 6 formatter functions from "Formatter Helpers" section
- Use `Intl.NumberFormat` for locale-aware formatting
- `formatDelta` prepends "+" for positive, "-" for negative, "" for zero

**Task 1.3: Create calculation helpers**
- CREATE `apps/web-report/src/lib/report-calculations.ts`
- Implement filter functions from "Report Calculation Helpers" section
- Search should be case-insensitive `String.includes()` match on text fields and `String()` for numeric IDs

**Task 1.4: Create mock data**
- CREATE `apps/web-report/src/data/report.mock.ts`
- Build a static `reportDashboardMock` constant matching `ReportDashboardResponse`
- Generate 30 trend points (2026-04-03 through 2026-05-02)
- Generate realistic account/wallet mock rows meeting minimum volumes from "Mock Data Requirements"
- Ensure delta values are mathematically consistent (delta = value - previousValue)
- Reference sample values table for realistic IDs/names

**Task 1.5: Create mock API service**
- CREATE `apps/web-report/src/services/report-api.mock.ts`
- Export `getReportDashboard(): Promise<ReportDashboardResponse>`
- Simulate 250ms async delay with `setTimeout`
- Return `reportDashboardMock` from the mock data module

### Phase 2: Shared UI Components

**Task 2.1: Create RiskBadge component**
- CREATE `apps/web-report/src/components/report/risk-badge.tsx`
- Props: `level: RiskLevel`
- Renders shadcn Badge with color: High=destructive (red), Medium=amber/warning variants, Low=secondary
- Always shows text label (High/Medium/Low) for accessibility

**Task 2.2: Create MetricDelta component**
- CREATE `apps/web-report/src/components/report/metric-delta.tsx`
- Props: `delta: number, format: MetricFormat`
- Shows formatted delta with directional arrow (↑ for up, ↓ for down, → for flat)
- Color: "up" = green (text-emerald-500), "down" = red (text-red-500), "flat" = muted-foreground

**Task 2.3: Create KpiCard component**
- CREATE `apps/web-report/src/components/report/kpi-card.tsx`
- Props: `title: string, metric: MetricDelta, className?: string`
- Uses shadcn Card components
- Shows: title (small muted), primary value (large), MetricDelta, supporting label from metric
- Follows the existing style: no rounded corners, mono font, dense layout

### Phase 3: Dashboard Section Components

**Task 3.1: Create ExecutiveOverview**
- CREATE `apps/web-report/src/components/report/executive-overview.tsx`
- Props: `summary: ExecutiveSummary`
- Grid of KpiCard components (2 cols desktop, 1 col mobile)
- 8 cards: Current Wallets, Missing Wallets, Total Accounts, Funded No Trade, Net Deposit, Active Trading, Wallet/Account Ratio, Data Freshness

**Task 3.2: Create AccountTypeOverview**
- CREATE `apps/web-report/src/components/report/account-type-overview.tsx`
- Props: `accountTypes: AccountTypeSummary[]`
- KPI strip: 5 small cards (one per account type) showing count
- Distribution bar chart (simple horizontal bars using divs, not Recharts)
- Table below: Type, Accounts, Active, FundedNoTrade, Deposits, Volume, Active Rate

**Task 3.3: Create ActivationFunnel**
- CREATE `apps/web-report/src/components/report/activation-funnel.tsx`
- Props: `funnel: FunnelStage[]`
- Horizontal bar representation of each funnel stage
- Show: stage name, count, conversion rate (from previous), drop-off count
- Use shadcn Progress for conversion bars
- Highlight drop-off visually (amber/red where significant)

**Task 3.4: Create FundedNoTradeTable**
- CREATE `apps/web-report/src/components/report/funded-no-trade-table.tsx`
- Props: `accounts: FundedNoTradeAccount[], searchQuery: string, accountTypeFilter: AccountTypeGroup | "All", riskFilter: RiskLevel | "All"`
- Uses shadcn Table with all required columns
- Apply filters using report-calculations helpers
- Priority badges via RiskBadge component
- SuggestedAction as colored badge
- Wrap in ScrollArea for mobile horizontal scroll
- Show empty state when filtered results are empty

**Task 3.5: Create MissingWalletsTable**
- CREATE `apps/web-report/src/components/report/missing-wallets-table.tsx`
- Props: `wallets: MissingWallet[], searchQuery: string, riskFilter: RiskLevel | "All"`
- Uses shadcn Table with all required columns
- Apply filters using report-calculations helpers
- Risk badges via RiskBadge component
- Wrap in ScrollArea for mobile horizontal scroll
- Show empty state when filtered results are empty

**Task 3.6: Create TrendAnalytics**
- CREATE `apps/web-report/src/components/report/trend-analytics.tsx`
- Props: `trends: ReportTrends`
- Five chart sections using shadcn Chart + Recharts
- CRITICAL: Every ChartContainer must have explicit height (min-h-[200px] h-[300px])
- Use chart color tokens: --chart-1 through --chart-5
- Chart components: ChartContainer, ChartTooltip, ChartTooltipContent
- Charts: wallet growth (LineChart), account growth (LineChart), funded no trade (AreaChart), cashflow (BarChart deposits+withdrawals), active accounts (LineChart)
- Use CartesianGrid, XAxis with formatted dates, YAxis
- Tooltip shows formatted values using formatters

**Task 3.7: Create SegmentQuality**
- CREATE `apps/web-report/src/components/report/segment-quality.tsx`
- Props: `segments: ReportSegments`
- Three sub-tables (or compact cards): Campaigns, Countries, Platforms
- Each shows: Name, Wallets, Accounts, Funded, Active, FnT, Deposits, Volume, Conv. Rate, Quality Score
- Quality Score shown as colored progress bar or badge

**Task 3.8: Create DataQualityPanel**
- CREATE `apps/web-report/src/components/report/data-quality-panel.tsx`
- Props: `dataQuality: DataQualitySummary, meta: ReportMeta`
- Display: last sync time, records collected, unknown types list, duplicates ignored, API status (healthy/warning with colored badge), completeness (shadcn Progress)
- MUST include visible mock data disclosure text

### Phase 4: Integration Shell

**Task 4.1: Create ReportFilters**
- CREATE `apps/web-report/src/components/report/report-filters.tsx`
- Props: filter state values + setter callbacks
- Date range buttons/pills: Today, 7D, 30D, MTD
- shadcn Selects for: Account Type, Country, Campaign, Platform, Risk Level
- Search Input for wallet/account lookup
- Filters stack vertically on mobile

**Task 4.2: Create DashboardShell**
- CREATE `apps/web-report/src/components/report/dashboard-shell.tsx`
- Props: `data: ReportDashboardResponse`
- Owns all filter state via `useState` (no external state library)
- Renders: header with title + "MOCK DATA" badge + disclosure text
- Renders ReportFilters
- Uses shadcn Tabs for navigation (Overview, Activation, Funded No Trade, Missing Wallets, Segments, Data Quality)
- Each tab renders the corresponding section component with filtered data
- Wraps content in `max-w-[1400px] mx-auto px-4 py-6` container
- Loading state: show Skeleton components while data is null

**Task 4.3: Create EmptyState (utility component)**
- CREATE `apps/web-report/src/components/report/empty-state.tsx`
- Props: `title: string, description: string, action?: { label: string, onClick: () => void }`
- Reusable component shown when filtered tables have no results

**Task 4.4: Update App.tsx**
- REPLACE existing App.tsx content
- Import `getReportDashboard` and `DashboardShell`
- Use `useState` + `useEffect` to fetch mock data on mount
- Show Skeleton during loading (wrapped in the existing `min-h-svh` + ThemeProvider context)
- Render `DashboardShell` when data is available
- Preserve existing ThemeProvider wrapper (already in main.tsx)

### Task Execution Order (sequential phases)

```
Phase 0:  Install shadcn components
Phase 1:  types → formatters → mock data → calculations → api mock
Phase 2:  risk-badge → metric-delta → kpi-card
Phase 3:  executive-overview → account-type-overview → activation-funnel →
          funded-no-trade-table → missing-wallets-table → trend-analytics →
          segment-quality → data-quality-panel
Phase 4:  report-filters → empty-state → dashboard-shell → update App.tsx
```

After each phase, run validation gates to catch issues early.

### File Structure (final state)

```
apps/web-report/src/
├── App.tsx                                  # Replaced — minimal, loads mock API, renders DashboardShell
├── main.tsx                                 # UNCHANGED
├── index.css                                # UNCHANGED (may be updated by shadcn, restore if needed)
├── types/
│   └── report.ts                            # NEW — all ReportDashboardResponse types
├── data/
│   └── report.mock.ts                       # NEW — static mock data constant
├── services/
│   └── report-api.mock.ts                   # NEW — async mock API facade
├── lib/
│   ├── utils.ts                             # UNCHANGED — cn()
│   ├── formatters.ts                        # NEW — formatting helpers
│   └── report-calculations.ts               # NEW — filter/search helpers
├── components/
│   ├── theme-provider.tsx                    # UNCHANGED
│   ├── ui/
│   │   ├── button.tsx                       # UNCHANGED
│   │   ├── card.tsx                          # NEW (shadcn)
│   │   ├── badge.tsx                         # NEW (shadcn)
│   │   ├── table.tsx                         # NEW (shadcn)
│   │   ├── tabs.tsx                          # NEW (shadcn)
│   │   ├── input.tsx                         # NEW (shadcn)
│   │   ├── select.tsx                        # NEW (shadcn)
│   │   ├── separator.tsx                     # NEW (shadcn)
│   │   ├── scroll-area.tsx                   # NEW (shadcn)
│   │   ├── tooltip.tsx                       # NEW (shadcn)
│   │   ├── progress.tsx                      # NEW (shadcn)
│   │   ├── skeleton.tsx                      # NEW (shadcn)
│   │   └── chart.tsx                         # NEW (shadcn)
│   └── report/
│       ├── dashboard-shell.tsx               # NEW
│       ├── kpi-card.tsx                      # NEW
│       ├── metric-delta.tsx                  # NEW
│       ├── risk-badge.tsx                    # NEW
│       ├── executive-overview.tsx            # NEW
│       ├── account-type-overview.tsx         # NEW
│       ├── activation-funnel.tsx             # NEW
│       ├── funded-no-trade-table.tsx         # NEW
│       ├── missing-wallets-table.tsx         # NEW
│       ├── trend-analytics.tsx               # NEW
│       ├── segment-quality.tsx               # NEW
│       ├── data-quality-panel.tsx            # NEW
│       ├── report-filters.tsx                # NEW
│       └── empty-state.tsx                   # NEW
```

### Pseudocode for Key Components

```typescript
// App.tsx pseudocode
// PATTERN: Keep simple — load data, render shell or skeleton
function App() {
  const [data, setData] = useState<ReportDashboardResponse | null>(null)
  
  useEffect(() => {
    getReportDashboard().then(setData)
  }, [])
  
  if (!data) {
    return <DashboardSkeleton />  // shadcn Skeleton components in a grid layout
  }
  
  return <DashboardShell data={data} />
}

// DashboardShell.tsx pseudocode
function DashboardShell({ data }: { data: ReportDashboardResponse }) {
  const [activeTab, setActiveTab] = useState("overview")
  const [dateRange, setDateRange] = useState<DateRangePreset>("30d")
  const [accountTypeFilter, setAccountTypeFilter] = useState<AccountTypeGroup | "All">("All")
  const [countryFilter, setCountryFilter] = useState("All")
  const [campaignFilter, setCampaignFilter] = useState("All")
  const [platformFilter, setPlatformFilter] = useState("All")
  const [riskFilter, setRiskFilter] = useState<RiskLevel | "All">("All")
  const [searchQuery, setSearchQuery] = useState("")

  return (
    <div className="min-h-svh bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-medium">
              HFM Affiliate Report
              <Badge variant="outline" className="ml-3 text-xs">MOCK DATA</Badge>
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Generated from mocked backend contract. No live HFM API calls.
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            {formatDate(data.meta.snapshotDate)}
          </div>
        </div>
      </header>

      <ReportFilters
        dateRange={dateRange} onDateRangeChange={setDateRange}
        accountType={accountTypeFilter} onAccountTypeChange={setAccountTypeFilter}
        country={countryFilter} onCountryChange={setCountryFilter}
        campaign={campaignFilter} onCampaignChange={setCampaignFilter}
        platform={platformFilter} onPlatformChange={setPlatformFilter}
        risk={riskFilter} onRiskChange={setRiskFilter}
        search={searchQuery} onSearchChange={setSearchQuery}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mx-6 mt-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activation">Activation</TabsTrigger>
          <TabsTrigger value="funded-no-trade">Funded No Trade</TabsTrigger>
          <TabsTrigger value="missing-wallets">Missing Wallets</TabsTrigger>
          <TabsTrigger value="segments">Segments</TabsTrigger>
          <TabsTrigger value="data-quality">Data Quality</TabsTrigger>
        </TabsList>

        <div className="px-6 py-4">
          <TabsContent value="overview">
            <ExecutiveOverview summary={data.summary} />
            <Separator className="my-6" />
            <AccountTypeOverview accountTypes={data.accountTypes} />
            <Separator className="my-6" />
            <TrendAnalytics trends={data.trends} />
          </TabsContent>
          <TabsContent value="activation">
            <ActivationFunnel funnel={data.funnel} />
            <Separator className="my-6" />
            <TrendAnalytics trends={data.trends} />
          </TabsContent>
          <TabsContent value="funded-no-trade">
            <FundedNoTradeTable
              accounts={data.fundedNoTrade}
              searchQuery={searchQuery}
              accountTypeFilter={accountTypeFilter}
              riskFilter={riskFilter}
            />
          </TabsContent>
          <TabsContent value="missing-wallets">
            <MissingWalletsTable
              wallets={data.missingWallets}
              searchQuery={searchQuery}
              riskFilter={riskFilter}
            />
          </TabsContent>
          <TabsContent value="segments">
            <SegmentQuality segments={data.segments} />
          </TabsContent>
          <TabsContent value="data-quality">
            <DataQualityPanel dataQuality={data.dataQuality} meta={data.meta} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
```

### Style Conventions to Follow Throughout

```typescript
// IMPORT CONVENTIONS
// @/ alias for all src imports
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
// type-only imports (required by verbatimModuleSyntax)
import type { ReportDashboardResponse } from "@/types/report"

// COMPONENT CONVENTIONS
// Named exports preferred (function declaration)
export function KpiCard({ title, metric }: { title: string; metric: MetricDelta }) { ... }
// Use React.ComponentProps for extending native props
// Follow Button.tsx pattern for CVA-based components

// TAILWIND CONVENTIONS
// Use theme tokens: bg-background, text-foreground, border-border, bg-card, text-muted-foreground
// Use chart tokens: text-[var(--chart-1)], bg-[var(--chart-1)]
// No rounded classes (radius: 0 is the default)
// Spacing: use consistent gap/margin (gap-4, gap-6, my-4, my-6, p-4, p-6)

// THEME SUPPORT
// Dark mode works automatically via CSS variables and .dark class
// Test by pressing 'd' key (ThemeProvider shortcut)

// FORMATTING
// Use formatters.ts functions, never inline Intl.NumberFormat or toLocaleString
// Use cn() for all conditional Tailwind classes
// Follow prettier config: no semicolons, double quotes, trailing commas
```

## Validation Gates

Run in `apps/web-report` directory after each phase:

### Level 1: Type Check
```bash
bun run typecheck
```
Expected: No TypeScript errors. If errors exist, read each one, understand the root cause, and fix in the source file. Never use `@ts-ignore` or `as any` to suppress errors.

### Level 2: Lint
```bash
bun run lint
```
Expected: No ESLint errors. Warnings are acceptable but should be minimized. If `eslint-plugin-react-refresh` warns about export patterns in non-component files, that's expected for utility/data modules.

### Level 3: Build
```bash
bun run build
```
Expected: `tsc -b && vite build` completes successfully. Build errors indicate type issues missed by `tsc --noEmit` (since build does project references differently).

### Level 4: Format (after all changes)
```bash
bun run format
```
Expected: Prettier formats files in-place. Review any unexpected formatting changes.

### Level 5: Dev Server Smoke Test (manual)
```bash
bun run dev
```
Open http://localhost:5173 and verify:
- Dashboard loads with all sections
- "MOCK DATA" badge visible
- Tabs switch between sections
- Light/dark mode toggle works (press 'd')
- Filters/search work on tables
- At least one chart renders
- KPI cards show values with deltas

### Post-Implementation Checklist
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes (warnings acceptable)
- [ ] `bun run build` succeeds
- [ ] No backend files modified (verify with `git diff --name-only apps/api/`)
- [ ] No real HTTP calls in network tab
- [ ] Mock data is deterministic (refresh page → same values)
- [ ] Mock data disclosure visible
- [ ] Dark mode functional
- [ ] Mobile layout usable (viewport < 640px)
- [ ] Charts render without height issues

## Anti-Patterns (DO NOT DO)

- [ ] Don't create new utility functions when formatters.ts already has them
- [ ] Don't add @ts-ignore or as any — fix the actual type issue
- [ ] Don't create a tailwind.config.js — Tailwind v4 doesn't use it
- [ ] Don't add rounded styles (rounded-lg, rounded-xl, etc.) — radius: 0 is the design system
- [ ] Don't import React — use named imports from "react" (React 19 + JSX transform)
- [ ] Don't add routing (react-router) — single page is sufficient
- [ ] Don't add Redux/Zustand — plain useState is the pattern for this demo
- [ ] Don't modify main.tsx, theme-provider.tsx, or index.css theme tokens
- [ ] Don't make real HTTP calls — all data comes from mock service
- [ ] Don't use default exports (prefer named exports per project convention)
- [ ] Don't deviate from the existing component patterns (see button.tsx for CVA + cn usage)
- [ ] Don't add i18n, generic dashboard builders, or features not in the spec
- [ ] Don't use Math.random() in render or component body — mock data is static

---

## PRP Confidence Score: 8/10

**Strengths:**
- Complete type definitions ready to copy-paste
- Clear component hierarchy and data flow
- All shadcn gotchas documented (ChartContainer height, Tailwind v4, verbatimModuleSyntax, radius:0)
- Mock data contract fully specified with minimum volumes
- Executable validation gates at each level
- Pseudocode for the shell component shows exact integration pattern

**Risk areas (why not 10/10):**
- shadcn chart Recharts integration — the exact generated chart component code varies by shadcn version; the AI may need to adjust imports/patterns slightly
- Tailwind v4 + shadcn compatibility — some shadcn components may generate with v3 patterns; AI must adapt
- Chart rendering — the Recharts `ChartContainer` wrapping pattern is error-prone without visual verification
- Mock data generation — generating 30+ realistic trend points with consistent math requires attention to detail
