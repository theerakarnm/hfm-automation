import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { formatNumber, formatCurrency, formatPercent } from "@/lib/formatters"
import type { AccountTypeSummary } from "@/types/report"

export function AccountTypeOverview({
  accountTypes,
}: {
  accountTypes: AccountTypeSummary[]
}) {
  const totalAccounts = accountTypes.reduce((s, a) => s + a.accounts, 0)

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Account Type Overview
      </h2>
      <div className="flex flex-wrap gap-3">
        {accountTypes.map((at) => (
          <Card key={at.type} className="gap-0 py-2">
            <CardHeader className="px-3 pt-0 pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {at.type}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-0">
              <div className="text-lg font-semibold tabular-nums">
                {formatNumber(at.accounts)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="space-y-1">
        {accountTypes.map((at) => (
          <div key={at.type} className="flex items-center gap-2">
            <Badge variant="outline" className="w-20 justify-center text-xs">
              {at.type}
            </Badge>
            <div className="flex-1">
              <div
                className="h-4 bg-[var(--chart-1)]"
                style={{
                  width: `${(at.accounts / totalAccounts) * 100}%`,
                  minWidth: "2px",
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatPercent(
                Math.round((at.accounts / totalAccounts) * 10000) / 100
              )}
            </span>
          </div>
        ))}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Accounts</TableHead>
            <TableHead className="text-right">Active</TableHead>
            <TableHead className="text-right">FnT</TableHead>
            <TableHead className="text-right">Deposits</TableHead>
            <TableHead className="text-right">Volume</TableHead>
            <TableHead className="text-right">Active Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accountTypes.map((at) => (
            <TableRow key={at.type}>
              <TableCell className="font-medium">{at.type}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(at.accounts)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(at.activeAccounts)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(at.fundedNoTrade)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(at.deposits)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCompact(at.volume)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(at.activeRate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}
