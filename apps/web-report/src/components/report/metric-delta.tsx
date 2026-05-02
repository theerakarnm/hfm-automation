import { cn } from "@/lib/utils"
import { formatDelta } from "@/lib/formatters"
import type { MetricFormat, Direction } from "@/types/report"

const directionIcon: Record<Direction, string> = {
  up: "↑",
  down: "↓",
  flat: "→",
}

const directionColor: Record<Direction, string> = {
  up: "text-emerald-500",
  down: "text-red-500",
  flat: "text-muted-foreground",
}

export function MetricDeltaDisplay({
  delta,
  direction,
  format,
}: {
  delta: number
  direction: Direction
  format: MetricFormat
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        directionColor[direction]
      )}
    >
      <span>{directionIcon[direction]}</span>
      <span>{formatDelta(delta, format)}</span>
    </span>
  )
}
