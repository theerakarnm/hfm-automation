import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { logger } from "./utils/logger";

// The Hono application lives here, separate from index.ts, so tests can
// import { app } without triggering any boot side effect (crons, cache
// warm, signal handlers). Building the app must stay side-effect free.
export function createApp(): Hono {
  const app = new Hono();

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

  return app;
}

export const app = createApp();
