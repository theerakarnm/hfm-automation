import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { RiskLevel } from "@/types/report"

const riskConfig: Record<RiskLevel, { className: string }> = {
  High: {
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
  Medium: {
    className:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  Low: {
    className: "bg-secondary text-secondary-foreground",
  },
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs font-medium", riskConfig[level].className)}
    >
      {level}
    </Badge>
  )
}
