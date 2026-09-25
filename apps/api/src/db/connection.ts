import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

/** Per-invocation. `dispose()` MUST be handed to ctx.waitUntil(). */
export interface DbHandle {
  db: DrizzleDb;
  dispose: () => Promise<void>;
}

// One client per Worker invocation. Hyperdrive owns the real pool and the warm
// origin connections, so this client only has to outlive a single fetch,
// scheduled or queue call.
//
// max 5, never higher: a Worker may keep at most 6 outbound connections waiting
// for response headers at once, and the LINE reply and HFM fetches compete for
// that same budget. 5 leaves exactly one slot for the reply that pays the
// 60s reply-token deadline.
// fetch_types false: skips the type-introspection round trip postgres.js
// otherwise makes on connect. We use no custom array types.
// prepare true: Hyperdrive can only cache prepared statements, and an unnamed
// statement defeats its pool.
export function openDb(connectionString: string): DbHandle {
  const client = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    prepare: true,
  });
  const db = drizzle(client, { schema });
  return { db, dispose: () => client.end() };
}

const dbStorage = new AsyncLocalStorage<DbHandle>();

/** ALS-scoped accessor so existing call sites keep using `getDb()` with no args. */
export function runWithDb<T>(handle: DbHandle, fn: () => T): T {
  return dbStorage.run(handle, fn);
}

// Fallback client for `bun test` and the bun scripts in scripts/, which run in
// a normal process with no Worker bindings and no ALS scope. Built lazily, so
// a test can set process.env.DATABASE_URL, call resetDbForTests() and get a
// client for the new URL (tests/webhook.test.ts:769-770 depends on exactly
// that to simulate a dead database).
let _client: postgres.Sql | null = null;
let _db: DrizzleDb | null = null;

export function getDb(): DrizzleDb {
  const scoped = dbStorage.getStore();
  if (scoped) return scoped.db;

  if (_db) return _db;
  const connUrl = process.env.DATABASE_URL;
  if (!connUrl) throw new Error("DATABASE_URL is not set");
  _client = postgres(connUrl, { max: 5, fetch_types: false, prepare: true });
  _db = drizzle(_client, { schema });
  return _db;
}

/** Closes the process.env fallback client. Scripts and tests only. */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export function resetDbForTests(): void {
  _client = null;
  _db = null;
}
