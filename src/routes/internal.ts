import { Hono } from "hono";
import { readLog, parseLog, listLogDates } from "../utils/logger";
import { getDatabase } from "../services/sqlite.service";
import { listLineUsers } from "../repositories/line-user.repository";

const internal = new Hono();

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
    const db = getDatabase();
    db.query("SELECT 1").get();
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

internal.get("/logs", async (c) => {
  const dates = listLogDates();
  return c.json({ dates });
});

internal.get("/logs/:date", async (c) => {
  const date = c.req.param("date");
  const content = readLog(date);
  if (!content) {
    return c.json({ error: "No logs found for this date" }, 404);
  }
  const entries = parseLog(content);
  return c.json({ date, entries });
});

internal.get("/line-uids", async (c) => {
  const db = getDatabase();
  const users = listLineUsers(db);
  return c.json({
    count: users.length,
    uids: users.map((u) => u.line_uid),
    users,
  });
});

export default internal;
