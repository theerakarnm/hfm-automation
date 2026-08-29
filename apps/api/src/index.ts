import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { registerJobs } from "./jobs";
import { logger, logError } from "./utils/logger";
import { getLastTradeMap } from "./services/last-trade.service";
import { getDb, initDb, closeDb } from "./db/connection";

const app = new Hono();

const db = getDb();
await initDb(db);

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

// Warm the last-trade cache so the first customer lookup does not pay the
// ~7s /api/clients/ round trip.
getLastTradeMap()
  .then((map) =>
    logger.info({ size: map?.size ?? 0 }, "[startup] last-trade cache warmed"),
  )
  .catch((err) => logError("startup-warm", err));

function shutdown(signal: string): void {
  logger.info({ signal }, `Received ${signal}, shutting down gracefully`);
  closeDb().then(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
