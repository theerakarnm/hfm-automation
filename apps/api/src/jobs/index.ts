import { Cron } from "croner";
import { runHfmHealthCheckAll } from "./hfm-healthcheck";
import { runDailyClientReport } from "./daily-client-report";
import { listActiveTenants } from "../services/tenant-config.service";
import { logError } from "../utils/logger";

// Per-tenant timeout so one stuck HFM call cannot block the other tenants'
// reports. Generous because fetchClients can legitimately take ~48s.
const REPORT_TIMEOUT_MS = 120_000;

export function registerJobs(): void {
  new Cron(
    "*/5 * * * *",
    { timezone: "Asia/Bangkok", protect: true },
    async () => {
      try {
        await runHfmHealthCheckAll();
      } catch (e) {
        logError("cron", e);
      }
    },
  );
  console.log("[cron] hfm-healthcheck registered (every 5 min, all tenants)");

  new Cron(
    "0 5 * * *",
    { timezone: "Asia/Bangkok", protect: true },
    async () => {
      // Sequential on purpose: parallel HFM calls for N tenants would burst
      // and one stuck tenant must not block the rest.
      for (const ctx of await listActiveTenants()) {
        try {
          await Promise.race([
            runDailyClientReport(ctx),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`report timeout for tenant ${ctx.id}`)), REPORT_TIMEOUT_MS),
            ),
          ]);
        } catch (e) {
          logError("cron", e);
        }
      }
    },
  );
  console.log("[cron] daily-client-report registered (05:00 ICT, all tenants)");
}
