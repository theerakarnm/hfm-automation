import { Cron } from "croner";
import { runDailyClientReport } from "./daily-client-report";
import { runHfmHealthCheck } from "./hfm-healthcheck";

export function registerJobs(): void {
  new Cron(
    "0 5 * * *",
    { timezone: "Asia/Bangkok", protect: true },
    async () => {
      console.log("[cron] daily-client-report started");
      try {
        await runDailyClientReport();
        console.log("[cron] daily-client-report completed");
      } catch (e) {
        console.error("[cron] daily-client-report failed:", e);
      }
    }
  );
  console.log("[cron] daily-client-report registered (05:00 ICT)");

  new Cron(
    "*/5 * * * *",
    { timezone: "Asia/Bangkok", protect: true },
    async () => {
      try {
        await runHfmHealthCheck();
      } catch (e) {
        console.error("[cron] hfm-healthcheck failed:", e);
      }
    }
  );
  console.log("[cron] hfm-healthcheck registered (every 5 min)");
}
