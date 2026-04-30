import { logError } from "../utils/logger";
import type {
  ConditionCheck,
  HFMApiResult,
  HFMAllClientsResult,
  HFMClientsPerformanceResponse,
  HFMPerformanceData,
  PerformanceLookup,
} from "../types/hfm.types";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export function extractWalletNumber(walletId: string): number | null {
  const numericPart = walletId.replace(/^WL-/i, "");
  const num = Number(numericPart);
  return Number.isNaN(num) ? null : num;
}

export function parsePerformanceLookup(input: string): PerformanceLookup | null {
  const trimmed = input.trim();

  const tPrefixMatch = trimmed.match(/^T(\d+)$/i);
  if (tPrefixMatch) {
    const digits = tPrefixMatch[1]!;
    return { kind: "account", id: Number(digits), label: digits };
  }

  const wlPrefixMatch = trimmed.match(/^WL-(\d+)$/i);
  if (wlPrefixMatch) {
    return { kind: "wallet", id: Number(wlPrefixMatch[1]!), label: `WL-${wlPrefixMatch[1]!}` };
  }

  if (/^\d+$/.test(trimmed)) {
    return { kind: "wallet", id: Number(trimmed), label: trimmed };
  }

  return null;
}

export function checkConditions(
  data: HFMPerformanceData,
): ConditionCheck {
  const targetWallet = Number(process.env.TARGET_WALLET);

  if (!data.subaffiliate) {
    logError("hfm-service", `No subaffiliate found for client ${data.client_id}`);
    return { underTargetWallet: false, depositThresholdMet: false, matchAll: false };
  }

  const walletNum = extractWalletNumber(data.subaffiliate.toString());
  const underTargetWallet =
    !Number.isNaN(targetWallet) && walletNum === targetWallet;

  const depositThreshold = data.account_currency === "USC" ? 200_00 : 200;
  const depositThresholdMet = data.balance >= depositThreshold;

  const matchAll = underTargetWallet && depositThresholdMet;

  return { underTargetWallet, depositThresholdMet, matchAll };
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large: ${contentLength} bytes`);
  }
  return res.json() as Promise<T>;
}

export async function fetchPerformance(
  lookup: PerformanceLookup
): Promise<HFMApiResult> {
  const paramKey = lookup.kind === "wallet" ? "wallets" : "accounts";
  const paramValue = lookup.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
    const url = `${baseUrl}/api/performance/client-performance?${paramKey}=${paramValue}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
    });

    if (res.status === 404) {
      logError("hfm-service", `${lookup.kind} not found: ${lookup.id} (status 404)`);
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

    const body = await readJsonResponse<HFMClientsPerformanceResponse>(res);
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
      logError("hfm-service", `Request timeout for ${lookup.kind} ${lookup.id}`);
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveLinkedAccounts(
  accountId: number
): Promise<HFMApiResult> {
  const accountResult = await fetchPerformance({
    kind: "account",
    id: accountId,
    label: String(accountId),
  });

  if (!accountResult.ok) return accountResult;

  const firstClient = accountResult.data[0]!;
  const walletId = firstClient.client_id;

  if (!walletId || walletId === 0) {
    return { ok: false, reason: "no_wallet" };
  }

  return fetchPerformance({
    kind: "wallet",
    id: walletId,
    label: String(walletId),
  });
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

    const body = await readJsonResponse<HFMClientsPerformanceResponse>(res);
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
