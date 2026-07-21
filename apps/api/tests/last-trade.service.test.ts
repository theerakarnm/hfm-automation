import { expect, test, describe, beforeEach, mock } from "bun:test";
import {
  getLastTradeMap,
  resetLastTradeCache,
} from "../src/services/last-trade.service";
import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";

function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
  return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
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

  test("serves stale cache when a later refresh fully fails", async () => {
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
    const second = await getLastTradeMap({ fetchClientsFn: failFetch, sleepFn, nowMs });
    expect(second!.get(101)).toBe("A");
    expect(failFetch).toHaveBeenCalledTimes(3);
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
