const numberFormatter = new Intl.NumberFormat("en-US")
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return numberFormatter.format(value)
  return numberFormatter.format(value)
}

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value)
}

export function formatPercent(value: number): string {
  return `${numberFormatter.format(value)}%`
}

export function formatCompact(value: number): string {
  return compactFormatter.format(value)
}

export function formatDate(value: string): string {
  const date = new Date(value + "T00:00:00")
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

import type { MetricFormat } from "@/types/report"

export function formatDelta(value: number, format: MetricFormat): string {
  const sign = value > 0 ? "+" : value < 0 ? "" : ""
  switch (format) {
    case "currency":
      return `${sign}${formatCurrency(value)}`
    case "percent":
      return `${sign}${formatPercent(value)}`
    case "ratio":
      return `${sign}${value.toFixed(2)}`
    case "number":
    default:
      return `${sign}${formatNumber(value)}`
  }
}
