import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { listLineUsers } from "../repositories/line-user.repository";
import { listLineGroups } from "../repositories/line-group.repository";

const internal = new Hono();

const MAX_LINE_UIDS = 500;
const MAX_LINE_GROUPS = 200;

internal.use("*", async (c, next) => {
  const key = c.req.query("key");
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

internal.get("/health", async (c) => {
  const checks: Record<string, "ok" | "error"> = {};

  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  try {
    const baseUrl =
      process.env.HFM_API_BASE_URL ?? "https://api.hfaffiliates.com";
    const res = await fetch(`${baseUrl}/api/wallet/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
    checks.hfm_api = res.ok ? "ok" : "error";
  } catch {
    checks.hfm_api = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");
  return c.json({ status: allOk ? "healthy" : "unhealthy", checks }, allOk ? 200 : 503);
});

internal.get("/line-uids", async (c) => {
  const db = getDb();
  const users = await listLineUsers(db);
  const truncated = users.length > MAX_LINE_UIDS;
  return c.json({
    count: Math.min(users.length, MAX_LINE_UIDS),
    truncated,
    uids: users.slice(0, MAX_LINE_UIDS).map((u) => u.line_uid),
    users: users.slice(0, MAX_LINE_UIDS),
  });
});

// Operator lookup: a group ID is not visible anywhere in the LINE app, and
// LINE_GROUP_WHITELIST_IDS needs it.
internal.get("/line-groups", async (c) => {
  const db = getDb();
  const groups = await listLineGroups(db);
  const truncated = groups.length > MAX_LINE_GROUPS;
  return c.json({
    count: Math.min(groups.length, MAX_LINE_GROUPS),
    truncated,
    groups: groups.slice(0, MAX_LINE_GROUPS),
  });
});

export default internal;
