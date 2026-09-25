import { expect, test, describe } from "bun:test";
import {
  runHfmHealthCheck,
  LAST_HEALTHY_KEY,
} from "../src/jobs/hfm-healthcheck";
import type { DrizzleDb } from "../src/db/connection";

// Captures every pushToAll call so we can assert on count and message content.
// The liveness flag now lives in the database, so the harness stands in for
// src/db/state.repository.ts with a plain Map. Surviving the isolate is the
// whole point, so the map is created once and shared by every run.
function makeHarness(healthSeq: boolean[], seed?: string) {
  const sent: string[] = [];
  const state = new Map<string, string>();
  if (seed !== undefined) state.set(LAST_HEALTHY_KEY, seed);
  let i = 0;
  return {
    sent,
    state,
    run: () =>
      runHfmHealthCheck({
        db: {} as DrizzleDb,
        checkHealthyFn: async () => healthSeq[i++]!,
        getUidsFn: async () => ["Utest123"],
        pushToAllFn: async (_uids, text) => {
          sent.push(text);
        },
        getStateFn: async (_db, key) => state.get(key) ?? null,
        setStateFn: async (_db, key, value) => {
          state.set(key, value);
        },
      }),
  };
}

test("no alert while the API stays up (baseline up -> up)", async () => {
  const h = makeHarness([true]);
  await h.run();
  expect(h.sent).toEqual([]);
});

test("transition-only: up -> down -> down -> up sends exactly two alerts", async () => {
  const h = makeHarness([true, false, false, true]);
  await h.run(); // up -> up: nothing
  await h.run(); // up -> down: down alert
  await h.run(); // down -> down: nothing (no spam)
  await h.run(); // down -> up: recovered alert

  expect(h.sent.length).toBe(2);
  expect(h.sent[0]).toContain("ขัดข้อง");
  expect(h.sent[1]).toContain("กลับมาใช้งานได้");
});

test("first probe down (from up baseline) alerts once", async () => {
  const h = makeHarness([false]);
  await h.run();
  expect(h.sent.length).toBe(1);
  expect(h.sent[0]).toContain("ขัดข้อง");
});

test("a fresh isolate reads the stored flag and does not repeat the alert", async () => {
  // Nothing in module memory says "already down"; only the stored row does.
  const h = makeHarness([false, false], "0");
  await h.run();
  await h.run();
  expect(h.sent).toEqual([]);
});

test("stores 0 when the API goes down and 1 when it recovers", async () => {
  const h = makeHarness([false, true]);
  await h.run();
  expect(h.state.get(LAST_HEALTHY_KEY)).toBe("0");
  await h.run();
  expect(h.state.get(LAST_HEALTHY_KEY)).toBe("1");
});

describe("no recipients", () => {
  test("records the transition without sending", async () => {
    const sent: string[] = [];
    const state = new Map<string, string>();
    const opts = {
      db: {} as DrizzleDb,
      getUidsFn: async () => [] as string[],
      pushToAllFn: async (_uids: string[], text: string) => {
        sent.push(text);
      },
      getStateFn: async (_db: DrizzleDb, key: string) => state.get(key) ?? null,
      setStateFn: async (_db: DrizzleDb, key: string, value: string) => {
        state.set(key, value);
      },
    };

    // up -> down with no recipients: nothing sent, but state must advance to down.
    await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => false });
    expect(sent).toEqual([]);
    expect(state.get(LAST_HEALTHY_KEY)).toBe("0");

    // down -> up should now be a real transition (recovered), still no recipients.
    await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => true });
    expect(sent).toEqual([]);
    expect(state.get(LAST_HEALTHY_KEY)).toBe("1");

    // up -> up: confirm state settled at "up" (no further transition logic fires).
    await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => true });
    expect(sent).toEqual([]);
  });
});
