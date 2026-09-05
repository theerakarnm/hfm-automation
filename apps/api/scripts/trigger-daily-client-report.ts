import { resolveTenants, parseArgs } from "./lib/resolve-tenant";
import { runDailyClientReport } from "../src/jobs/daily-client-report";
import { initDb, getDb } from "../src/db/connection";
import { loadEncryptionKey } from "../src/utils/crypto";

const DRY_RUN = process.env.DRY_RUN === "1";

loadEncryptionKey(); // fail fast
await initDb(getDb());
for (const ctx of await resolveTenants(parseArgs(process.argv))) {
  console.log(`[script] daily client report for "${ctx.label}" (tenant ${ctx.id})`);
  await runDailyClientReport(ctx, {
    // DRY_RUN prints the message instead of pushing it to LINE.
    pushToAllFn: DRY_RUN
      ? async (uids, text) => {
          console.log(`[dry-run] would push to ${uids.length} recipient(s):`);
          console.log("---");
          console.log(text);
          console.log("---");
        }
      : undefined,
  });
}
process.exit(0);
