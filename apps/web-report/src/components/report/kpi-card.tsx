import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatNumber, formatCurrency, formatPercent } from "@/lib/formatters"
import { MetricDeltaDisplay } from "@/components/report/metric-delta"
import type { MetricDelta } from "@/types/report"

function formatMetricValue(
  value: number,
  format: MetricDelta["format"]
): string {
  switch (format) {
    case "currency":
      return formatCurrency(value)
    case "percent":
      return formatPercent(value)
    case "ratio":
      return value.toFixed(2)
    case "number":
    default:
      return formatNumber(value)
  }
}

export function KpiCard({
  title,
  metric,
  className,
}: {
  title: string
  metric: MetricDelta
  className?: string
}) {
  return (
    <Card className={cn("min-w-0 gap-0 py-3", className)}>
      <CardHeader className="px-3 pt-0 pb-1">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 px-3 pb-0">
        <div className="text-xl font-semibold break-words tabular-nums">
          {formatMetricValue(metric.value, metric.format)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <MetricDeltaDisplay
            delta={metric.delta}
            direction={metric.direction}
            format={metric.format}
          />
          <span className="text-xs text-muted-foreground">
            vs prev {formatMetricValue(metric.previousValue, metric.format)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
