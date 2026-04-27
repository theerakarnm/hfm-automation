import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { registerJobs } from "./jobs";
import { logger } from "./utils/logger";

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

registerJobs();

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
