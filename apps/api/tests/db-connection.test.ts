import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as connectionMod from "../src/db/connection";
import {
  closeDb,
  getDb,
  openDb,
  resetDbForTests,
  runWithDb,
  type DbHandle,
} from "../src/db/connection";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let handles: DbHandle[] = [];

function track(handle: DbHandle): DbHandle {
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  handles = [];
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  resetDbForTests();
});

afterEach(async () => {
  // Each openDb() and each getDb() fallback opens a real pool. Close them or
  // the files running after this one hit "too many clients".
  for (const handle of handles) await handle.dispose();
  await closeDb();
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  resetDbForTests();
});

test("openDb returns a working handle", async () => {
  const handle = track(openDb(TEST_DATABASE_URL));

  const rows = await handle.db.execute(sql`SELECT 1 AS one`);
  expect(rows[0]!.one).toBe(1);
});

test("dispose resolves and is safe to await", async () => {
  const handle = openDb(TEST_DATABASE_URL);
  await handle.db.execute(sql`SELECT 1`);

  await expect(handle.dispose()).resolves.toBeUndefined();
});

test("runWithDb scopes getDb to the handle", () => {
  const handle = track(openDb(TEST_DATABASE_URL));

  const scoped = runWithDb(handle, () => getDb());
  expect(scoped).toBe(handle.db);
});

test("the scope wins even after the fallback was created", () => {
  const fallback = getDb();
  const handle = track(openDb(TEST_DATABASE_URL));

  const scoped = runWithDb(handle, () => getDb());
  expect(scoped).toBe(handle.db);
  expect(scoped).not.toBe(fallback);
  expect(getDb()).toBe(fallback);
});

test("runWithDb survives an await inside the callback", async () => {
  const handle = track(openDb(TEST_DATABASE_URL));

  const scoped = await runWithDb(handle, async () => {
    await handle.db.execute(sql`SELECT 1`);
    return getDb();
  });
  expect(scoped).toBe(handle.db);
});

test("getDb falls back to process.env.DATABASE_URL and caches it", async () => {
  const first = getDb();
  const second = getDb();

  expect(first).toBe(second);
  const rows = await first.execute(sql`SELECT 1 AS one`);
  expect(rows[0]!.one).toBe(1);
});

test("resetDbForTests forces a new fallback client", () => {
  const first = getDb();
  resetDbForTests();
  const second = getDb();

  expect(second).not.toBe(first);
});

test("getDb throws when there is no scope and no DATABASE_URL", () => {
  delete process.env.DATABASE_URL;
  resetDbForTests();

  expect(() => getDb()).toThrow("DATABASE_URL is not set");
});

test("initDb is gone from the runtime path", () => {
  expect("initDb" in connectionMod).toBe(false);
});
