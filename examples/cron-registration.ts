import { Cron } from "croner";
import { runDailyClientReport } from "../src/jobs/daily-client-report";

export function registerJobs() {
  new Cron("0 5 * * *", { timezone: "Asia/Bangkok", protect: true }, async () => {
    console.log("[cron] daily-client-report started");
    await runDailyClientReport();
  });
}
