import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { ReportFilters } from "@/components/report/report-filters"
import { ExecutiveOverview } from "@/components/report/executive-overview"
import { AccountTypeOverview } from "@/components/report/account-type-overview"
import { ActivationFunnel } from "@/components/report/activation-funnel"
import { FundedNoTradeTable } from "@/components/report/funded-no-trade-table"
import { MissingWalletsTable } from "@/components/report/missing-wallets-table"
import { TrendAnalytics } from "@/components/report/trend-analytics"
import { SegmentQuality } from "@/components/report/segment-quality"
import { DataQualityPanel } from "@/components/report/data-quality-panel"
import { formatDate } from "@/lib/formatters"
import type {
  ReportDashboardResponse,
  DateRangePreset,
  AccountTypeGroup,
  RiskLevel,
} from "@/types/report"

export function DashboardShell({ data }: { data: ReportDashboardResponse }) {
  const [activeTab, setActiveTab] = useState("overview")
  const [dateRange, setDateRange] = useState<DateRangePreset>("30d")
  const [accountTypeFilter, setAccountTypeFilter] = useState<
    AccountTypeGroup | "All"
  >("All")
  const [countryFilter, setCountryFilter] = useState("All")
  const [campaignFilter, setCampaignFilter] = useState("All")
  const [platformFilter, setPlatformFilter] = useState("All")
  const [riskFilter, setRiskFilter] = useState<RiskLevel | "All">("All")
  const [searchQuery, setSearchQuery] = useState("")

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-background">
        <header className="border-b border-border px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <h1 className="text-base font-medium sm:text-lg">
                  HFM Affiliate Report
                </h1>
                <Badge
                  variant="outline"
                  className="border-amber-500/20 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400"
                >
                  MOCK DATA
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Generated from mocked backend contract. No live HFM API calls.
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              <Tooltip>
                <TooltipTrigger>
                  Snapshot: {formatDate(data.meta.snapshotDate)}
                </TooltipTrigger>
                <TooltipContent>
                  <p>Previous: {formatDate(data.meta.previousSnapshotDate)}</p>
                  <p>
                    Tracking start: {formatDate(data.meta.trackingStartDate)}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        <ReportFilters
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          accountType={accountTypeFilter}
          onAccountTypeChange={setAccountTypeFilter}
          country={countryFilter}
          onCountryChange={setCountryFilter}
          campaign={campaignFilter}
          onCampaignChange={setCampaignFilter}
          platform={platformFilter}
          onPlatformChange={setPlatformFilter}
          risk={riskFilter}
          onRiskChange={setRiskFilter}
          search={searchQuery}
          onSearchChange={setSearchQuery}
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="overflow-x-auto px-4 sm:mx-6 sm:mt-4 sm:px-0">
            <TabsList className="mt-3 w-max min-w-full sm:mt-4">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activation">Activation</TabsTrigger>
              <TabsTrigger value="funded-no-trade">Funded No Trade</TabsTrigger>
              <TabsTrigger value="missing-wallets">Missing Wallets</TabsTrigger>
              <TabsTrigger value="segments">Segments</TabsTrigger>
              <TabsTrigger value="data-quality">Data Quality</TabsTrigger>
            </TabsList>
          </div>

          <div className="px-4 py-4 sm:px-6">
            <TabsContent value="overview" className="mt-0 space-y-0">
              <ExecutiveOverview summary={data.summary} />
              <Separator className="my-6" />
              <AccountTypeOverview accountTypes={data.accountTypes} />
              <Separator className="my-6" />
              <TrendAnalytics trends={data.trends} />
            </TabsContent>

            <TabsContent value="activation" className="mt-0 space-y-0">
              <ActivationFunnel funnel={data.funnel} />
              <Separator className="my-6" />
              <TrendAnalytics trends={data.trends} />
            </TabsContent>

            <TabsContent value="funded-no-trade" className="mt-0">
              <FundedNoTradeTable
                accounts={data.fundedNoTrade}
                searchQuery={searchQuery}
                accountTypeFilter={accountTypeFilter}
                riskFilter={riskFilter}
              />
            </TabsContent>

            <TabsContent value="missing-wallets" className="mt-0">
              <MissingWalletsTable
                wallets={data.missingWallets}
                searchQuery={searchQuery}
                riskFilter={riskFilter}
              />
            </TabsContent>

            <TabsContent value="segments" className="mt-0">
              <SegmentQuality segments={data.segments} />
            </TabsContent>

            <TabsContent value="data-quality" className="mt-0">
              <DataQualityPanel
                dataQuality={data.dataQuality}
                meta={data.meta}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </TooltipProvider>
  )
}
