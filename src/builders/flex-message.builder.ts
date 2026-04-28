import type { HFMPerformanceData } from "../types/hfm.types";
import type { ConditionCheck } from "../types/hfm.types";

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

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[d.getUTCMonth()] ?? "";
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
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

export function buildTradingCard(
  data: HFMPerformanceData,
  walletId: string,
  conditions: ConditionCheck
): object {
  const status = getStatusMeta(data.activity_status);
  const accountStatus = getAccountStatusMeta(data.status);
  const matchAllBadge = getMatchAllMeta(conditions.matchAll);

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
            infoCard("Wallet ID", walletId),
            infoCard("Account ID", String(data.account_id)),
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
          contents: [
            metricCard("Trades", String(data.trades)),
            metricCard("Volume", fmtVolume(data.volume)),
          ],
        },
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
