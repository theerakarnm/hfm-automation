import { runHfmHealthCheck, __resetHealthState } from "../src/jobs/hfm-healthcheck";
import { checkHfmApiHealthy } from "../src/services/hfm.service";
import { closeDb } from "../src/db/connection";

// FORCE=down | up — override the live probe to exercise the alert paths.
const FORCE = process.env.FORCE;
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  console.log(`[trigger] hfm-healthcheck starting (FORCE=${FORCE ?? "live"}, DRY_RUN=${DRY_RUN})`);

  const checkHealthyFn =
    FORCE === "down"
      ? async () => false
      : FORCE === "up"
        ? async () => true
        : undefined;

  if (!checkHealthyFn) {
    const live = await checkHfmApiHealthy();
    console.log(`[trigger] live probe: HFM API is ${live ? "UP" : "DOWN"}`);
  }

  const pushToAllFn = DRY_RUN
    ? async (uids: string[], text: string) => {
        console.log(`[dry-run] would push to ${uids.length} recipient(s):`);
        console.log("---");
        console.log(text);
        console.log("---");
      }
    : undefined;

  // The cron keeps state in memory across ticks; a one-shot trigger starts from
  // the "up" baseline so a forced "down" actually fires the down alert.
  __resetHealthState();

  try {
    await runHfmHealthCheck({ checkHealthyFn, pushToAllFn });
    console.log("[trigger] hfm-healthcheck completed");
  } catch (e) {
    console.error("[trigger] hfm-healthcheck failed:", e);
    await closeDb();
    process.exit(1);
  }
  await closeDb();
}

main();
