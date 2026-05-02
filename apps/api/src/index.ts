import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { registerJobs } from "./jobs";
import { logger } from "./utils/logger";
import { getDatabase, initSqlite, closeDatabase } from "./services/sqlite.service";

const app = new Hono();

const db = getDatabase();
initSqlite(db);

app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  logger.info({ method, path }, `${method} ${path}`);

  await next();

  const duration = Date.now() - start;
  logger.info(
    { method, path, status: c.res.status, duration },
    `${method} ${path} ${c.res.status} ${duration}ms`
  );
});

app.route("/webhook", webhook);
app.route("/internal", internal);

registerJobs();

function shutdown(signal: string): void {
  logger.info({ signal }, `Received ${signal}, shutting down gracefully`);
  closeDatabase();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
