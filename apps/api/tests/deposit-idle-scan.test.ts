import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { closeTestDb, createTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import { getJobState } from "../src/db/state.repository";
import { MATCH_BASELINE_KEY, runDailyScan } from "../src/jobs/deposit-idle-scan";
import type { HFMClientRow, HFMPerformanceData } from "../src/types/hfm.types";

const TARGET = 55946812;
let db: DrizzleDb;
let client: postgres.Sql;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db as unknown as DrizzleDb;
  client = created.client;
});
afterAll(async () => closeTestDb(client));

const ENV_KEYS = [
  "TARGET_WALLET",
  "MATCH_RULE",
  "IDLE_ALERT_DAYS",
  "DEPOSIT_THRESHOLD_USD",
  "DEPOSIT_THRESHOLD_USC",
];

beforeEach(async () => {
  await db.execute(
    sql`DELETE FROM account_match_state; DELETE FROM wallet_idle_alerts; DELETE FROM job_state;`,
  );
  process.env.TARGET_WALLET = String(TARGET);
  process.env.MATCH_RULE = "deposits";
  process.env.IDLE_ALERT_DAYS = "0";
  process.env.DEPOSIT_THRESHOLD_USD = "30";
  process.env.DEPOSIT_THRESHOLD_USC = "3000";
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const perfRow = (o: Partial<HFMPerformanceData> = {}): HFMPerformanceData => ({
  client_id: 10,
  account_id: 1,
  activity_status: "active",
  trades: 0,
  volume: 0,
  account_type: "Standard",
  balance: 0,
  account_currency: "USD",
  equity: 0,
  archived: false,
  subaffiliate: TARGET,
  account_regdate: "2026-01-01T00:00:00Z",
  status: "approved",
  deposits: 50,
  ...o,
});

const clientRow = (o: Partial<HFMClientRow> = {}): HFMClientRow => ({
  id: 1,
  wallet: 10,
  type: null,
  last_trade: null,
  volume: null,
  balance: 0,
  commission: 0,
  account_currency: "USD",
  country: null,
  rebates_paid: null,
  rebates_unpaid: null,
  rebates_rejected: null,
  first_trade: null,
  first_funding: null,
  registration: null,
  server: null,
  platform: null,
  conversion_device: null,
  deposits: 50,
  withdrawals: 0,
  name: null,
  email: null,
  equity: 0,
  margin: null,
  free_margin: null,
  ...o,
});

function harness(initial: { perf?: HFMPerformanceData[]; clients?: HFMClientRow[] } = {}) {
  const h = {
    perf: initial.perf ?? [],
    clients: initial.clients ?? [],
    now: "2026-10-26T00:00:00Z",
    failPush: false,
    failClients: false,
    fetchCalls: 0,
    sent: [] as string[],
    run: () =>
      runDailyScan({
        db,
        nowMs: () => Date.parse(h.now),
        fetchAllClientsFn: async () => {
          h.fetchCalls++;
          return {
            ok: true as const,
            data: {
              clients: h.perf,
              totals: { clients: 0, accounts: 0, volume: 0, balance: 0, withdrawals: 0, commission: 0 },
            },
          };
        },
        fetchClientsFn: async () =>
          h.failClients
            ? { ok: false as const, reason: "timeout" as const }
            : { ok: true as const, data: h.clients },
        getUidsFn: async () => ["U1"],
        pushToAllFn: async (_uids, text) => {
          if (h.failPush) throw new Error("push down");
          h.sent.push(text);
        },
      }),
  };
  return h;
}

describe("both features off", () => {
  test("returns before any HFM call", async () => {
    process.env.MATCH_RULE = "balance";
    const h = harness({ perf: [perfRow()] });
    await h.run();
    expect(h.fetchCalls).toBe(0);
    expect(h.sent).toEqual([]);
  });
});

describe("deposit match", () => {
  test("the first run is a silent baseline", async () => {
    const h = harness({ perf: [perfRow({ account_id: 1 })] });
    await h.run();
    expect(h.sent).toEqual([]);
    expect(await getJobState(db, MATCH_BASELINE_KEY)).toBe("1");
    await h.run();
    expect(h.sent).toEqual([]);
  });

  test("a new account over 30 is announced once", async () => {
    const h = harness({ perf: [perfRow({ account_id: 1 })] });
    await h.run();
    h.perf = [perfRow({ account_id: 1 }), perfRow({ account_id: 2, client_id: 20, deposits: 31 })];
    await h.run();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("T2 (wallet 20)");
    expect(h.sent[0]).not.toContain("T1 ");
    await h.run();
    expect(h.sent).toHaveLength(1);
  });

  test("an account over 30 under another partner is ignored", async () => {
    const h = harness({ perf: [perfRow({ account_id: 1 })] });
    await h.run();
    h.perf.push(perfRow({ account_id: 3, subaffiliate: 999, deposits: 99 }));
    await h.run();
    expect(h.sent).toEqual([]);
  });

  test("a failed push is retried on the next run", async () => {
    const h = harness({ perf: [perfRow({ account_id: 1 })] });
    await h.run();
    h.perf.push(perfRow({ account_id: 2, client_id: 20, deposits: 31 }));
    h.failPush = true;
    await h.run();
    expect(h.sent).toEqual([]);
    h.failPush = false;
    await h.run();
    expect(h.sent).toHaveLength(1);
  });

  test("an HFM failure changes nothing", async () => {
    const h = harness({ perf: [perfRow()] });
    h.failClients = true;
    await h.run();
    expect(h.sent).toEqual([]);
    expect(await getJobState(db, MATCH_BASELINE_KEY)).toBeNull();
  });
});

describe("idle wallets", () => {
  beforeEach(() => {
    process.env.MATCH_RULE = "balance";
    process.env.IDLE_ALERT_DAYS = "21";
  });

  test("alerts once, re-arms after the wallet trades, alerts again on the next idle spell", async () => {
    const h = harness({
      perf: [perfRow()],
      clients: [clientRow({ last_trade: "2026-09-01 10:00:00" })],
    });
    await h.run();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("• 10 - เทรดล่าสุด 2026-09-01");

    await h.run();
    expect(h.sent).toHaveLength(1);

    h.clients = [clientRow({ last_trade: "2026-10-25 10:00:00" })];
    await h.run();
    expect(h.sent).toHaveLength(1);

    h.now = "2026-12-01T00:00:00Z";
    await h.run();
    expect(h.sent).toHaveLength(2);
  });

  test("a funded wallet that never traded is reported from its first funding", async () => {
    const h = harness({
      perf: [perfRow()],
      clients: [clientRow({ last_trade: null, first_funding: "2026-09-01 08:00:00" })],
    });
    await h.run();
    expect(h.sent[0]).toContain("เติมเงินครั้งแรก 2026-09-01 ยังไม่เคยเทรด");
  });

  test("a recently active wallet is not reported", async () => {
    const h = harness({
      perf: [perfRow()],
      clients: [clientRow({ last_trade: "2026-10-20 10:00:00" })],
    });
    await h.run();
    expect(h.sent).toEqual([]);
  });
});
