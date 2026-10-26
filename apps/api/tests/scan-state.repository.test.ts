import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { closeTestDb, createTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import {
  claimIdleAlerts,
  claimNewMatches,
  clearRecoveredIdleAlerts,
  releaseIdleAlerts,
  releaseMatches,
} from "../src/repositories/scan-state.repository";

let db: DrizzleDb;
let client: postgres.Sql;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db as unknown as DrizzleDb;
  client = created.client;
});
afterAll(async () => closeTestDb(client));
beforeEach(async () => {
  await db.execute(sql`DELETE FROM account_match_state; DELETE FROM wallet_idle_alerts;`);
});

describe("match claims", () => {
  test("returns only the ids that were not claimed before", async () => {
    expect((await claimNewMatches(db, [1, 2])).sort()).toEqual([1, 2]);
    expect(await claimNewMatches(db, [2, 3])).toEqual([3]);
    expect(await claimNewMatches(db, [])).toEqual([]);
  });

  test("a released id can be claimed again", async () => {
    await claimNewMatches(db, [1, 2]);
    await releaseMatches(db, [2]);
    expect(await claimNewMatches(db, [1, 2])).toEqual([2]);
  });
});

describe("idle claims", () => {
  test("returns only wallets without an open alert", async () => {
    expect((await claimIdleAlerts(db, [10, 11])).sort()).toEqual([10, 11]);
    expect(await claimIdleAlerts(db, [10, 11])).toEqual([]);
  });

  test("clearing keeps the still idle wallets and drops the recovered ones", async () => {
    await claimIdleAlerts(db, [10, 11, 12]);
    expect(await clearRecoveredIdleAlerts(db, [11])).toBe(2);
    expect((await claimIdleAlerts(db, [10, 11, 12])).sort()).toEqual([10, 12]);
  });

  test("clearing with nobody idle drops every alert", async () => {
    await claimIdleAlerts(db, [10, 11]);
    expect(await clearRecoveredIdleAlerts(db, [])).toBe(2);
  });

  test("a released wallet can be claimed again", async () => {
    await claimIdleAlerts(db, [10]);
    await releaseIdleAlerts(db, [10]);
    expect(await claimIdleAlerts(db, [10])).toEqual([10]);
  });
});
