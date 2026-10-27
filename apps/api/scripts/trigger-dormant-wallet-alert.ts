import { runDormantWalletAlert } from "../src/jobs/dormant-wallet-alert";
import { closeDb } from "../src/db/connection";

// DRY_RUN=1 prints the messages instead of pushing them and does not mark any
// wallet as alerted, so the real cron still sends them. The wallet_activity
// sync itself does run: it only copies HFM data.
const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  console.log(`[trigger] dormant-wallet-alert starting (DRY_RUN=${DRY_RUN})`);
  try {
    await runDormantWalletAlert(
      DRY_RUN
        ? {
            pushToAllFn: async (uids, text) => {
              console.log(`[dry-run] would push to ${uids.length} recipient(s):`);
              console.log(`---\n${text}\n---`);
            },
            markAlertedFn: async (_db, walletIds) => {
              console.log(`[dry-run] would mark ${walletIds.length} wallet(s) as alerted`);
            },
          }
        : {},
    );
    console.log("[trigger] dormant-wallet-alert completed");
  } catch (e) {
    console.error("[trigger] dormant-wallet-alert failed:", e);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main();
