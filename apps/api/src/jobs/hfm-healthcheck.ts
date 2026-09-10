import { eq } from "drizzle-orm";
import { getDb, type DrizzleDb } from "../db/connection";
import { tenantHealthState } from "../db/schema";
import { getActiveUids } from "../repositories/recipient.repository";
import { checkHfmApiHealthy } from "../services/hfm.service";
import { pushToAll } from "../services/line.service";
import { listActiveTenants } from "../services/tenant-config.service";
import type { TenantConfig } from "../types/tenant.types";

const DOWN_MESSAGE =
  "⚠️ ขณะนี้ HFM API ขัดข้อง (ตรวจสอบจาก /api/wallet/balance) - ระบบจะแจ้งเตือนอีกครั้งเมื่อกลับมาใช้งานได้ตามปกติ";
const RECOVERED_MESSAGE = "✅ HFM API กลับมาใช้งานได้ตามปกติแล้ว";

export interface RunHfmHealthCheckOptions {
  db?: DrizzleDb;
  checkHealthyFn?: () => Promise<boolean>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  getUidsFn?: () => Promise<string[]>;
}

// Health state lives in tenant_health_state, not in a module variable, so a
// process restart while HFM is down no longer re-sends the alert, and so a
// future second process cannot double-alert. Baseline for a tenant with no
// row is "healthy": a first failed probe alerts, a first success stays quiet.
export async function getTenantHealthState(
  db: DrizzleDb,
  tenantId: number,
): Promise<boolean> {
  const rows = await db
    .select({ healthy: tenantHealthState.healthy })
    .from(tenantHealthState)
    .where(eq(tenantHealthState.tenantId, tenantId));
  return rows.length === 0 ? true : rows[0]!.healthy === 1;
}

async function setTenantHealthState(
  db: DrizzleDb,
  tenantId: number,
  healthy: boolean,
): Promise<void> {
  await db
    .insert(tenantHealthState)
    .values({ tenantId, healthy: healthy ? 1 : 0 })
    .onConflictDoUpdate({
      target: tenantHealthState.tenantId,
      set: { healthy: healthy ? 1 : 0, changedAt: new Date().toISOString() },
    });
}

export async function runHfmHealthCheckForTenant(
  ctx: TenantConfig,
  options: RunHfmHealthCheckOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const checkHealthy = options.checkHealthyFn ?? (() => checkHfmApiHealthy(ctx));
  const pushAll = options.pushToAllFn ?? ((uids, text) => pushToAll(ctx, uids, text));
  const getUids = options.getUidsFn ?? (() => getActiveUids(db, ctx.id));

  const healthy = await checkHealthy();
  // No state change => no notification (avoids spamming every 5 minutes).
  if (healthy === (await getTenantHealthState(db, ctx.id))) return;

  const uids = await getUids();
  if (uids.length === 0) {
    console.warn(`[cron] hfm-healthcheck: no recipients for tenant ${ctx.id}, skipping notify`);
    // Still persist the transition so an empty recipient list does not make
    // every tick re-run the resolution.
    await setTenantHealthState(db, ctx.id, healthy);
    return;
  }

  const message = healthy ? RECOVERED_MESSAGE : DOWN_MESSAGE;
  // Update state only after a successful push so a failed send retries next
  // tick.
  await pushAll(uids, message);
  await setTenantHealthState(db, ctx.id, healthy);
}

export async function runHfmHealthCheckAll(
  options: RunHfmHealthCheckOptions = {},
): Promise<void> {
  const tenants = await listActiveTenants();
  // Sequential on purpose: N parallel probes would fire N HFM requests at
  // once, and one tenant's slow failure must not delay the others' results.
  for (const ctx of tenants) {
    try {
      await runHfmHealthCheckForTenant(ctx, options);
    } catch (e) {
      console.error(`[cron] hfm-healthcheck failed for tenant ${ctx.id} (${ctx.label}):`, e);
    }
  }
}
