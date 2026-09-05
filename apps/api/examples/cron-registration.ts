import { Cron } from "croner";
import { runDailyClientReport } from "../src/jobs/daily-client-report";
import { listActiveTenants } from "../src/services/tenant-config.service";

export function registerJobs() {
  new Cron("0 5 * * *", { timezone: "Asia/Bangkok", protect: true }, async () => {
    console.log("[cron] daily-client-report started");
    for (const ctx of await listActiveTenants()) {
      await runDailyClientReport(ctx);
    }
  });
}
