import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { sql } from "drizzle-orm";
import { readLog, parseLog, listLogDates } from "../utils/logger";
import { getDb } from "../db/connection";
import { tenantHealthState } from "../db/schema";
import { listTenantRows } from "../repositories/tenant.repository";
import { listLineUsers } from "../repositories/line-user.repository";
import { internalAuthRoutes, verifySession, COOKIE_NAME } from "./internal-auth";
import type { Context, Next } from "hono";

const internal = new Hono();

const MAX_LOG_ENTRIES = 200;
const MAX_LINE_UIDS = 500;

// Machine-readable JSON endpoints keep the ?key= mechanism because the docker
// healthcheck and existing tooling depend on it. A valid admin cookie is
// accepted as an alternative, so a signed-in operator can open these in a
// browser. UI routes (/internal/login, /internal/config*) never accept ?key=:
// they edit real channel tokens and use the cookie session instead.
const requireMachineCredential = async (c: Context, next: Next) => {
  const key = c.req.query("key");
  const keyOk = !!key && key === process.env.INTERNAL_API_KEY;
  const cookieOk = verifySession(getCookie(c, COOKIE_NAME)) !== null;
  if (!keyOk && !cookieOk) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

internal.use("/health", requireMachineCredential);
internal.use("/health/*", requireMachineCredential);
internal.use("/logs", requireMachineCredential);
internal.use("/logs/*", requireMachineCredential);
internal.use("/line-uids", requireMachineCredential);

internal.get("/health", async (c) => {
  // Liveness only. The docker healthcheck uses this endpoint with
  // restart=unless-stopped, so an HFM outage must NOT mark the container
  // unhealthy: that would restart the bot in a loop and drop the warm cache
  // every restart. Upstream status lives in /internal/health/tenants.
  const checks: Record<string, "ok" | "error"> = {};
  try {
    await getDb().execute(sql`SELECT 1`);
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }
  const allOk = Object.values(checks).every((v) => v === "ok");
  return c.json({ status: allOk ? "healthy" : "unhealthy", checks }, allOk ? 200 : 503);
});

internal.get("/health/tenants", async (c) => {
  const db = getDb();
  const rows = await db.select().from(tenantHealthState);
  const tenants = await listTenantRows(db);
  return c.json({
    tenants: tenants.map((t) => ({
      id: t.id,
      label: t.label,
      active: t.active === 1,
      healthy: rows.find((r) => r.tenantId === t.id)?.healthy ?? 1,
      changedAt: rows.find((r) => r.tenantId === t.id)?.changedAt ?? null,
    })),
  });
});

internal.get("/logs", async (c) => {
  const dates = listLogDates();
  return c.json({ dates });
});

internal.get("/logs/:date", async (c) => {
  const date = c.req.param("date");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Number(limitParam) || MAX_LOG_ENTRIES,
    MAX_LOG_ENTRIES
  );
  const content = readLog(date);
  if (!content) {
    return c.json({ error: "No logs found for this date" }, 404);
  }
  const entries = parseLog(content, limit);
  return c.json({ date, entries });
});

internal.get("/line-uids", async (c) => {
  const db = getDb();
  const selector = c.req.query("tenant");
  if (selector) {
    const rows = await listTenantRows(db);
    const asNumber = Number(selector);
    const row = Number.isInteger(asNumber) && asNumber > 0
      ? rows.find((r) => r.id === asNumber)
      : rows.find((r) => r.webhookId === selector || r.label === selector);
    if (!row) return c.json({ error: "Unknown tenant" }, 404);
    const users = await listLineUsers(db, row.id);
    return c.json({
      tenant: { id: row.id, label: row.label },
      count: Math.min(users.length, MAX_LINE_UIDS),
      truncated: users.length > MAX_LINE_UIDS,
      uids: users.slice(0, MAX_LINE_UIDS).map((u) => u.line_uid),
      users: users.slice(0, MAX_LINE_UIDS),
    });
  }
  const tenants = await listTenantRows(db);
  const all = await Promise.all(
    tenants.map(async (t) => ({
      tenant: { id: t.id, label: t.label },
      users: (await listLineUsers(db, t.id)).slice(0, MAX_LINE_UIDS),
    })),
  );
  return c.json({ tenants: all });
});

// Login and logout pages must stay reachable without any credential, so they
// are mounted outside the requireMachineCredential scope above. The admin
// pages added by later tasks mount here behind requireAdmin.
internal.route("/", internalAuthRoutes);

export default internal;
