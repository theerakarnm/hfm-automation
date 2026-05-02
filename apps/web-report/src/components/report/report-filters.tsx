import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type {
  DateRangePreset,
  AccountTypeGroup,
  RiskLevel,
} from "@/types/report"

const datePresets: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "mtd", label: "MTD" },
]

const accountTypes: (AccountTypeGroup | "All")[] = [
  "All",
  "Pro",
  "Zero",
  "Bonus",
  "Premium",
  "Other",
]

const riskLevels: (RiskLevel | "All")[] = ["All", "High", "Medium", "Low"]

const countries = [
  "All",
  "Thailand",
  "Vietnam",
  "Malaysia",
  "Indonesia",
  "Philippines",
]
const campaigns = [
  "All",
  "Thailand_Bonus_Q2",
  "Line_Lead_Form",
  "Partner_Webinar",
  "Organic_App",
  "Premium_LP",
  "Social_Retarget",
]
const platforms = ["All", "MT4", "MT5"]

export function ReportFilters({
  dateRange,
  onDateRangeChange,
  accountType,
  onAccountTypeChange,
  country,
  onCountryChange,
  campaign,
  onCampaignChange,
  platform,
  onPlatformChange,
  risk,
  onRiskChange,
  search,
  onSearchChange,
}: {
  dateRange: DateRangePreset
  onDateRangeChange: (v: DateRangePreset) => void
  accountType: AccountTypeGroup | "All"
  onAccountTypeChange: (v: AccountTypeGroup | "All") => void
  country: string
  onCountryChange: (v: string) => void
  campaign: string
  onCampaignChange: (v: string) => void
  platform: string
  onPlatformChange: (v: string) => void
  risk: RiskLevel | "All"
  onRiskChange: (v: RiskLevel | "All") => void
  search: string
  onSearchChange: (v: string) => void
}) {
  return (
    <div className="space-y-3 border-b border-border px-6 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {datePresets.map((p) => (
            <button
              key={p.value}
              onClick={() => onDateRangeChange(p.value)}
              className={cn(
                "border border-border px-2 py-1 text-xs transition-colors",
                dateRange === p.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-foreground hover:bg-muted"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Separator orientation="vertical" className="h-6" />

        <Select
          value={accountType}
          onValueChange={(v) =>
            onAccountTypeChange(v as AccountTypeGroup | "All")
          }
        >
          <SelectTrigger className="h-7 w-[120px] text-xs">
            <SelectValue placeholder="Account Type" />
          </SelectTrigger>
          <SelectContent>
            {accountTypes.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={country} onValueChange={onCountryChange}>
          <SelectTrigger className="h-7 w-[120px] text-xs">
            <SelectValue placeholder="Country" />
          </SelectTrigger>
          <SelectContent>
            {countries.map((c) => (
              <SelectItem key={c} value={c} className="text-xs">
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={campaign} onValueChange={onCampaignChange}>
          <SelectTrigger className="h-7 w-[140px] text-xs">
            <SelectValue placeholder="Campaign" />
          </SelectTrigger>
          <SelectContent>
            {campaigns.map((c) => (
              <SelectItem key={c} value={c} className="text-xs">
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={platform} onValueChange={onPlatformChange}>
          <SelectTrigger className="h-7 w-[90px] text-xs">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            {platforms.map((p) => (
              <SelectItem key={p} value={p} className="text-xs">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={risk}
          onValueChange={(v) => onRiskChange(v as RiskLevel | "All")}
        >
          <SelectTrigger className="h-7 w-[90px] text-xs">
            <SelectValue placeholder="Risk" />
          </SelectTrigger>
          <SelectContent>
            {riskLevels.map((r) => (
              <SelectItem key={r} value={r} className="text-xs">
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Input
        placeholder="Search wallet ID, account ID, country, campaign..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-7 max-w-sm text-xs"
      />
    </div>
  )
}
