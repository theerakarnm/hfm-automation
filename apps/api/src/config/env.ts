/**
 * The Worker's bindings, exactly as declared in wrangler.<tenant>.jsonc.
 * tests/tenant-config.test.ts checks every tenant file against the var names
 * listed here, so a key added here must be added to every tenant file.
 *
 * Code reads the string values through process.env, not through this object:
 * Cloudflare copies vars and secrets into process.env for compatibility dates
 * from 2025-04-01 on, and each tenant is its own Worker, so process.env only
 * ever holds one tenant's values. Only the non-string bindings at the bottom
 * must come from the handler's env argument.
 */
export interface WorkerEnv {
  // vars (plaintext, per tenant, in wrangler.<tenant>.jsonc)
  TENANT: string;
  HFM_API_BASE_URL: string;
  TARGET_WALLET: string;
  DEPOSIT_THRESHOLD_USD: string;
  DEPOSIT_THRESHOLD_USC: string;
  DEPOSIT_MATCH_RULE: string;
  LINE_WHITELIST_ENABLED: string;
  LINE_WHITELIST_UIDS: string;
  LINE_GROUP_WHITELIST_ENABLED: string;
  LINE_GROUP_WHITELIST_IDS: string;
  LINE_NOTIFY_UIDS: string;
  LAST_TRADE_DEADLINE_MS: string;
  FLEX_SUMMARY_VERSION: string;
  LOT_DISPLAY_MODE: string;
  LOG_LEVEL: string;

  // secrets (wrangler secret put <NAME> -c wrangler.<tenant>.jsonc)
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  HFM_API_KEY: string;
  INTERNAL_API_KEY: string;

  // bindings that are not strings and never appear in process.env
  HYPERDRIVE: Hyperdrive;
  CACHE: KVNamespace;
  EVENT_QUEUE: Queue<unknown>;
}

/**
 * Fails loudly if Cloudflare stopped copying bindings into process.env.
 * Without this, a changed compatibility flag would make every flag and secret
 * read return undefined: the whitelist would open up and LINE calls would go
 * out with an empty token, all without an error.
 */
export function assertProcessEnvPopulated(env: WorkerEnv): void {
  if (process.env.TENANT !== env.TENANT) {
    throw new Error(
      `process.env is not populated for tenant "${env.TENANT}". ` +
        "Check that the compatibility_date is 2025-04-01 or later and that " +
        "nodejs_compat_populate_process_env is not disabled.",
    );
  }
}
