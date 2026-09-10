import { resolveTenants, parseArgs } from "./lib/resolve-tenant";
import { runHfmHealthCheckForTenant } from "../src/jobs/hfm-healthcheck";
import { initDb, getDb } from "../src/db/connection";
import { loadEncryptionKey } from "../src/utils/crypto";

// FORCE=down | up — override the live probe to exercise the alert paths.
const FORCE = process.env.FORCE;
const DRY_RUN = process.env.DRY_RUN === "1";

const checkHealthyFn =
  FORCE === "down"
    ? async () => false
    : FORCE === "up"
      ? async () => true
      : undefined;

const pushToAllFn = DRY_RUN
  ? async (uids: string[], text: string) => {
      console.log(`[dry-run] would push to ${uids.length} recipient(s):`);
      console.log("---");
      console.log(text);
      console.log("---");
    }
  : undefined;

loadEncryptionKey(); // fail fast
await initDb(getDb());
for (const ctx of await resolveTenants(parseArgs(process.argv))) {
  console.log(`[script] hfm healthcheck for "${ctx.label}" (tenant ${ctx.id})`);
  // Health state lives in tenant_health_state now, so a one-shot trigger
  // no longer resets an in-memory baseline before forcing a transition.
  await runHfmHealthCheckForTenant(ctx, { checkHealthyFn, pushToAllFn });
}
process.exit(0);
