import type { HFMPerformanceData } from "../types/hfm.types";

const fmtCurrency = (n: number, currency: string): string => {
  if (currency === "USC") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(n / 100);
  }
  const displayCurrency = ["USD", "THB"].includes(currency) ? currency : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: displayCurrency,
  }).format(n);
};

const fmtVolume = (n: number): string => `${n.toFixed(2)} lots`;

const displayCurrencyLabel = (raw: string): string =>
  raw === "USC" ? "USD" : raw;

export function buildTradingCard(
  data: HFMPerformanceData,
  walletId: string
): object {
  const isActive = data.activity_status === "active";

  return {
    type: "bubble",
    size: "kilo",
    styles: {
      header: { backgroundColor: "#1DB954" },
      footer: { backgroundColor: "#F5F5F5" },
    },
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: "\uD83D\uDCCA Trading Account Summary",
          color: "#FFFFFF",
          weight: "bold",
          size: "md",
        },
        {
          type: "text",
          text: "Forex Customer Support",
          color: "#E8F5E9",
          size: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      paddingAll: "16px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              contents: [
                {
                  type: "text",
                  text: "\uD83E\uDEAA Wallet ID",
                  size: "xs",
                  color: "#9E9E9E",
                },
                {
                  type: "text",
                  text: walletId,
                  size: "sm",
                  weight: "bold",
                  color: "#1A1A1A",
                },
              ],
            },
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              contents: [
                {
                  type: "text",
                  text: "\uD83D\uDCCB Account ID",
                  size: "xs",
                  color: "#9E9E9E",
                },
                {
                  type: "text",
                  text: String(data.account_id),
                  size: "sm",
                  weight: "bold",
                  color: "#1A1A1A",
                },
              ],
            },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: "\uD83D\uDEE1\uFE0F Registration",
              size: "sm",
              color: "#9E9E9E",
              flex: 3,
            },
            {
              type: "text",
              text: isActive ? "\u2713 Active" : data.activity_status,
              size: "sm",
              color: isActive ? "#1DB954" : "#9E9E9E",
              weight: "bold",
              align: "end",
              flex: 2,
            },
          ],
        },
        { type: "separator" },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              backgroundColor: "#E8F5E9",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: [
                {
                  type: "text",
                  text: "Trades",
                  size: "xs",
                  color: "#9E9E9E",
                  align: "center",
                },
                {
                  type: "text",
                  text: String(data.trades),
                  size: "md",
                  weight: "bold",
                  color: "#1A1A1A",
                  align: "center",
                },
              ],
            },
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              backgroundColor: "#E8F5E9",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: [
                {
                  type: "text",
                  text: "Volume",
                  size: "xs",
                  color: "#9E9E9E",
                  align: "center",
                },
                {
                  type: "text",
                  text: fmtVolume(data.volume),
                  size: "md",
                  weight: "bold",
                  color: "#1A1A1A",
                  align: "center",
                },
              ],
            },
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              backgroundColor: "#E8F5E9",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: [
                {
                  type: "text",
                  text: "Type",
                  size: "xs",
                  color: "#9E9E9E",
                  align: "center",
                },
                {
                  type: "text",
                  text: data.account_type,
                  size: "md",
                  weight: "bold",
                  color: "#1A1A1A",
                  align: "center",
                },
              ],
            },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              backgroundColor: "#E8F5E9",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: [
                {
                  type: "text",
                  text: "Balance",
                  size: "xs",
                  color: "#9E9E9E",
                },
                {
                  type: "text",
                  text: fmtCurrency(data.deposits, data.account_currency),
                  size: "md",
                  weight: "bold",
                  color: "#1A1A1A",
                },
              ],
            },
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              backgroundColor: "#E8F5E9",
              cornerRadius: "8px",
              paddingAll: "10px",
              contents: [
                {
                  type: "text",
                  text: "Equity",
                  size: "xs",
                  color: "#9E9E9E",
                },
                {
                  type: "text",
                  text: fmtCurrency(data.equity, data.account_currency),
                  size: "md",
                  weight: "bold",
                  color: "#1A1A1A",
                },
              ],
            },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: "\uD83D\uDCB5 Acc. Currency",
              size: "sm",
              color: "#9E9E9E",
              flex: 3,
            },
            {
              type: "text",
              text: displayCurrencyLabel(data.account_currency),
              size: "sm",
              weight: "bold",
              color: "#1A1A1A",
              align: "end",
              flex: 2,
            },
          ],
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: "\uD83C\uDFA7 For assistance, please contact support.",
          size: "xs",
          color: "#9E9E9E",
          align: "center",
          wrap: true,
        },
      ],
    },
  };
}
