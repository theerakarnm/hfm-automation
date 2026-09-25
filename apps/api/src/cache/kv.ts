import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structural subset of the Workers KVNamespace binding used by this codebase.
 * Declared locally so `src/` still typechecks under `bun test`, where the
 * Cloudflare types are not loaded, and so tests can pass a plain fake.
 */
export interface KvCache {
  get(
    key: string,
    options: { type: "json"; cacheTtl?: number },
  ): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

// Request-scoped, never module-scoped: an isolate is shared by many requests
// and is evicted at any time, so the binding is carried in the async scope the
// Worker entrypoint opens, exactly like the config and the database handle.
const storage = new AsyncLocalStorage<KvCache | null>();

export function runWithCache<T>(kv: KvCache | null, fn: () => T): T {
  return storage.run(kv, fn);
}

/**
 * Returns the KV binding for this invocation, or null when there is no scope.
 * `bun test` and the local scripts run without a scope, so every caller must
 * treat null as "no shared cache" and fall back to a live fetch.
 */
export function getCache(): KvCache | null {
  return storage.getStore() ?? null;
}
