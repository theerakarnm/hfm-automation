import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { formatNumber, formatPercent, formatDate } from "@/lib/formatters"
import type { DataQualitySummary, ReportMeta } from "@/types/report"

const statusConfig = {
  healthy:
    "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  warning:
    "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  error: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
}

export function DataQualityPanel({
  dataQuality,
  meta,
}: {
  dataQuality: DataQualitySummary
  meta: ReportMeta
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Data Quality
        </h2>
        <Badge
          variant="outline"
          className="border-amber-500/20 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400"
        >
          MOCK DATA
        </Badge>
      </div>

      <div className="border border-border p-3 text-xs text-muted-foreground">
        This dashboard displays mocked data for demonstration purposes. No live
        HFM API calls are made. Data structure follows the future backend
        contract defined in ReportDashboardResponse.
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Last Successful Sync</p>
          <p className="text-sm font-medium">
            {formatDate(dataQuality.lastSuccessfulSync.split("T")[0])}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Records Collected</p>
          <p className="text-sm font-medium tabular-nums">
            {formatNumber(dataQuality.recordsCollected)}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Duplicate Rows Ignored
          </p>
          <p className="text-sm font-medium tabular-nums">
            {formatNumber(dataQuality.duplicateRowsIgnored)}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">API Source Status</p>
          <Badge
            variant="outline"
            className={`text-xs ${statusConfig[dataQuality.apiSourceStatus]}`}
          >
            {dataQuality.apiSourceStatus.toUpperCase()}
          </Badge>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Snapshot Completeness</p>
          <span className="text-xs font-medium tabular-nums">
            {formatPercent(dataQuality.snapshotCompleteness)}
          </span>
        </div>
        <Progress value={dataQuality.snapshotCompleteness} className="h-2" />
      </div>

      {dataQuality.unknownAccountTypes.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Unknown Account Types</p>
          <div className="flex gap-2">
            {dataQuality.unknownAccountTypes.map((t) => (
              <Badge key={t} variant="outline" className="text-xs">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <Separator />

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Report Metadata</p>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Snapshot:</span>{" "}
            {formatDate(meta.snapshotDate)}
          </div>
          <div>
            <span className="text-muted-foreground">Previous:</span>{" "}
            {formatDate(meta.previousSnapshotDate)}
          </div>
          <div>
            <span className="text-muted-foreground">Tracking Start:</span>{" "}
            {formatDate(meta.trackingStartDate)}
          </div>
          <div>
            <span className="text-muted-foreground">Timezone:</span>{" "}
            {meta.timezone}
          </div>
        </div>
      </div>
    </div>
  )
}
