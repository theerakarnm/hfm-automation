import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { formatNumber, formatCurrency, formatPercent } from "@/lib/formatters"
import type { ReportSegments, SegmentSummary } from "@/types/report"

function SegmentTable({
  title,
  segments,
}: {
  title: string
  segments: SegmentSummary[]
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Wallets</TableHead>
              <TableHead className="text-right">Accounts</TableHead>
              <TableHead className="text-right">Funded</TableHead>
              <TableHead className="text-right">Active</TableHead>
              <TableHead className="text-right">FnT</TableHead>
              <TableHead className="text-right">Deposits</TableHead>
              <TableHead className="text-right">Volume</TableHead>
              <TableHead className="text-right">Conv. Rate</TableHead>
              <TableHead className="text-right">Quality</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((s) => (
              <TableRow key={s.name}>
                <TableCell className="text-xs font-medium">{s.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.wallets)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.accounts)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.fundedAccounts)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.activeAccounts)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.fundedNoTrade)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(s.deposits)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCompact(s.volume)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatPercent(s.conversionRate)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Progress value={s.qualityScore} className="h-2 w-16" />
                    <span className="text-xs tabular-nums">
                      {s.qualityScore}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function SegmentQuality({ segments }: { segments: ReportSegments }) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Segment Quality
      </h2>
      <SegmentTable title="Campaigns" segments={segments.campaigns} />
      <Separator />
      <SegmentTable title="Countries" segments={segments.countries} />
      <Separator />
      <SegmentTable title="Platforms" segments={segments.platforms} />
    </div>
  )
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}
