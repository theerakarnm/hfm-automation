import { fetchClients } from "./hfm.service";
import { logError, logInfo } from "../utils/logger";
import { getCache, type KvCache } from "../cache/kv";
import type { HFMClientsResult } from "../types/hfm.types";

const FRESH_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000]; // between attempts 1->2 and 2->3

// One blob per tenant. The version suffix lets the payload shape change
// without reading a stale object written by the previous deployment.
export const LAST_TRADE_KV_KEY = "last-trade:v1";
// 15 minutes: three */5 cron ticks may fail before the blob disappears.
const KV_TTL_SECONDS = 900;
// KV's own per-colo read cache. 60s is the default and 30s is the floor.
const KV_CACHE_TTL_SECONDS = 60;

type LastTradeMap = Map<number, string | null>;

interface CacheEntry {
  map: LastTradeMap;
  fetchedAt: number;
}

// Serialized shape of the KV blob. A Map is not JSON, so it travels as entries.
interface LastTradePayload {
  v: 1;
  fetchedAt: number;
  entries: [number, string | null][];
}

// L1 only. An isolate is created and evicted at any time, so this memo is a
// best-effort read-through in front of KV and is never the source of truth.
let memo: CacheEntry | null = null;
let inflight: Promise<LastTradeMap | null> | null = null;

export interface GetLastTradeMapOptions {
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  sleepFn?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  // Overrides the ambient binding from runWithCache(). Tests pass a fake.
  kv?: KvCache | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function resetLastTradeCache(): void {
  memo = null;
  inflight = null;
}

function toEntries(result: {
  data: { id: number; last_trade: string | null }[];
}): [number, string | null][] {
  return result.data.map((row) => [row.id, row.last_trade]);
}

// Fetches the account-id -> last_trade map. On Workers the */5 cron owns the
// refresh and this call is a KV read, so the customer reply path never pays
// the ~7s HFM /api/clients/ round trip on a cold isolate. Returns null only
// when KV is empty and the live fallback fetch fails too.
export async function getLastTradeMap(
  options: GetLastTradeMapOptions = {},
): Promise<LastTradeMap | null> {
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepFn ?? defaultSleep;
  const fetchClientsFn =
    options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));
  const kv = options.kv !== undefined ? options.kv : getCache();

  if (memo && now() - memo.fetchedAt < FRESH_TTL_MS) {
    return memo.map;
  }

  if (kv) return readThroughKv(kv, fetchClientsFn, now);

  // No KV binding in scope: bun test, scripts and local runs keep the original
  // single-flight, stale-while-revalidate behaviour of the Bun server.
  if (!inflight) {
    inflight = refresh(fetchClientsFn, sleep, now).finally(() => {
      inflight = null;
    });
  }
  const refreshing = inflight;

  if (memo) {
    refreshing.catch((err) => logError("last-trade", err));
    return memo.map;
  }

  return refreshing;
}

// KV path. No retry ladder and no background promise on purpose: work that is
// not awaited is cancelled when the invocation ends, and resuming it inside a
// later invocation raises "Cannot perform I/O on behalf of a different
// request". Retries live in refreshLastTradeCache(), which the cron awaits.
async function readThroughKv(
  kv: KvCache,
  fetchClientsFn: () => Promise<HFMClientsResult>,
  now: () => number,
): Promise<LastTradeMap | null> {
  try {
    const payload = (await kv.get(LAST_TRADE_KV_KEY, {
      type: "json",
      cacheTtl: KV_CACHE_TTL_SECONDS,
    })) as LastTradePayload | null;

    if (payload && Array.isArray(payload.entries)) {
      const map: LastTradeMap = new Map(payload.entries);
      memo = {
        map,
        fetchedAt:
          typeof payload.fetchedAt === "number" ? payload.fetchedAt : now(),
      };
      return map;
    }
  } catch (err) {
    logError("last-trade", err);
  }

  // KV miss: the cron has not run yet, or the blob expired after 15 minutes.
  if (memo) return memo.map;

  const result = await fetchClientsFn();
  if (result.ok) {
    const map: LastTradeMap = new Map(toEntries(result));
    memo = { map, fetchedAt: now() };
    return map;
  }
  logError(
    "last-trade",
    `last-trade KV miss and live fetch failed (${result.reason})`,
  );
  return null;
}

// Cron-side refresh. Writes the whole map to KV so every isolate in every colo
// reads it without touching HFM. Only this function writes the key, so the KV
// limit of one write per second per key can never be hit by a 5 minute cron.
// There is no sleep between attempts: setTimeout does not reliably delay on
// Workers, and each attempt already costs a real round trip of up to 15s.
export async function refreshLastTradeCache(
  options: GetLastTradeMapOptions = {},
): Promise<number | null> {
  const now = options.nowMs ?? Date.now;
  const fetchClientsFn =
    options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));
  const kv = options.kv !== undefined ? options.kv : getCache();

  let result: HFMClientsResult | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await fetchClientsFn();
    if (result.ok) break;
    logError(
      "last-trade",
      `refreshLastTradeCache attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
    );
  }

  if (!result || !result.ok) return null;

  const entries = toEntries(result);
  memo = { map: new Map(entries), fetchedAt: now() };

  if (!kv) return entries.length;

  const payload: LastTradePayload = { v: 1, fetchedAt: now(), entries };
  await kv.put(LAST_TRADE_KV_KEY, JSON.stringify(payload), {
    expirationTtl: KV_TTL_SECONDS,
  });
  logInfo(
    "last-trade",
    { size: entries.length, key: LAST_TRADE_KV_KEY },
    "last-trade cache written to KV",
  );
  return entries.length;
}

// Same contract as getLastTradeMap but never blocks the caller longer than
// deadlineMs. The budget is no longer about the ~48s retry ladder: on Workers
// the ladder lives in the cron, so this guards the two remaining costs, a KV
// read and, only on a KV miss, one live /api/clients/ call. The real ceiling
// is the fetch timeout below, because AbortSignal.timeout is a runtime timer
// while setTimeout "will not delay for the full time specified" on Workers.
export async function getLastTradeMapWithin(
  deadlineMs: number,
  options: GetLastTradeMapOptions = {},
): Promise<LastTradeMap | null> {
  const bounded: GetLastTradeMapOptions = {
    ...options,
    fetchClientsFn: options.fetchClientsFn ?? (() => fetchClients(deadlineMs)),
  };

  const pending = getLastTradeMap(bounded).catch((err) => {
    logError("last-trade", err);
    return null;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LastTradeMap | null>((resolve) => {
    timer = setTimeout(() => {
      logError(
        "last-trade",
        `getLastTradeMapWithin exceeded ${deadlineMs}ms; replying without a fresh map`,
      );
      resolve(memo?.map ?? null);
    }, deadlineMs);
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(
  fetchClientsFn: () => Promise<HFMClientsResult>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<LastTradeMap | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await fetchClientsFn();
    if (result.ok) {
      const map: LastTradeMap = new Map(toEntries(result));
      memo = { map, fetchedAt: now() };
      return map;
    }
    logError(
      "last-trade",
      `getLastTradeMap attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
    );
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_MS[attempt - 1]!);
    }
  }

  if (memo) {
    logError("last-trade", "getLastTradeMap fetch failed; serving stale cache");
    return memo.map;
  }
  logError("last-trade", "getLastTradeMap fetch failed; no cache available");
  return null;
}
