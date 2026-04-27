import { logError } from "../utils/logger";
import type {
  ConditionCheck,
  HFMApiResult,
  HFMAllClientsResult,
  HFMClientsPerformanceResponse,
  HFMPerformanceData,
} from "../types/hfm.types";

export function extractWalletNumber(walletId: string): number | null {
  const numericPart = walletId.replace(/^WL-/i, "");
  const num = Number(numericPart);
  return Number.isNaN(num) ? null : num;
}

export function checkConditions(
  data: HFMPerformanceData,
  walletId: string
): ConditionCheck {
  const targetWallet = Number(process.env.TARGET_WALLET);
  const walletNum = extractWalletNumber(walletId);
  const underTargetWallet =
    !Number.isNaN(targetWallet) && walletNum === targetWallet;

  const depositThreshold = data.account_currency === "USC" ? 200_00 : 200;
  const depositThresholdMet = data.deposits >= depositThreshold;

  const matchAll = underTargetWallet && depositThresholdMet;

  return { underTargetWallet, depositThresholdMet, matchAll };
}

export async function fetchPerformance(
  walletId: string
): Promise<HFMApiResult> {
  const walletNum = extractWalletNumber(walletId);
  if (walletNum === null) {
    return { ok: false, reason: "not_found" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
    const url = `${baseUrl}/api/performance/client-performance?wallets=${walletNum}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
    });

    if (res.status === 404) {
      logError("hfm-service", `Wallet not found: ${walletNum} (status 404)`);
      return { ok: false, reason: "not_found" };
    }
    if (res.status >= 500) {
      logError("hfm-service", `HFM server error (status ${res.status})`);
      return { ok: false, reason: "server_error" };
    }
    if (res.status === 401) {
      logError("hfm-service", `HFM auth failed (status 401)`);
      return { ok: false, reason: "server_error" };
    }
    if (res.status !== 200) {
      logError("hfm-service", `HFM unexpected status ${res.status}`);
      return { ok: false, reason: "server_error" };
    }

    const body = (await res.json()) as HFMClientsPerformanceResponse;
    const clients = body?.clients;
    if (!Array.isArray(clients) || clients.length === 0) {
      return { ok: false, reason: "not_found" };
    }

    const data: HFMPerformanceData[] = clients.filter(c => !c.archived);
    if (data.length === 0 || data[0]!.client_id == null) {
      return { ok: false, reason: "not_found" };
    }

    return { ok: true, data };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      logError("hfm-service", `Request timeout for wallet ${walletNum}`);
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAllClients(timeoutMs = 10_000): Promise<HFMAllClientsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
    const url = `${baseUrl}/api/performance/client-performance`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
    });

    if (res.status !== 200) {
      logError("hfm-service", `fetchAllClients unexpected status ${res.status}`);
      return { ok: false, reason: "server_error" };
    }

    const body = (await res.json()) as HFMClientsPerformanceResponse;
    if (!Array.isArray(body.clients) || body.totals == null) {
      return { ok: false, reason: "server_error" };
    }

    return { ok: true, data: body };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      logError("hfm-service", "fetchAllClients request timeout");
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}
