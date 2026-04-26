import type {
  HFMApiResult,
  HFMClientsPerformanceResponse,
  HFMPerformanceData,
} from "../types/hfm.types";

export function extractWalletNumber(walletId: string): number | null {
  const numericPart = walletId.replace(/^WL-/i, "");
  const num = Number(numericPart);
  return Number.isNaN(num) ? null : num;
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

    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status >= 500) return { ok: false, reason: "server_error" };
    if (res.status === 401) return { ok: false, reason: "server_error" };
    if (res.status !== 200) return { ok: false, reason: "server_error" };

    const body = (await res.json()) as HFMClientsPerformanceResponse;
    const clients = body?.clients;
    if (!Array.isArray(clients) || clients.length === 0) {
      return { ok: false, reason: "not_found" };
    }

    const data: HFMPerformanceData = clients[0]!;
    if (data.client_id == null) {
      return { ok: false, reason: "not_found" };
    }

    return { ok: true, data };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}
