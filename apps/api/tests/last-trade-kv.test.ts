import { expect, test, describe, beforeEach, afterAll, mock } from "bun:test";
import {
  getLastTradeMap,
  refreshLastTradeCache,
  resetLastTradeCache,
  LAST_TRADE_KV_KEY,
} from "../src/services/last-trade.service";
import { runWithCache, type KvCache } from "../src/cache/kv";
import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";

function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
  return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
}

interface FakeKv extends KvCache {
  store: Map<string, string>;
  puts: { key: string; value: string; options?: { expirationTtl?: number } }[];
  gets: { key: string; options: { type: "json"; cacheTtl?: number } }[];
}

function fakeKv(seed?: unknown): FakeKv {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(LAST_TRADE_KV_KEY, JSON.stringify(seed));
  const kv: FakeKv = {
    store,
    puts: [],
    gets: [],
    async get(key, options) {
      kv.gets.push({ key, options });
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key, value, options) {
      kv.puts.push({ key, value, options });
      store.set(key, value);
    },
  };
  return kv;
}

describe("last-trade KV cache", () => {
  beforeEach(() => {
    resetLastTradeCache();
  });

  // bun test shares one process across files, so a populated memo would leak
  // into tests/webhook-logging.test.ts and hide its deadline assertions.
  afterAll(() => {
    resetLastTradeCache();
  });

  test("reads the map from KV and never calls HFM", async () => {
    const kv = fakeKv({
      v: 1,
      fetchedAt: Date.now(),
      entries: [[101, "2026-07-19T10:00:00Z"], [202, null]],
    });
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({ ok: true, data: [] }),
    );

    const map = await getLastTradeMap({ kv, fetchClientsFn });

    expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
    expect(map!.get(202)).toBeNull();
    expect(fetchClientsFn).toHaveBeenCalledTimes(0);
    expect(kv.gets[0]).toEqual({
      key: LAST_TRADE_KV_KEY,
      options: { type: "json", cacheTtl: 60 },
    });
  });

  test("picks the binding up from runWithCache", async () => {
    const kv = fakeKv({ v: 1, fetchedAt: Date.now(), entries: [[7, "T"]] });
    const map = await runWithCache(kv, () => getLastTradeMap());
    expect(map!.get(7)).toBe("T");
  });

  test("falls back to exactly one live fetch on a KV miss", async () => {
    const kv = fakeKv();
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: false,
        reason: "server_error",
      }),
    );

    const map = await getLastTradeMap({ kv, fetchClientsFn });

    expect(map).toBeNull();
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("serves the memo instead of refetching after a KV miss", async () => {
    const kv = fakeKv();
    let now = 0;
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 101, last_trade: "A" })],
      }),
    );

    await getLastTradeMap({ kv, fetchClientsFn, nowMs: () => now });
    now = 6 * 60 * 1000; // past the 5 minute memo TTL
    const second = await getLastTradeMap({ kv, fetchClientsFn, nowMs: () => now });

    expect(second!.get(101)).toBe("A");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("a KV read failure degrades to a live fetch", async () => {
    const kv = fakeKv();
    kv.get = async () => {
      throw new Error("kv down");
    };
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 5, last_trade: "B" })],
      }),
    );

    const map = await getLastTradeMap({ kv, fetchClientsFn });

    expect(map!.get(5)).toBe("B");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("refreshLastTradeCache writes the whole map with a 900s TTL", async () => {
    const kv = fakeKv();
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [
          makeRow({ id: 101, last_trade: "A" }),
          makeRow({ id: 202, last_trade: null }),
        ],
      }),
    );

    const size = await refreshLastTradeCache({
      kv,
      fetchClientsFn,
      nowMs: () => 1_000,
    });

    expect(size).toBe(2);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe(LAST_TRADE_KV_KEY);
    expect(kv.puts[0]!.options).toEqual({ expirationTtl: 900 });
    expect(JSON.parse(kv.puts[0]!.value)).toEqual({
      v: 1,
      fetchedAt: 1_000,
      entries: [[101, "A"], [202, null]],
    });
  });

  test("refreshLastTradeCache retries three times without sleeping", async () => {
    const kv = fakeKv();
    let calls = 0;
    const fetchClientsFn = mock(async (): Promise<HFMClientsResult> => {
      calls += 1;
      if (calls < 3) return { ok: false, reason: "server_error" };
      return { ok: true, data: [makeRow({ id: 9, last_trade: "C" })] };
    });

    const startedAt = Date.now();
    const size = await refreshLastTradeCache({ kv, fetchClientsFn });
    const elapsed = Date.now() - startedAt;

    expect(size).toBe(1);
    expect(calls).toBe(3);
    expect(elapsed).toBeLessThan(100);
  });

  test("refreshLastTradeCache writes nothing when every attempt fails", async () => {
    const kv = fakeKv();
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: false,
        reason: "server_error",
      }),
    );

    const size = await refreshLastTradeCache({ kv, fetchClientsFn });

    expect(size).toBeNull();
    expect(kv.puts).toHaveLength(0);
  });
});
