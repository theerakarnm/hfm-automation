import { registerJobs } from "./jobs";
import { logger, logError } from "./utils/logger";
import { getLastTradeMap } from "./services/last-trade.service";
import { listActiveTenants } from "./services/tenant-config.service";
import { loadEncryptionKey } from "./utils/crypto";
import { getDb, initDb, closeDb } from "./db/connection";
import { createApp } from "./app";

// Fail fast: a process that cannot decrypt its tenants is not servable.
let encryptionKey: Buffer;
try {
  encryptionKey = loadEncryptionKey();
} catch (err) {
  console.error(String(err));
  process.exit(1);
}

const db = getDb();
await initDb(db); // creates tables, seeds the first tenant, migrates legacy rows

registerJobs();

const app = createApp();

// Warm every tenant sequentially. Each warm costs one ~7.4s HFM call with
// that tenant's own key; firing them in parallel would burst the upstream
// and blur whose cache failed. A small gap spreads the load.
(async () => {
  for (const ctx of await listActiveTenants()) {
    try {
      const map = await getLastTradeMap(ctx);
      logger.info(
        { tenantId: ctx.id, label: ctx.label, size: map?.size ?? 0 },
        "[startup] last-trade cache warmed",
      );
    } catch (err) {
      logError("startup-warm", err);
    }
    await Bun.sleep(500);
  }
})();

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
