import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createTestDb, closeTestDb } from "./db-helpers";
import { getJobState, setJobState } from "../src/db/state.repository";
import type { DrizzleDb } from "../src/db/connection";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db as unknown as DrizzleDb;
  client = created.client;
});

afterAll(async () => {
  await closeTestDb(client);
});

describe("job state repository", () => {
  test("returns null for a key that was never written", async () => {
    expect(await getJobState(db, "never:written")).toBeNull();
  });

  test("stores and reads back a value", async () => {
    await setJobState(db, "hfm_healthcheck:last_healthy", "0");
    expect(await getJobState(db, "hfm_healthcheck:last_healthy")).toBe("0");
  });

  test("overwrites an existing key instead of inserting a second row", async () => {
    await setJobState(db, "overwrite:me", "1");
    await setJobState(db, "overwrite:me", "0");
    expect(await getJobState(db, "overwrite:me")).toBe("0");
  });

  test("keeps separate keys independent", async () => {
    await setJobState(db, "key:a", "1");
    await setJobState(db, "key:b", "0");
    expect(await getJobState(db, "key:a")).toBe("1");
    expect(await getJobState(db, "key:b")).toBe("0");
  });
});
