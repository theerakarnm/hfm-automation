import { expect, test, describe, beforeEach, mock } from "bun:test";
import {
  getLastTradeMap,
  getLastTradeMapWithin,
  resetLastTradeCache,
} from "../src/services/last-trade.service";
import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";
import type { TenantConfig } from "../src/types/tenant.types";

function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
  return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
}

function makeCtx(id: number): TenantConfig {
  return {
    id,
    webhookId: `oa-${id}`,
    label: `OA ${id}`,
    active: true,
    lineChannelAccessToken: `token_${id}`,
    lineChannelSecret: `secret_${id}`,
    lineBotUserId: `Ubot${id}`,
    lineBasicId: `@bot${id}`,
    lineDisplayName: `OA ${id}`,
    hfmApiKey: `hfm_key_${id}`,
    hfmApiBaseUrl: `https://hfm-${id}.invalid.example`,
    targetWallet: 30000 + id,
    whitelistEnabled: true,
    whitelistUids: [],
    lastTestedAt: null,
    lastTestResult: null,
  };
}

const ctxA = makeCtx(1);
const ctxB = makeCtx(2);

async function waitForCalls(
  m: { mock: { calls: unknown[] } },
  n: number,
  timeoutMs = 500,
): Promise<void> {
  const startedAt = Date.now();
  while (m.mock.calls.length < n) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${n} calls (got ${m.mock.calls.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("getLastTradeMap", () => {
  beforeEach(() => {
    resetLastTradeCache();
  });

  test("maps row.id -> last_trade on a successful fetch", async () => {
    const rows = [
      makeRow({ id: 101, last_trade: "2026-07-19T10:00:00Z" }),
      makeRow({ id: 202, last_trade: null }),
    ];
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({ ok: true, data: rows }),
    );
    const map = await getLastTradeMap(ctxA, { fetchClientsFn });
    expect(map).not.toBeNull();
    expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
    expect(map!.get(202)).toBeNull();
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("retries within one call when the first fetch flakes then succeeds", async () => {
    const rows = [makeRow({ id: 101, last_trade: "2026-07-19T10:00:00Z" })];
    let calls = 0;
    const fetchClientsFn = mock(async (): Promise<HFMClientsResult> => {
      calls += 1;
      if (calls === 1) return { ok: false, reason: "server_error" };
      return { ok: true, data: rows };
    });
    const sleepFn = mock(async (_ms: number) => {});
    const map = await getLastTradeMap(ctxA, { fetchClientsFn, sleepFn });
    expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
    expect(fetchClientsFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  test("returns null after 3 failed attempts with no cache", async () => {
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({ ok: false, reason: "server_error" }),
    );
    const sleepFn = mock(async (_ms: number) => {});
    const map = await getLastTradeMap(ctxA, { fetchClientsFn, sleepFn });
    expect(map).toBeNull();
    expect(fetchClientsFn).toHaveBeenCalledTimes(3);
  });

  test("serves stale cache immediately and refreshes in the background", async () => {
    let now = 0;
    const nowMs = () => now;
    const okFetch = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 101, last_trade: "A" })],
      }),
    );
    const first = await getLastTradeMap(ctxA, { fetchClientsFn: okFetch, nowMs });
    expect(first!.get(101)).toBe("A");

    now = 6 * 60 * 1000; // past the 5-minute TTL
    const failFetch = mock(
      async (): Promise<HFMClientsResult> => ({ ok: false, reason: "server_error" }),
    );
    // Real delay, not an instant mock: with an instant sleepFn the pre-SWR
    // blocking path also finished in ~1ms, so the elapsed assertion below
    // could not tell the two implementations apart.
    const sleepFn = mock(
      (_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 60)),
    );

    const startedAt = Date.now();
    const second = await getLastTradeMap(ctxA, { fetchClientsFn: failFetch, sleepFn, nowMs });
    const elapsed = Date.now() - startedAt;

    expect(second!.get(101)).toBe("A");
    // Blocking would cost 2 x 60ms of backoff; SWR returns straight away.
    expect(elapsed).toBeLessThan(50);
    await waitForCalls(failFetch, 3); // ladder still ran in the background
  });

  test("does not refetch while the cache is fresh", async () => {
    let now = 0;
    const nowMs = () => now;
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 101, last_trade: "A" })],
      }),
    );
    await getLastTradeMap(ctxA, { fetchClientsFn, nowMs });
    now = 60 * 1000; // 1 minute later, still within TTL
    const second = await getLastTradeMap(ctxA, { fetchClientsFn, nowMs });
    expect(second!.get(101)).toBe("A");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("coalesces concurrent callers into one in-flight fetch", async () => {
    let resolveFetch!: (r: HFMClientsResult) => void;
    const fetchClientsFn = mock(
      () =>
        new Promise<HFMClientsResult>((res) => {
          resolveFetch = res;
        }),
    );
    const p1 = getLastTradeMap(ctxA, { fetchClientsFn });
    const p2 = getLastTradeMap(ctxA, { fetchClientsFn });
    resolveFetch({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1!.get(101)).toBe("A");
    expect(m2).toBe(m1);
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });
});

