import { useState, useEffect } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { DashboardShell } from "@/components/report/dashboard-shell"
import { getReportDashboard } from "@/services/report-api.mock"
import type { ReportDashboardResponse } from "@/types/report"

function DashboardSkeleton() {
  return (
    <div className="min-h-svh bg-background p-6">
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-24" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2 border border-border p-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function App() {
  const [data, setData] = useState<ReportDashboardResponse | null>(null)

  useEffect(() => {
    getReportDashboard().then(setData)
  }, [])

  if (!data) {
    return <DashboardSkeleton />
  }

  return <DashboardShell data={data} />
}

export default App
