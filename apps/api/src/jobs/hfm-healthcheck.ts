import { getDb, type DrizzleDb } from "../db/connection";
import { getJobState, setJobState } from "../db/state.repository";
import { getActiveUids, seedFromEnv } from "../repositories/recipient.repository";
import { checkHfmApiHealthy } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";

const DOWN_MESSAGE =
  "⚠️ ขณะนี้ HFM API ขัดข้อง (ตรวจสอบจาก /api/wallet/balance) — ระบบจะแจ้งเตือนอีกครั้งเมื่อกลับมาใช้งานได้ตามปกติ";
const RECOVERED_MESSAGE = "✅ HFM API กลับมาใช้งานได้ตามปกติแล้ว";

// Durable liveness state. The Bun process kept this in a module-level variable;
// on Workers every cron tick can run in a brand new isolate, so an in-memory
// flag would make the "HFM API down" alert repeat every 5 minutes forever.
// The row is read-after-write correct, which KV is not: a KV read can serve a
// value up to 60 seconds stale and the tick interval is only 5 minutes.
// No row means "up", so a first failed probe alerts while a first successful
// probe stays quiet.
export const LAST_HEALTHY_KEY = "hfm_healthcheck:last_healthy";

export interface RunHfmHealthCheckOptions {
  db?: DrizzleDb;
  checkHealthyFn?: () => Promise<boolean>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  getUidsFn?: (db: DrizzleDb) => Promise<string[]>;
  getStateFn?: (db: DrizzleDb, key: string) => Promise<string | null>;
  setStateFn?: (db: DrizzleDb, key: string, value: string) => Promise<void>;
}

async function resolveUids(db: DrizzleDb): Promise<string[]> {
  await seedFromEnv(db, process.env.LINE_NOTIFY_UIDS ?? "");
  return getActiveUids(db);
}

export async function runHfmHealthCheck(
  options: RunHfmHealthCheckOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const checkHealthy = options.checkHealthyFn ?? checkHfmApiHealthy;
  const pushAll = options.pushToAllFn ?? pushToAll;
  const getUids = options.getUidsFn ?? resolveUids;
  const getState = options.getStateFn ?? getJobState;
  const setState = options.setStateFn ?? setJobState;

  const healthy = await checkHealthy();

  const stored = await getState(db, LAST_HEALTHY_KEY);
  const lastHealthy = stored === null ? true : stored === "1";

  // No state change => no notification (avoids spamming every 5 minutes).
  if (healthy === lastHealthy) return;

  const uids = await getUids(db);
  if (uids.length === 0) {
    console.warn("[cron] hfm-healthcheck: no active recipients, skipping notify");
    // Still record the transition so we don't keep re-resolving an empty list.
    await setState(db, LAST_HEALTHY_KEY, healthy ? "1" : "0");
    return;
  }

  const message = healthy ? RECOVERED_MESSAGE : DOWN_MESSAGE;
  // Update state only after a successful push so a failed send retries next tick.
  await pushAll(uids, message);
  await setState(db, LAST_HEALTHY_KEY, healthy ? "1" : "0");
}
