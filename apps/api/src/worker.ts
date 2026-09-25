import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { handleQueueBatch } from "./queue/consumer";
import { dispatchCron } from "./jobs";
import { assertProcessEnvPopulated, type WorkerEnv } from "./config/env";
import { openDb, runWithDb } from "./db/connection";
import { runWithCache } from "./cache/kv";
import { logInfo } from "./utils/logger";
import type { QueueMessage } from "./queue/types";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  // One line per request. Ids and durations only: Workers Logs caps a request
  // at 256 KB of log data, and a payload dump would truncate the tail.
  logInfo(
    "http",
    { method, path, status: c.res.status, durationMs: Date.now() - start },
    `${method} ${path} ${c.res.status}`,
  );
});

app.route("/webhook", webhook);
app.route("/internal", internal);

/**
 * Puts the non-string bindings (database handle, KV cache) in scope for one
 * invocation. Flags and secrets need no scope: they are read from process.env,
 * which Cloudflare fills per Worker, and each tenant is its own Worker.
 * The connection teardown goes to waitUntil so it never delays the response.
 */
async function withScope<T>(
  env: WorkerEnv,
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  assertProcessEnvPopulated(env);
  const handle = openDb(env.HYPERDRIVE.connectionString);
  try {
    return await runWithDb(handle, () => runWithCache(env.CACHE, fn));
  } finally {
    ctx.waitUntil(handle.dispose());
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return withScope(env, ctx, async () => app.fetch(request, env, ctx));
  },

  // LINE records a request_timeout after 2s, so the webhook route only
  // enqueues. All the slow work lands here with a 15 minute wall budget.
  async queue(
    batch: MessageBatch<QueueMessage>,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    await withScope(env, ctx, () => handleQueueBatch(batch));
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    await withScope(env, ctx, () => dispatchCron(controller.cron));
  },
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
