export interface HFMPerformanceData {
  client_id: number;
  account_id: number;
  client_registration?: string;
  activity_status: string;
  trades: number;
  volume: number;
  account_type: string;
  deposits?: number;
  withdrawals?: number;
  account_currency: string;
  equity: number;
  archived: boolean | null;
  subaffiliate: number;
  account_regdate: string;
  status: string;
  full_name?: string;
  country?: string;
  platform?: string;
  email?: string;
  campaign?: string;
  commission?: number;
  notional_volume?: number;
  margin?: number;
  free_margin?: number;
  unpaid_rebates?: number;
  paid_rebates?: number;
  rejected_rebates?: number;
  tier?: number;
  balance: number;
}

export interface ConditionCheck {
  underTargetWallet: boolean;
  depositThresholdMet: boolean;
  matchAll: boolean;
}

export interface HFMClientsPerformanceResponse {
  clients: HFMPerformanceData[];
  totals: {
    clients: number | string;
    accounts: number | string;
    volume: number | string;
    balance: number | string;
    withdrawals: number | string;
    commission: number | string;
  };
}

export type HFMApiResult =
  | { ok: true; data: HFMPerformanceData[] }
  | { ok: false; reason: "not_found" | "server_error" | "timeout" | "no_wallet" };

export type HFMAllClientsResult =
  | { ok: true; data: HFMClientsPerformanceResponse }
  | { ok: false; reason: "server_error" | "timeout" };

export interface PerformanceLookup {
  kind: "wallet" | "account";
  id: number;
  label: string;
}

export interface HFMClientRow {
  id: number;
  wallet: number;
  type: string | null;
  last_trade: string | null;
  volume: string | number | null;
  balance: number | string | null;
  commission: number | string | null;
  account_currency: string | null;
  country: string | null;
  rebates_paid: number | string | null;
  rebates_unpaid: number | string | null;
  rebates_rejected: number | string | null;
  first_trade: string | null;
  first_funding: string | null;
  registration: string | null;
  server: number | null;
  platform: string | null;
  conversion_device: string | null;
  deposits: number | string | null;
  withdrawals: number | string | null;
  name: string | null;
  email: string | null;
  equity: number | string | null;
  margin: number | string | null;
  free_margin: number | string | null;
}

export interface HFMClientsResponse {
  data: HFMClientRow[];
}

export type HFMClientsResult =
  | { ok: true; data: HFMClientRow[] }
  | { ok: false; reason: "server_error" | "timeout" };
