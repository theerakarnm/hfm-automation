import { expect, test, beforeEach } from "bun:test";
import {
  runHfmHealthCheck,
  __resetHealthState,
} from "../src/jobs/hfm-healthcheck";
import type { DrizzleDb } from "../src/db/connection";

// Captures every pushToAll call so we can assert on count and message content.
function makeHarness(healthSeq: boolean[]) {
  const sent: string[] = [];
  let i = 0;
  return {
    sent,
    run: () =>
      runHfmHealthCheck({
        db: {} as DrizzleDb,
        checkHealthyFn: async () => healthSeq[i++]!,
        getUidsFn: async () => ["Utest123"],
        pushToAllFn: async (_uids, text) => {
          sent.push(text);
        },
      }),
  };
}

beforeEach(() => {
  __resetHealthState();
});

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

test("no recipients: records the transition without sending", async () => {
  const sent: string[] = [];
  const opts = {
    db: {} as DrizzleDb,
    getUidsFn: async () => [] as string[],
    pushToAllFn: async (_uids: string[], text: string) => {
      sent.push(text);
    },
  };

  // up -> down with no recipients: nothing sent, but state must advance to down.
  await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => false });
  expect(sent).toEqual([]);

  // down -> up should now be a real transition (recovered), still no recipients.
  await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => true });
  expect(sent).toEqual([]);

  // up -> up: confirm state settled at "up" (no further transition logic fires).
  await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => true });
  expect(sent).toEqual([]);
});
