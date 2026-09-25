import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createTestDb, closeTestDb } from "./db-helpers";
import { claimLineEvent, getJobState, purgeEventClaims, setJobState } from "../src/db/state.repository";
import { eq } from "drizzle-orm";
import { jobState } from "../src/db/schema";
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

describe("LINE event claims", () => {
  test("the first claim wins and a repeat claim loses", async () => {
    expect(await claimLineEvent(db, "evt-claim-1")).toBe(true);
    expect(await claimLineEvent(db, "evt-claim-1")).toBe(false);
  });

  test("concurrent claims for one event have exactly one winner", async () => {
    const results = await Promise.all([
      claimLineEvent(db, "evt-race"),
      claimLineEvent(db, "evt-race"),
      claimLineEvent(db, "evt-race"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("purge removes only old event claims", async () => {
    await claimLineEvent(db, "evt-old");
    await claimLineEvent(db, "evt-new");
    await setJobState(db, "hfm_healthcheck:last_healthy", "1");
    await db
      .update(jobState)
      .set({ updatedAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(jobState.key, "line_event:evt-old"));

    expect(await purgeEventClaims(db, 60_000)).toBe(1);

    // evt-old is gone, so it can be claimed again; evt-new is still held.
    expect(await claimLineEvent(db, "evt-old")).toBe(true);
    expect(await claimLineEvent(db, "evt-new")).toBe(false);
    // Job state that is not an event claim is never purged.
    expect(await getJobState(db, "hfm_healthcheck:last_healthy")).toBe("1");
  });
});
