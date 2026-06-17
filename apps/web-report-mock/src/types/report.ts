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
