import { getDb, type DrizzleDb } from "../db/connection";
import { getActiveUids, seedFromEnv } from "../repositories/recipient.repository";
import { checkHfmApiHealthy } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";

const DOWN_MESSAGE =
  "⚠️ ขณะนี้ HFM API ขัดข้อง (ตรวจสอบจาก /api/wallet/balance) — ระบบจะแจ้งเตือนอีกครั้งเมื่อกลับมาใช้งานได้ตามปกติ";
const RECOVERED_MESSAGE = "✅ HFM API กลับมาใช้งานได้ตามปกติแล้ว";

// In-memory liveness state. Baseline "up" so a first failed probe alerts, while
// a first successful probe stays quiet. Persists for the process lifetime; a
// restart while HFM is down re-sends the "down" alert once (accepted tradeoff).
let lastHealthy = true;

export interface RunHfmHealthCheckOptions {
  db?: DrizzleDb;
  checkHealthyFn?: () => Promise<boolean>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  getUidsFn?: (db: DrizzleDb) => Promise<string[]>;
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

  const healthy = await checkHealthy();

  // No state change => no notification (avoids spamming every 5 minutes).
  if (healthy === lastHealthy) return;

  const uids = await getUids(db);
  if (uids.length === 0) {
    console.warn("[cron] hfm-healthcheck: no active recipients, skipping notify");
    // Still record the transition so we don't keep re-resolving an empty list.
    lastHealthy = healthy;
    return;
  }

  const message = healthy ? RECOVERED_MESSAGE : DOWN_MESSAGE;
  // Update state only after a successful push so a failed send retries next tick.
  await pushAll(uids, message);
  lastHealthy = healthy;
}

// Test-only: reset the in-memory state back to the "up" baseline.
export function __resetHealthState(): void {
  lastHealthy = true;
}
