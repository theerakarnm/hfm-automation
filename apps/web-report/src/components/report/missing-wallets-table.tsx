import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RiskBadge } from "@/components/report/risk-badge"
import { EmptyState } from "@/components/report/empty-state"
import { filterMissingWallets } from "@/lib/report-calculations"
import { formatCurrency, formatDate, formatNumber } from "@/lib/formatters"
import type { MissingWallet, RiskLevel } from "@/types/report"

export function MissingWalletsTable({
  wallets,
  searchQuery,
  riskFilter,
}: {
  wallets: MissingWallet[]
  searchQuery: string
  riskFilter: RiskLevel | "All"
}) {
  const filtered = filterMissingWallets(wallets, {
    search: searchQuery,
    risk: riskFilter,
  })

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Missing Wallet Risk Report
        <span className="ml-2 text-xs tabular-nums">
          ({formatNumber(filtered.length)} wallets)
        </span>
      </h2>
      {filtered.length === 0 ? (
        <EmptyState
          title="No matching wallets"
          description="Try adjusting your filters or search query."
        />
      ) : (
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Risk</TableHead>
                <TableHead>Wallet ID</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
                <TableHead className="text-right">Deposit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Reason Hint</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((w) => (
                <TableRow key={w.walletId}>
                  <TableCell>
                    <RiskBadge level={w.risk} />
                  </TableCell>
                  <TableCell className="font-medium tabular-nums">
                    {w.walletId}
                  </TableCell>
                  <TableCell className="text-xs">
                    {formatDate(w.lastSeenDate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {w.lastKnownAccounts}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(w.lastKnownDeposit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(w.lastKnownBalance)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCompact(w.lastKnownVolume)}
                  </TableCell>
                  <TableCell className="text-xs">{w.country}</TableCell>
                  <TableCell className="text-xs">{w.campaign}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {w.reasonHint}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </div>
  )
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}
