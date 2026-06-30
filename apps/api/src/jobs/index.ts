import { Cron } from "croner";
import { runHfmHealthCheck } from "./hfm-healthcheck";

export function registerJobs(): void {
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
