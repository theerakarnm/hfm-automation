export interface HFMPerformanceData {
  client_id: number;
  account_id: number;
  activity_status: string;
  trades: number;
  volume: number;
  account_type: string;
  deposits: number;
  account_currency: string;
  equity: number;
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
  | { ok: true; data: HFMPerformanceData }
  | { ok: false; reason: "not_found" | "server_error" | "timeout" };
