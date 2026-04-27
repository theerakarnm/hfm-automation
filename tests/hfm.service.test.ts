import { test, expect, describe, afterEach } from "bun:test";
import { fetchPerformance, extractWalletNumber, checkConditions, fetchAllClients } from "../src/services/hfm.service";
import type { HFMClientsPerformanceResponse } from "../src/types/hfm.types";

const ORIGINAL_FETCH = globalThis.fetch;

const mockHfmResponse: HFMClientsPerformanceResponse = {
  clients: [
    {
      client_id: 45219,
      account_id: 78451293,
      activity_status: "active",
      trades: 24,
      volume: 3.42,
      account_type: "Standard",
      deposits: 12450.8,
      account_currency: "USD",
      equity: 12998.35,
      archived: false,
      subaffiliate: 98241376,
      account_regdate: "2024-01-15T00:00:00Z",
      status: "approved",
    },
  ],
  totals: {
    clients: 1,
    accounts: 1,
    volume: 3.42,
    deposits: 12450.8,
    withdrawals: 0,
    commission: 34.2,
  },
};

function mockFetch(
  status: number,
  body: unknown
): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

describe("extractWalletNumber", () => {
  test("strips WL- prefix and returns number", () => {
    expect(extractWalletNumber("WL-98241376")).toBe(98241376);
  });

  test("returns number directly without WL- prefix", () => {
    expect(extractWalletNumber("12345")).toBe(12345);
  });

  test("returns null for non-numeric input", () => {
    expect(extractWalletNumber("abc")).toBeNull();
  });

  test("case-insensitive WL prefix", () => {
    expect(extractWalletNumber("wl-12345")).toBe(12345);
  });
});

describe("fetchPerformance", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("successful response returns ok true with data array", async () => {
    globalThis.fetch = mockFetch(200, mockHfmResponse);
    const result = await fetchPerformance("WL-98241376");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBe(1);
      expect(result.data[0]!.client_id).toBe(45219);
      expect(result.data[0]!.account_id).toBe(78451293);
      expect(result.data[0]!.trades).toBe(24);
    }
  });

  test("404 response returns not_found", async () => {
    globalThis.fetch = mockFetch(404, { detail: "Not found" });
    const result = await fetchPerformance("WL-00000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  test("500 response returns server_error", async () => {
    globalThis.fetch = mockFetch(500, { detail: "Internal error" });
    const result = await fetchPerformance("WL-98241376");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("server_error");
    }
  });

  test("empty clients array returns not_found", async () => {
    globalThis.fetch = mockFetch(200, { clients: [], totals: {} });
    const result = await fetchPerformance("WL-00000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  test("invalid wallet ID returns not_found", async () => {
    const result = await fetchPerformance("NOT-A-WALLET");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  test("401 response returns server_error", async () => {
    globalThis.fetch = mockFetch(401, { detail: "Unauthorized" });
    const result = await fetchPerformance("WL-98241376");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("server_error");
    }
  });

  test("multiple non-archived clients returned as array", async () => {
    const multiResponse: HFMClientsPerformanceResponse = {
      clients: [
        { ...mockHfmResponse.clients[0]!, client_id: 1, account_id: 100 },
        { ...mockHfmResponse.clients[0]!, client_id: 2, account_id: 200 },
        { ...mockHfmResponse.clients[0]!, client_id: 3, account_id: 300, archived: true },
      ],
      totals: mockHfmResponse.totals,
    };
    globalThis.fetch = mockFetch(200, multiResponse);
    const result = await fetchPerformance("WL-98241376");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBe(2);
      expect(result.data[0]!.client_id).toBe(1);
      expect(result.data[1]!.client_id).toBe(2);
    }
  });
});

describe("checkConditions", () => {
  const baseData = mockHfmResponse.clients[0]!;

  afterEach(() => {
    delete process.env.TARGET_WALLET;
  });

  test("match all when wallet matches target and deposits >= 200 USD", () => {
    process.env.TARGET_WALLET = "98241376";
    const result = checkConditions(baseData);
    expect(result.underTargetWallet).toBe(true);
    expect(result.depositThresholdMet).toBe(true);
    expect(result.matchAll).toBe(true);
  });

  test("not match when wallet does not match target", () => {
    process.env.TARGET_WALLET = "30506525";
    const result = checkConditions(baseData);
    expect(result.underTargetWallet).toBe(false);
    expect(result.matchAll).toBe(false);
  });

  test("not match when deposits below 200 USD", () => {
    process.env.TARGET_WALLET = "98241376";
    const lowDeposit = { ...baseData, deposits: 150 };
    const result = checkConditions(lowDeposit);
    expect(result.depositThresholdMet).toBe(false);
    expect(result.matchAll).toBe(false);
  });

  test("USC deposits normalized by dividing by 100", () => {
    process.env.TARGET_WALLET = "98241376";
    const uscData = { ...baseData, deposits: 200_00, account_currency: "USC" };
    const result = checkConditions(uscData);
    expect(result.depositThresholdMet).toBe(true);
  });

  test("USC deposits below threshold after normalization", () => {
    process.env.TARGET_WALLET = "98241376";
    const uscData = { ...baseData, deposits: 199_99, account_currency: "USC" };
    const result = checkConditions(uscData);
    expect(result.depositThresholdMet).toBe(false);
  });

  test("not match when TARGET_WALLET is not set", () => {
    const result = checkConditions(baseData);
    expect(result.underTargetWallet).toBe(false);
    expect(result.matchAll).toBe(false);
  });
});

describe("fetchAllClients", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("fetchAllClients calls client-performance with no query params", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(mockHfmResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await fetchAllClients();
    expect(result.ok).toBe(true);
    expect(calledUrl).toBe("https://api.hfaffiliates.com/api/performance/client-performance");
    expect(calledUrl.includes("?")).toBe(false);
  });

  test("fetchAllClients returns data with clients and totals", async () => {
    globalThis.fetch = mockFetch(200, mockHfmResponse);
    const result = await fetchAllClients();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.clients).toHaveLength(1);
      expect(result.data.totals).toBeDefined();
    }
  });

  test("fetchAllClients timeout returns timeout", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        (init as RequestInit)?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      throw new Error("unreachable");
    }) as unknown as typeof globalThis.fetch;

    const result = await fetchAllClients(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchAllClients server error returns server_error", async () => {
    globalThis.fetch = mockFetch(500, { detail: "Internal error" });
    const result = await fetchAllClients();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server_error");
  });

  test("fetchAllClients invalid body returns server_error", async () => {
    globalThis.fetch = mockFetch(200, { not_clients: true });
    const result = await fetchAllClients();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server_error");
  });
});
