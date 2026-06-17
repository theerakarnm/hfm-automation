import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { FunnelStage } from "@/types/report"
import { formatNumber, formatPercent } from "@/lib/formatters"

export function ActivationFunnel({ funnel }: { funnel: FunnelStage[] }) {
  const maxCount = Math.max(...funnel.map((s) => s.count))

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Activation Funnel
      </h2>
      <div className="space-y-3">
        {funnel.map((stage, i) => {
          const widthPercent = (stage.count / maxCount) * 100
          const dropOff =
            i > 0 && funnel[i - 1].count > 0
              ? ((funnel[i - 1].count - stage.count) / funnel[i - 1].count) *
                100
              : 0

          return (
            <div key={stage.stage} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{stage.stage}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatNumber(stage.count)}
                </span>
              </div>
              <div className="relative h-6 bg-muted" style={{ width: "100%" }}>
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 flex items-center bg-[var(--chart-1)]",
                    i === 0 && "bg-[var(--chart-1)]",
                    i === 1 && "bg-[var(--chart-2)]",
                    i === 2 && "bg-[var(--chart-3)]",
                    i === 3 && "bg-[var(--chart-4)]",
                    i === 4 && "bg-[var(--chart-5)]"
                  )}
                  style={{ width: `${widthPercent}%` }}
                >
                  <span className="px-2 text-xs font-medium text-white">
                    {formatNumber(stage.count)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {stage.conversionFromPrevious !== null && (
                  <span>
                    Conversion:{" "}
                    <span className="font-medium text-foreground">
                      {formatPercent(stage.conversionFromPrevious)}
                    </span>
                  </span>
                )}
                {stage.dropOffFromPrevious !== null && (
                  <span
                    className={cn(
                      dropOff > 30 && "text-amber-500",
                      dropOff > 50 && "text-red-500"
                    )}
                  >
                    Drop-off: {formatNumber(stage.dropOffFromPrevious)} (
                    {formatPercent(Math.round(dropOff * 100) / 100)})
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Conversion Rates
        </h3>
        {funnel
          .filter((s) => s.conversionFromPrevious !== null)
          .map((stage) => (
            <div key={stage.stage} className="flex items-center gap-2">
              <span className="w-28 truncate text-xs sm:w-40">
                {stage.stage}
              </span>
              <Progress
                value={stage.conversionFromPrevious ?? 0}
                className="h-2 flex-1"
              />
              <span className="w-14 text-right text-xs tabular-nums">
                {formatPercent(stage.conversionFromPrevious ?? 0)}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}
