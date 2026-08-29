import { fetchClients } from "./hfm.service";
import { logError } from "../utils/logger";
import type { HFMClientsResult } from "../types/hfm.types";

const FRESH_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000]; // between attempts 1->2 and 2->3

type LastTradeMap = Map<number, string | null>;

interface CacheEntry {
  map: LastTradeMap;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<LastTradeMap | null> | null = null;

export interface GetLastTradeMapOptions {
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  sleepFn?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function resetLastTradeCache(): void {
  cache = null;
  inflight = null;
}

// Fetches the account-id -> last_trade map, retrying the flaky HFM
// /api/clients/ endpoint and serving a short-lived cache. Returns null
// only when every attempt fails and no prior cache exists.
export async function getLastTradeMap(
  options: GetLastTradeMapOptions = {},
): Promise<LastTradeMap | null> {
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepFn ?? defaultSleep;
  const fetchClientsFn =
    options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));

  if (cache && now() - cache.fetchedAt < FRESH_TTL_MS) {
    return cache.map;
  }

  // Single-flight: concurrent callers share one refresh.
  if (!inflight) {
    inflight = refresh(fetchClientsFn, sleep, now).finally(() => {
      inflight = null;
    });
  }
  const refreshing = inflight;

  // Stale-while-revalidate: /api/clients/ needs ~7s even when healthy, so
  // an expired cache is handed back immediately while the refresh warms it
  // for the next lookup. Only a completely cold cache blocks the caller.
  if (cache) {
    refreshing.catch((err) => logError("last-trade", err));
    return cache.map;
  }

  return refreshing;
}

// Same contract as getLastTradeMap but never blocks the caller longer than
// deadlineMs. On a cold cache the retry ladder can run for ~48s, which does
// not fit inside LINE's 60s reply-token window; past the deadline we hand
// back whatever cache exists (possibly none) and let the refresh finish in
// the background so the next lookup is warm.
export async function getLastTradeMapWithin(
  deadlineMs: number,
  options: GetLastTradeMapOptions = {},
): Promise<LastTradeMap | null> {
  const pending = getLastTradeMap(options).catch((err) => {
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
      resolve(cache?.map ?? null);
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
      const map: LastTradeMap = new Map(
        result.data.map((row) => [row.id, row.last_trade]),
      );
      cache = { map, fetchedAt: now() };
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

  if (cache) {
    logError("last-trade", "getLastTradeMap fetch failed; serving stale cache");
    return cache.map;
  }
  logError("last-trade", "getLastTradeMap fetch failed; no cache available");
  return null;
}
