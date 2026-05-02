import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { ReportTrends } from "@/types/report"

const walletGrowthConfig = {
  value: { label: "Wallets", color: "var(--chart-1)" },
} satisfies ChartConfig

const accountGrowthConfig = {
  value: { label: "Accounts", color: "var(--chart-2)" },
} satisfies ChartConfig

const fundedNoTradeConfig = {
  value: { label: "Funded No Trade", color: "var(--chart-3)" },
} satisfies ChartConfig

const cashflowConfig = {
  deposits: { label: "Deposits", color: "var(--chart-1)" },
  withdrawals: { label: "Withdrawals", color: "var(--chart-4)" },
} satisfies ChartConfig

const activeAccountsConfig = {
  value: { label: "Active Accounts", color: "var(--chart-5)" },
} satisfies ChartConfig

import type { ReactNode } from "react"

function dateFormatter(value: ReactNode): ReactNode {
  if (typeof value !== "string") return value
  const d = new Date(value + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function tickFormatter(value: unknown): string {
  if (typeof value !== "string") return String(value)
  const d = new Date(value + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function TrendAnalytics({ trends }: { trends: ReportTrends }) {
  return (
    <div className="space-y-6">
      <h2 className="text-sm font-medium text-muted-foreground">
        Trend Analytics (30-Day)
      </h2>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Wallet Growth
          </h3>
          <ChartContainer
            config={walletGrowthConfig}
            className="h-[280px] min-h-[200px] w-full"
          >
            <LineChart data={trends.walletGrowth}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={tickFormatter}
                interval={6}
              />
              <YAxis tickLine={false} axisLine={false} width={50} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={dateFormatter} />}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-value)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Account Growth
          </h3>
          <ChartContainer
            config={accountGrowthConfig}
            className="h-[280px] min-h-[200px] w-full"
          >
            <LineChart data={trends.accountGrowth}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={tickFormatter}
                interval={6}
              />
              <YAxis tickLine={false} axisLine={false} width={50} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={dateFormatter} />}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-value)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Funded No Trade
          </h3>
          <ChartContainer
            config={fundedNoTradeConfig}
            className="h-[280px] min-h-[200px] w-full"
          >
            <AreaChart data={trends.fundedNoTrade}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={tickFormatter}
                interval={6}
              />
              <YAxis tickLine={false} axisLine={false} width={50} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={dateFormatter} />}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-value)"
                fill="var(--color-value)"
                fillOpacity={0.15}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Deposits vs Withdrawals
          </h3>
          <ChartContainer
            config={cashflowConfig}
            className="h-[280px] min-h-[200px] w-full"
          >
            <BarChart data={trends.cashflow}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={tickFormatter}
                interval={6}
              />
              <YAxis tickLine={false} axisLine={false} width={50} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={dateFormatter} />}
              />
              <Bar
                dataKey="deposits"
                fill="var(--color-deposits)"
                radius={[2, 2, 0, 0]}
              />
              <Bar
                dataKey="withdrawals"
                fill="var(--color-withdrawals)"
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Active Accounts
        </h3>
        <ChartContainer
          config={activeAccountsConfig}
          className="h-[280px] min-h-[200px] w-full"
        >
          <LineChart data={trends.activeAccounts}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={tickFormatter}
              interval={6}
            />
            <YAxis tickLine={false} axisLine={false} width={50} />
            <ChartTooltip
              content={<ChartTooltipContent labelFormatter={dateFormatter} />}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--color-value)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      </div>
    </div>
  )
}
