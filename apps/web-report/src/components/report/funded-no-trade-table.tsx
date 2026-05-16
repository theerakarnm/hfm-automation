import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { RiskBadge } from "@/components/report/risk-badge"
import { EmptyState } from "@/components/report/empty-state"
import { filterFundedNoTrade } from "@/lib/report-calculations"
import { formatCurrency, formatDate, formatNumber } from "@/lib/formatters"
import type {
  FundedNoTradeAccount,
  AccountTypeGroup,
  RiskLevel,
  SuggestedAction,
} from "@/types/report"

const actionBadge: Record<SuggestedAction, string> = {
  "Call today":
    "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  "Send onboarding guide":
    "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  "Check platform setup":
    "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  Monitor: "bg-secondary text-secondary-foreground",
}

function MobileCard({ a }: { a: FundedNoTradeAccount }) {
  return (
    <div className="space-y-2 border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RiskBadge level={a.priority} />
          <Badge variant="outline" className="text-xs">
            {a.accountType}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {a.platform}
          </Badge>
        </div>
        <Badge
          variant="outline"
          className={`text-xs ${actionBadge[a.suggestedAction]}`}
        >
          {a.suggestedAction}
        </Badge>
      </div>
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Wallet</p>
          <p className="text-sm font-medium tabular-nums">{a.walletId}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Account</p>
          <p className="text-sm font-medium tabular-nums">{a.accountId}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-muted-foreground">Deposit: </span>
          <span className="font-medium tabular-nums">
            {formatCurrency(a.depositAmount)}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Days: </span>
          <span className="font-medium tabular-nums">{a.daysSinceFunding}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Registered: </span>
          <span>{formatDate(a.accountRegistration)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Funded: </span>
          <span>{formatDate(a.firstFunding)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Country: </span>
          <span>{a.country}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Campaign: </span>
          <span>{a.campaign}</span>
        </div>
      </div>
    </div>
  )
}

export function FundedNoTradeTable({
  accounts,
  searchQuery,
  accountTypeFilter,
  riskFilter,
}: {
  accounts: FundedNoTradeAccount[]
  searchQuery: string
  accountTypeFilter: AccountTypeGroup | "All"
  riskFilter: RiskLevel | "All"
}) {
  const filtered = filterFundedNoTrade(accounts, {
    search: searchQuery,
    accountType: accountTypeFilter,
    risk: riskFilter,
  })

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Funded But No Trade Worklist
        <span className="ml-2 text-xs tabular-nums">
          ({formatNumber(filtered.length)} accounts)
        </span>
      </h2>
      {filtered.length === 0 ? (
        <EmptyState
          title="No matching accounts"
          description="Try adjusting your filters or search query."
        />
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {filtered.map((a) => (
              <MobileCard key={a.accountId} a={a} />
            ))}
          </div>
          <ScrollArea className="hidden w-full md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead>Wallet ID</TableHead>
                  <TableHead>Account ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead>First Funding</TableHead>
                  <TableHead className="text-right">Deposit</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow key={a.accountId}>
                    <TableCell>
                      <RiskBadge level={a.priority} />
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {a.walletId}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {a.accountId}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {a.accountType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDate(a.accountRegistration)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDate(a.firstFunding)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(a.depositAmount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.daysSinceFunding}
                    </TableCell>
                    <TableCell className="text-xs">{a.country}</TableCell>
                    <TableCell className="text-xs">{a.campaign}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {a.platform}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-xs ${actionBadge[a.suggestedAction] ?? ""}`}
                      >
                        {a.suggestedAction}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </>
      )}
    </div>
  )
}
