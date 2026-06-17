import { KpiCard } from "@/components/report/kpi-card"
import type { ExecutiveSummary } from "@/types/report"
import { formatDate } from "@/lib/formatters"

export function ExecutiveOverview({ summary }: { summary: ExecutiveSummary }) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Executive Overview
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Current Wallets" metric={summary.currentWallets} />
        <KpiCard title="Missing Wallets" metric={summary.missingWallets} />
        <KpiCard title="Total Accounts" metric={summary.totalAccounts} />
        <KpiCard title="Funded No Trade" metric={summary.fundedNoTrade} />
        <KpiCard title="Net Deposit" metric={summary.netDeposit} />
        <KpiCard
          title="Active Trading"
          metric={summary.activeTradingAccounts}
        />
        <KpiCard
          title="Wallet/Account Ratio"
          metric={summary.walletToAccountRatio}
        />
      </div>
      <div className="text-xs text-muted-foreground">
        Last sync: {formatDate(summary.dataFreshness.lastSync.split("T")[0])}
      </div>
    </div>
  )
}
