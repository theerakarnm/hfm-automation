import { runDormantWalletAlert } from "./dormant-wallet-alert";
import { runHfmHealthCheck } from "./hfm-healthcheck";
import { refreshLastTradeCache } from "../services/last-trade.service";
import { purgeEventClaims } from "../db/state.repository";
import { getDb } from "../db/connection";
import { logError, logInfo } from "../utils/logger";

/**
 * Cloudflare cron triggers are UTC only. Changing a cron string here also
 * means changing triggers.crons in every wrangler.<tenant>.jsonc, and a deploy
 * replaces the whole trigger set for that Worker.
 *
 * The daily client report is deliberately not scheduled: its cron was removed
 * in commit 96e6a0e. Run it by hand with `bun run trigger:daily-client-report`.
 */
export const CRON_JOBS = {
  // Every 5 minutes. Interval independent of timezone.
  "*/5 * * * *": "hfm-healthcheck",
  // 02:00 UTC = 09:00 ICT, once a day at the start of the working day.
  "0 2 * * *": "dormant-wallet-alert",
} as const;

export type CronJobName = (typeof CRON_JOBS)[keyof typeof CRON_JOBS];

export function cronJobName(cron: string): CronJobName | null {
  return CRON_JOBS[cron as keyof typeof CRON_JOBS] ?? null;
}

// LINE event claims only need to outlive queue redelivery, which is minutes.
const EVENT_CLAIM_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

// Each step has its own try: a failed LINE alert in the health check must not
// skip the last-trade refresh, or the KV map goes stale and customer replies
// fall back to the ~7s live HFM call.
async function runStep(step: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    logInfo("cron", { step, durationMs: Date.now() - started }, "cron step finished");
  } catch (err) {
    logError(`cron:${step}`, err);
  }
}

export async function dispatchCron(cron: string): Promise<void> {
  const name = cronJobName(cron);
  if (!name) {
    logError("cron", `no job registered for schedule "${cron}"`);
    return;
  }

  if (name === "dormant-wallet-alert") {
    await runStep("dormant-wallet-alert", () => runDormantWalletAlert());
    return;
  }

  await runStep("hfm-healthcheck", () => runHfmHealthCheck());
  // New upstream load compared with the VPS: /api/clients/ is now called every
  // 5 minutes per tenant (288 calls a day, ~7s each when healthy) instead of
  // only when a lookup found the cache older than 5 minutes. That is the price
  // of keeping the customer reply path off the live call.
  await runStep("last-trade-refresh", () => refreshLastTradeCache());
  await runStep("event-claim-purge", () =>
    purgeEventClaims(getDb(), EVENT_CLAIM_RETENTION_MS),
  );
}
