import type { HFMPerformanceData, ConditionCheck, MonthlyActivity } from "../types/hfm.types";
import { dayjs } from "../utils/dayjs";
import { logger } from "../utils/logger";

const fmtCurrency = (n: number, currency: string): string => {
  if (currency === "USC") {
    return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USC`;
  }
  const displayCurrency = ["USD", "THB"].includes(currency) ? currency : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: displayCurrency,
  }).format(n);
};

const fmtVolume = (n: number): string => `${n.toFixed(2)} lots`;

// Rank tiers are cut on cumulative all-time lots (HFM `volume`).
// Boundaries are inclusive on the lower bound: 100 lots is Silver, 99.99 is Bronze.
export function getRankTier(cumulativeLots: number): string {
  const lots = Number.isFinite(cumulativeLots) ? cumulativeLots : 0;
  if (lots >= 4000) return "\u{1F451} Diamond";
  if (lots >= 1000) return "\u{1F48E} Platinum";
  if (lots >= 500) return "\u{1F947} Gold";
  if (lots >= 100) return "\u{1F948} Silver";
  return "\u{1F949} Bronze";
}

export type FlexSummaryVersion = "flex-v1" | "flex-v2";

// Read per call, not at module load: Bun caches the module, so a load-time
// read could not be flipped by tests that re-import this builder.
let warnedFlexVersion: string | null = null;

export function resetFlexVersionWarning(): void {
  warnedFlexVersion = null;
}

export function getFlexSummaryVersion(): FlexSummaryVersion {
  const raw = (process.env.FLEX_SUMMARY_VERSION ?? "").trim();
  if (raw === "") return "flex-v1";
  if (raw === "flex-v1" || raw === "flex-v2") return raw;
  if (warnedFlexVersion !== raw) {
    warnedFlexVersion = raw;
    logger.warn(
      { context: "flex-version" },
      `Unrecognized FLEX_SUMMARY_VERSION "${raw}", falling back to flex-v1`
    );
  }
  return "flex-v1";
}

const fmtDate = (iso: string): string => {
  return dayjs.utc(iso).format("DD MMM YYYY");
};

const fmtLastTrade = (
  raw: string | null | undefined
): { text: string; color?: string } => {
  if (!raw) {
    return { text: "N/A", color: "#DC2626" };
  }
  return { text: dayjs.utc(raw).format("DD/MM/YYYY HH:mm") };
};

const displayCurrencyLabel = (raw: string): string => raw;

const colors = {
  green: "#1DB954",
  greenSoft: "#EAF7EF",
  greenPale: "#F4FBF7",
  text: "#1A1A1A",
  muted: "#9E9E9E",
  border: "#DDE7DF",
  footer: "#F5F5F5",
  white: "#FFFFFF",
};

const getStatusMeta = (
  status: string
): { label: string; color: string; backgroundColor: string } => {
  const trimmed = status.trim();
  const normalized = trimmed.toLowerCase();
  const isActive = /^active(?:$|[\s_-])/.test(normalized);

  if (isActive) {
    const label = normalized === "active" ? "Active" : trimmed;
    return {
      label: `\u2713 ${label}`,
      color: colors.green,
      backgroundColor: colors.greenSoft,
    };
  }

  return {
    label: trimmed || "Unknown",
    color: colors.muted,
    backgroundColor: "#F3F4F6",
  };
};

const getAccountStatusMeta = (
  status: string
): { label: string; color: string; backgroundColor: string } => {
  const trimmed = status.trim();
  const normalized = trimmed.toLowerCase();
  const isApproved = normalized === "approved";

  if (isApproved) {
    return {
      label: `\u2713 Approved`,
      color: colors.green,
      backgroundColor: colors.greenSoft,
    };
  }

  return {
    label: trimmed || "Unknown",
    color: colors.muted,
    backgroundColor: "#F3F4F6",
  };
};

const getMatchAllMeta = (
  matchAll: boolean
): { label: string; color: string; backgroundColor: string } => {
  if (matchAll) {
    return {
      label: "\u2713 Match All",
      color: colors.green,
      backgroundColor: colors.greenSoft,
    };
  }
  return {
    label: "\u2717 Not Match",
    color: "#DC2626",
    backgroundColor: "#FEF2F2",
  };
};

const getFailedConditionsText = (
  conditions: ConditionCheck
): string[] => {
  const failed: string[] = [];
  if (!conditions.underTargetWallet) {
    failed.push("Wallet does not match target");
  }
  if (!conditions.depositThresholdMet) {
    failed.push("Deposit below threshold");
  }
  return failed;
};

const labelText = (text: string): object => ({
  type: "text",
  text,
  size: "xs",
  color: colors.muted,
  wrap: true,
  maxLines: 1,
});

const valueText = (
  text: string,
  options: { align?: "start" | "end" | "center"; color?: string; size?: string } = {}
): object => ({
  type: "text",
  text,
  size: options.size ?? "sm",
  weight: "bold",
  color: options.color ?? colors.text,
  align: options.align,
  wrap: true,
});

const infoCard = (label: string, value: string): object => ({
  type: "box",
  layout: "vertical",
  flex: 1,
  backgroundColor: colors.greenPale,
  borderColor: colors.border,
  borderWidth: "light",
  cornerRadius: "8px",
  paddingAll: "10px",
  spacing: "xs",
  contents: [labelText(label), valueText(value)],
});

const metricCard = (label: string, value: string): object => ({
  type: "box",
  layout: "vertical",
  flex: 1,
  backgroundColor: colors.greenSoft,
  cornerRadius: "8px",
  paddingAll: "10px",
  spacing: "xs",
  contents: [labelText(label), valueText(value, { size: "md" })],
});

const detailCard = (
  label: string,
  value: string,
  options: { color?: string; backgroundColor?: string } = {}
): object => ({
  type: "box",
  layout: "vertical",
  backgroundColor: options.backgroundColor ?? colors.greenPale,
  borderColor: colors.border,
  borderWidth: "light",
  cornerRadius: "8px",
  paddingAll: "10px",
  spacing: "xs",
  contents: [labelText(label), valueText(value, { color: options.color })],
});

const keyValueRow = (label: string, value: string): object => ({
  type: "box",
  layout: "horizontal",
  spacing: "md",
  contents: [
    {
      ...labelText(label),
      flex: 4,
    },
    {
      ...valueText(value, { align: "end" }),
      flex: 3,
    },
  ],
});

export interface TradingCardOptions {
  showVolume?: boolean;
  /** Current-calendar-month activity for this account. v2 only. */
  monthly?: MonthlyActivity;
}

// Frozen: the flex-v1 card. Do not change its output JSON - it is snapshot
// locked in tests/flex-message.builder.test.ts.
export function buildTradingCardV1(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: TradingCardOptions = {}
): object {
  const status = getStatusMeta(data.activity_status);
  const accountStatus = getAccountStatusMeta(data.status);
  const matchAllBadge = getMatchAllMeta(conditions.matchAll);
  const walletIdValue = String(data.client_id);
  const accountIdValue = String(data.account_id);
  const lastTrade = fmtLastTrade(data.last_trade);

  // The Volume metric only renders when the lookup opted in via the "lot"
  // input prefix; without it the Trades card spans the row alone.
  const tradeMetricContents: object[] = [
    metricCard("Trades", String(data.trades)),
  ];
  if (options.showVolume) {
    tradeMetricContents.push(metricCard("Volume", fmtVolume(data.volume)));
  }

  return {
    type: "bubble",
    size: "mega",
    styles: {
      header: { backgroundColor: colors.green },
      footer: { backgroundColor: colors.footer },
    },
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "xs",
      contents: [
        {
          type: "text",
          text: "Trading Account Summary",
          color: colors.white,
          weight: "bold",
          size: "md",
          wrap: true,
          maxLines: 2,
          adjustMode: "shrink-to-fit",
        },
        {
          type: "text",
          text: "Customer Support",
          color: "#E8F5E9",
          size: "xs",
          wrap: true,
          maxLines: 1,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "14px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            infoCard("Wallet ID", walletIdValue),
            infoCard("Trading Account ID", accountIdValue),
          ],
        },
        detailCard("Registration Date", fmtDate(data.account_regdate)),
        detailCard("Account Status", accountStatus.label, {
          color: accountStatus.color,
          backgroundColor: accountStatus.backgroundColor,
        }),
        detailCard("Subaffiliate", String(data.subaffiliate)),
        detailCard("Registration", status.label, {
          color: status.color,
          backgroundColor: status.backgroundColor,
        }),
        { type: "separator", color: colors.border },
        detailCard("Condition", matchAllBadge.label, {
          color: matchAllBadge.color,
          backgroundColor: matchAllBadge.backgroundColor,
        }),
        ...(!conditions.matchAll
          ? [
            {
              type: "box",
              layout: "vertical" as const,
              spacing: "xs" as const,
              backgroundColor: "#FEF2F2",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: getFailedConditionsText(conditions).map((msg) => ({
                type: "text",
                text: `\u2022 ${msg}`,
                size: "xs",
                color: "#DC2626",
                wrap: true,
              })),
            } as object,
          ]
          : []),
        { type: "separator", color: colors.border },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: tradeMetricContents,
        },
        detailCard("Last Trade", lastTrade.text, { color: lastTrade.color }),
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            metricCard(
              "Balance",
              fmtCurrency(data.balance, data.account_currency)
            ),
            metricCard(
              "Equity",
              fmtCurrency(data.equity, data.account_currency)
            ),
          ],
        },
        detailCard("Account Type", data.account_type),
        keyValueRow(
          "Account Currency",
          displayCurrencyLabel(data.account_currency)
        ),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: "For assistance, please contact support.",
          size: "xs",
          color: colors.muted,
          align: "center",
          wrap: true,
        },
      ],
    },
  };
}

const MONTHLY_LOT_TARGET = 2;

const getMonthlyStatusMeta = (
  monthly: MonthlyActivity | undefined
): { label: string; color: string; backgroundColor: string } => {
  if (!monthly) {
    return { label: "N/A", color: colors.muted, backgroundColor: "#F3F4F6" };
  }
  if (monthly.hasTrade) {
    return {
      label: "\u2713 Active",
      color: colors.green,
      backgroundColor: colors.greenSoft,
    };
  }
  return {
    label: "\u2717 Inactive",
    color: "#DC2626",
    backgroundColor: "#FEF2F2",
  };
};

const getMonthlyLotsMeta = (
  monthly: MonthlyActivity | undefined
): { label: string; color: string; backgroundColor: string } => {
  if (!monthly) {
    return { label: "N/A", color: colors.muted, backgroundColor: "#F3F4F6" };
  }
  const lots = Number.isFinite(monthly.lots) ? monthly.lots : 0;
  const passed = lots >= MONTHLY_LOT_TARGET;
  return {
    label: `${passed ? "\u2713" : "\u2717"} ${lots.toFixed(2)} / ${MONTHLY_LOT_TARGET} lots`,
    color: passed ? colors.green : "#DC2626",
    backgroundColor: passed ? colors.greenSoft : "#FEF2F2",
  };
};

// flex-v2: same fields and order as v1, except the cumulative Volume metric is
// replaced by monthly status + monthly 2-lot progress, and a Rank row is added.
// Cumulative lots are never printed - they only decide the rank label.
export function buildTradingCardV2(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: TradingCardOptions = {}
): object {
  const status = getStatusMeta(data.activity_status);
  const accountStatus = getAccountStatusMeta(data.status);
  const matchAllBadge = getMatchAllMeta(conditions.matchAll);
  const walletIdValue = String(data.client_id);
  const accountIdValue = String(data.account_id);
  const lastTrade = fmtLastTrade(data.last_trade);
  const monthlyStatus = getMonthlyStatusMeta(options.monthly);
  const monthlyLots = getMonthlyLotsMeta(options.monthly);

  return {
    type: "bubble",
    size: "mega",
    styles: {
      header: { backgroundColor: colors.green },
      footer: { backgroundColor: colors.footer },
    },
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "xs",
      contents: [
        {
          type: "text",
          text: "Trading Account Summary",
          color: colors.white,
          weight: "bold",
          size: "md",
          wrap: true,
          maxLines: 2,
          adjustMode: "shrink-to-fit",
        },
        {
          type: "text",
          text: "Customer Support",
          color: "#E8F5E9",
          size: "xs",
          wrap: true,
          maxLines: 1,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "14px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            infoCard("Wallet ID", walletIdValue),
            infoCard("Trading Account ID", accountIdValue),
          ],
        },
        detailCard("Registration Date", fmtDate(data.account_regdate)),
        detailCard("Account Status", accountStatus.label, {
          color: accountStatus.color,
          backgroundColor: accountStatus.backgroundColor,
        }),
        detailCard("Subaffiliate", String(data.subaffiliate)),
        detailCard("Registration", status.label, {
          color: status.color,
          backgroundColor: status.backgroundColor,
        }),
        { type: "separator", color: colors.border },
        detailCard("Condition", matchAllBadge.label, {
          color: matchAllBadge.color,
          backgroundColor: matchAllBadge.backgroundColor,
        }),
        ...(!conditions.matchAll
          ? [
            {
              type: "box",
              layout: "vertical" as const,
              spacing: "xs" as const,
              backgroundColor: "#FEF2F2",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: getFailedConditionsText(conditions).map((msg) => ({
                type: "text",
                text: `\u2022 ${msg}`,
                size: "xs",
                color: "#DC2626",
                wrap: true,
              })),
            } as object,
          ]
          : []),
        { type: "separator", color: colors.border },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [metricCard("Trades", String(data.trades))],
        },
        detailCard("This Month", monthlyStatus.label, {
          color: monthlyStatus.color,
          backgroundColor: monthlyStatus.backgroundColor,
        }),
        detailCard("Monthly Lots", monthlyLots.label, {
          color: monthlyLots.color,
          backgroundColor: monthlyLots.backgroundColor,
        }),
        detailCard("Rank", getRankTier(data.volume)),
        detailCard("Last Trade", lastTrade.text, { color: lastTrade.color }),
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            metricCard(
              "Balance",
              fmtCurrency(data.balance, data.account_currency)
            ),
            metricCard(
              "Equity",
              fmtCurrency(data.equity, data.account_currency)
            ),
          ],
        },
        detailCard("Account Type", data.account_type),
        keyValueRow(
          "Account Currency",
          displayCurrencyLabel(data.account_currency)
        ),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: "For assistance, please contact support.",
          size: "xs",
          color: colors.muted,
          align: "center",
          wrap: true,
        },
      ],
    },
  };
}

// Single switch point for the card version. Reads the env flag per call.
export function buildTradingCard(
  data: HFMPerformanceData,
  conditions: ConditionCheck,
  options: TradingCardOptions = {}
): object {
  return getFlexSummaryVersion() === "flex-v2"
    ? buildTradingCardV2(data, conditions, options)
    : buildTradingCardV1(data, conditions, options);
}

export function buildPaginationCard(
  lookup: { kind: "wallet" | "account"; id: number; showVolume?: boolean },
  currentPage: number,
  totalPages: number,
  totalItems: number
): object {
  const contents: any[] = [
    {
      type: "text",
      text: `Page ${currentPage} of ${totalPages}`,
      weight: "bold",
      size: "md",
      align: "center",
      color: colors.text,
    },
    {
      type: "text",
      text: `Total ${totalItems} Accounts`,
      size: "xs",
      align: "center",
      color: colors.muted,
      margin: "xs",
    },
  ];

  const buttons: any[] = [];

  if (currentPage < totalPages) {
    buttons.push({
      type: "button",
      action: {
        type: "postback",
        label: "Next Page ➔",
        data: `action=page&kind=${lookup.kind}&id=${lookup.id}&page=${currentPage + 1}${
          lookup.showVolume ? "&vol=1" : ""
        }`,
      },
      style: "primary",
      color: colors.green,
      height: "sm",
      margin: "md",
    });
  }

  if (currentPage > 1) {
    buttons.push({
      type: "button",
      action: {
        type: "postback",
        label: "🠔 Previous Page",
        data: `action=page&kind=${lookup.kind}&id=${lookup.id}&page=${currentPage - 1}${
          lookup.showVolume ? "&vol=1" : ""
        }`,
      },
      style: "secondary",
      height: "sm",
      margin: "sm",
    });
  }

  if (buttons.length > 0) {
    contents.push({
      type: "box",
      layout: "vertical",
      spacing: "sm",
      margin: "lg",
      contents: buttons,
    });
  }

  return {
    type: "bubble",
    size: "mega",
    styles: {
      header: { backgroundColor: colors.green },
      footer: { backgroundColor: colors.footer },
    },
    header: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      contents: [
        {
          type: "text",
          text: "Page Navigation",
          color: colors.white,
          weight: "bold",
          size: "md",
          align: "center",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      contents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: "Select a page to view more accounts",
          size: "xs",
          color: colors.muted,
          align: "center",
          wrap: true,
        },
      ],
    },
  };
}

