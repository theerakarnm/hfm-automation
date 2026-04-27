export interface HFMPerformanceData {
  client_id: number;
  account_id: number;
  client_registration?: string;
  activity_status: string;
  trades: number;
  volume: number;
  account_type: string;
  deposits: number;
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
    deposits: number | string;
    withdrawals: number | string;
    commission: number | string;
  };
}

export type HFMApiResult =
  | { ok: true; data: HFMPerformanceData[] }
  | { ok: false; reason: "not_found" | "server_error" | "timeout" };

export type HFMAllClientsResult =
  | { ok: true; data: HFMClientsPerformanceResponse }
  | { ok: false; reason: "server_error" | "timeout" };
