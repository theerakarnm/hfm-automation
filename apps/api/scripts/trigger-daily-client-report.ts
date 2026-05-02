import { runDailyClientReport } from "../src/jobs/daily-client-report";

const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  console.log(`[trigger] daily-client-report starting (DRY_RUN=${DRY_RUN})`);

  const pushToAllFn = DRY_RUN
    ? async (uids: string[], text: string) => {
        console.log(`[dry-run] would push to ${uids.length} recipient(s):`);
        console.log("---");
        console.log(text);
        console.log("---");
      }
    : undefined;

  try {
    await runDailyClientReport({ pushToAllFn });
    console.log("[trigger] daily-client-report completed");
  } catch (e) {
    console.error("[trigger] daily-client-report failed:", e);
    process.exit(1);
  }
}

main();
