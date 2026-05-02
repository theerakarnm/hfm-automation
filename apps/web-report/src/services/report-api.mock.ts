import type { ReportDashboardResponse } from "@/types/report"
import { reportDashboardMock } from "@/data/report.mock"

export async function getReportDashboard(): Promise<ReportDashboardResponse> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  return reportDashboardMock
}
