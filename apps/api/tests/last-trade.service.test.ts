import { expect, test, describe, beforeEach, mock } from "bun:test";
import {
  getLastTradeMap,
  getLastTradeMapWithin,
  resetLastTradeCache,
} from "../src/services/last-trade.service";
import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";

function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
  return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
}

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
    const map = await getLastTradeMap({ fetchClientsFn });
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
    const map = await getLastTradeMap({ fetchClientsFn, sleepFn });
    expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
    expect(fetchClientsFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  test("returns null after 3 failed attempts with no cache", async () => {
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({ ok: false, reason: "server_error" }),
    );
    const sleepFn = mock(async (_ms: number) => {});
    const map = await getLastTradeMap({ fetchClientsFn, sleepFn });
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
    const first = await getLastTradeMap({ fetchClientsFn: okFetch, nowMs });
    expect(first!.get(101)).toBe("A");

    now = 6 * 60 * 1000; // past the 5-minute TTL
    const failFetch = mock(
      async (): Promise<HFMClientsResult> => ({ ok: false, reason: "server_error" }),
    );
    const sleepFn = mock(async (_ms: number) => {});

    const startedAt = Date.now();
    const second = await getLastTradeMap({ fetchClientsFn: failFetch, sleepFn, nowMs });
    const elapsed = Date.now() - startedAt;

    expect(second!.get(101)).toBe("A");
    expect(elapsed).toBeLessThan(50); // returned without waiting on the ladder
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
    await getLastTradeMap({ fetchClientsFn, nowMs });
    now = 60 * 1000; // 1 minute later, still within TTL
    const second = await getLastTradeMap({ fetchClientsFn, nowMs });
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
    const p1 = getLastTradeMap({ fetchClientsFn });
    const p2 = getLastTradeMap({ fetchClientsFn });
    resolveFetch({ ok: true, data: [makeRow({ id: 101, last_trade: "A" })] });
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1!.get(101)).toBe("A");
    expect(m2).toBe(m1);
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
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
    const map = await getLastTradeMapWithin(500, { fetchClientsFn });
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
    const map = await getLastTradeMapWithin(50, { fetchClientsFn });
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
    expect(await getLastTradeMapWithin(20, { fetchClientsFn })).toBeNull();
    await waitForCalls(fetchClientsFn, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const warm = await getLastTradeMapWithin(50, { fetchClientsFn });
    expect(warm!.get(101)).toBe("A");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });
});