describe("per-tenant isolation", () => {
  beforeEach(() => {
    resetLastTradeCache();
  });

  test("tenant B never receives tenant A's warmed map", async () => {
    const rowsFor = (ids: number[]) =>
      ids.map((id) => makeRow({ id, last_trade: `t${id}` }));
    const fetchA = async (): Promise<HFMClientsResult> => ({
      ok: true,
      data: rowsFor([1, 2]),
    });
    const fetchB = async (): Promise<HFMClientsResult> => ({
      ok: true,
      data: rowsFor([3]),
    });

    const fromA = await getLastTradeMap(ctxA, { fetchClientsFn: fetchA });
    expect(fromA!.get(1)).toBe("t1");

    const fromB = await getLastTradeMap(ctxB, { fetchClientsFn: fetchB });
    expect(fromB!.has(1)).toBe(false); // leak test
    expect(fromB!.get(3)).toBe("t3");
  });

  test("single flight is per tenant", async () => {
    let callsA = 0;
    let callsB = 0;
    const fetchA = async (): Promise<HFMClientsResult> => {
      callsA++;
      return { ok: true, data: [] };
    };
    const fetchB = async (): Promise<HFMClientsResult> => {
      callsB++;
      return { ok: true, data: [] };
    };
    await Promise.all([
      getLastTradeMap(ctxA, { fetchClientsFn: fetchA }),
      getLastTradeMap(ctxA, { fetchClientsFn: fetchA }),
      getLastTradeMap(ctxB, { fetchClientsFn: fetchB }),
    ]);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });

  test("resetLastTradeCache(tenantId) clears only that tenant", async () => {
    const nowMs = () => 0;
    const fetchA = async (): Promise<HFMClientsResult> => ({
      ok: true,
      data: [makeRow({ id: 101, last_trade: "A1" })],
    });
    const fetchB = async (): Promise<HFMClientsResult> => ({
      ok: true,
      data: [makeRow({ id: 202, last_trade: "B1" })],
    });
    await getLastTradeMap(ctxA, { fetchClientsFn: fetchA, nowMs });
    await getLastTradeMap(ctxB, { fetchClientsFn: fetchB, nowMs });

    resetLastTradeCache(ctxA.id);

    const fetchA2 = async (): Promise<HFMClientsResult> => ({
      ok: true,
      data: [makeRow({ id: 101, last_trade: "A2" })],
    });
    // A was reset, so it refetches and sees the new payload.
    const refetchedA = await getLastTradeMap(ctxA, { fetchClientsFn: fetchA2, nowMs });
    expect(refetchedA!.get(101)).toBe("A2");

    // B stays cached: the fetch stub below must never be called.
    let callsB2 = 0;
    const fetchB2 = async (): Promise<HFMClientsResult> => {
      callsB2++;
      return { ok: true, data: [] };
    };
    const stillCachedB = await getLastTradeMap(ctxB, { fetchClientsFn: fetchB2, nowMs });
    expect(stillCachedB!.get(202)).toBe("B1");
    expect(callsB2).toBe(0);
  });
});

describe("getLastTradeMapWithin", () => {
  beforeEach(() => {
    resetLastTradeCache();
  });

  test("returns the map when the fetch finishes inside the deadline", async () => {
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 101, last_trade: "A" })],
      }),
    );
    const map = await getLastTradeMapWithin(ctxA, 500, { fetchClientsFn });
    expect(map!.get(101)).toBe("A");
  });

  test("returns null at the deadline instead of blocking on a slow fetch", async () => {
    const fetchClientsFn = mock(
      () =>
        new Promise<HFMClientsResult>((resolve) =>
          setTimeout(
            () => resolve({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] }),
            400,
          ),
        ),
    );
    const startedAt = Date.now();
    const map = await getLastTradeMapWithin(ctxA, 50, { fetchClientsFn });
    const elapsed = Date.now() - startedAt;
    expect(map).toBeNull();
    expect(elapsed).toBeLessThan(300);

    // Let the background refresh settle before the next test runs. It is
    // currently benign (it writes the same 101 -> "A" payload the next test
    // asserts), so removing this does not turn the suite red today - it is
    // kept so a future reordering cannot make module-level cache state leak
    // across a test boundary.
    await new Promise((resolve) => setTimeout(resolve, 450));
  });

  test("background refresh still warms the cache after the deadline fires", async () => {
    const fetchClientsFn = mock(
      () =>
        new Promise<HFMClientsResult>((resolve) =>
          setTimeout(
            () => resolve({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] }),
            100,
          ),
        ),
    );
    expect(await getLastTradeMapWithin(ctxA, 20, { fetchClientsFn })).toBeNull();
    await waitForCalls(fetchClientsFn, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const warm = await getLastTradeMapWithin(ctxA, 50, { fetchClientsFn });
    expect(warm!.get(101)).toBe("A");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });
});
