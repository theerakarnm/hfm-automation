import type {
  FundedNoTradeAccount,
  AccountTypeGroup,
  RiskLevel,
  MissingWallet,
  SegmentSummary,
} from "@/types/report"

export function filterFundedNoTrade(
  accounts: FundedNoTradeAccount[],
  filters: {
    search: string
    accountType?: AccountTypeGroup | "All"
    risk?: RiskLevel | "All"
  }
): FundedNoTradeAccount[] {
  return accounts.filter((a) => {
    if (
      filters.accountType &&
      filters.accountType !== "All" &&
      a.accountType !== filters.accountType
    )
      return false
    if (filters.risk && filters.risk !== "All" && a.priority !== filters.risk)
      return false
    if (filters.search) {
      const q = filters.search.toLowerCase()
      const haystack = [
        String(a.walletId),
        String(a.accountId),
        a.country,
        a.campaign,
        a.accountType,
      ]
        .join(" ")
        .toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}

export function filterMissingWallets(
  wallets: MissingWallet[],
  filters: { search: string; risk?: RiskLevel | "All" }
): MissingWallet[] {
  return wallets.filter((w) => {
    if (filters.risk && filters.risk !== "All" && w.risk !== filters.risk)
      return false
    if (filters.search) {
      const q = filters.search.toLowerCase()
      const haystack = [String(w.walletId), w.country, w.campaign]
        .join(" ")
        .toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
}

export function filterSegments(
  segments: SegmentSummary[],
  search: string
): SegmentSummary[] {
  if (!search) return segments
  const q = search.toLowerCase()
  return segments.filter((s) => s.name.toLowerCase().includes(q))
}
