import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This test is the guard against tenant config drift. One complete wrangler
// config per tenant means a missing `vars` key is not a deploy error, it is
// `undefined` at runtime in production. This file turns that silent failure
// into a red test.

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Every var key the WorkerEnv contract requires from wrangler `vars`. */
const REQUIRED_VAR_KEYS = [
  "TENANT",
  "HFM_API_BASE_URL",
  "TARGET_WALLET",
  "DEPOSIT_THRESHOLD_USD",
  "DEPOSIT_THRESHOLD_USC",
  "LINE_WHITELIST_ENABLED",
  "LINE_WHITELIST_UIDS",
  "LINE_GROUP_WHITELIST_ENABLED",
  "LINE_GROUP_WHITELIST_IDS",
  "LINE_NOTIFY_UIDS",
  "LAST_TRADE_DEADLINE_MS",
  "FLEX_SUMMARY_VERSION",
  "LOT_DISPLAY_MODE",
  "MATCH_RULE",
  "IDLE_ALERT_DAYS",
  "LOG_LEVEL",
] as const;

// An empty string is a meaningful value for these three only: an empty
// whitelist means "allow everyone" (src/utils/whitelist.ts:29-31) and an
// empty notify list means "no seeded recipients". Every other key must carry
// a real value.
const MAY_BE_EMPTY = new Set([
  "LINE_WHITELIST_UIDS",
  "LINE_GROUP_WHITELIST_IDS",
  "LINE_NOTIFY_UIDS",
]);

interface TenantConfig {
  name: string;
  main: string;
  compatibility_date: string;
  workers_dev: boolean;
  routes: Array<{ pattern: string; custom_domain?: boolean }>;
  triggers: { crons: string[] };
  vars: Record<string, string>;
  hyperdrive: Array<{ binding: string; id: string }>;
  kv_namespaces: Array<{ binding: string; id: string }>;
  queues: {
    producers: Array<{ binding: string; queue: string }>;
    consumers: Array<{
      queue: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
      max_concurrency?: number;
      dead_letter_queue?: string;
    }>;
  };
  secrets?: { required?: string[] };
}

/** Minimal JSONC reader: strips // and comments and trailing commas. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function loadTenantConfigs(): Array<{ file: string; cfg: TenantConfig }> {
  const glob = new Glob("wrangler.*.jsonc");
  const files = [...glob.scanSync({ cwd: APP_DIR, onlyFiles: true })].sort();
  return files.map((file) => ({
    file,
    cfg: parseJsonc(readFileSync(`${APP_DIR}${file}`, "utf8")) as TenantConfig,
  }));
}

const configs = loadTenantConfigs();

describe("wrangler tenant configs", () => {
  test("both tenant config files exist", () => {
    expect(configs.map((c) => c.file)).toEqual([
      "wrangler.maow.jsonc",
      "wrangler.simple-trade.jsonc",
    ]);
  });

  test("every tenant declares the identical set of vars keys", () => {
    const keySets = configs.map((c) => Object.keys(c.cfg.vars).sort().join(","));
    const first = keySets[0]!;
    for (let i = 0; i < configs.length; i++) {
      expect(`${configs[i]!.file}: ${keySets[i]}`).toBe(
        `${configs[i]!.file}: ${first}`,
      );
    }
  });

  test("every contract var key is present and non-empty", () => {
    for (const { file, cfg } of configs) {
      for (const key of REQUIRED_VAR_KEYS) {
        const value = cfg.vars[key];
        expect(`${file}:${key}=${typeof value}`).toBe(`${file}:${key}=string`);
        if (!MAY_BE_EMPTY.has(key)) {
          expect(`${file}:${key}:empty=${(value ?? "").trim().length === 0}`).toBe(
            `${file}:${key}:empty=false`,
          );
        }
      }
    }
  });

  test("vars carry no extra undeclared keys", () => {
    for (const { file, cfg } of configs) {
      const extra = Object.keys(cfg.vars).filter(
        (k) => !REQUIRED_VAR_KEYS.includes(k as (typeof REQUIRED_VAR_KEYS)[number]),
      );
      expect(`${file}: ${extra.join(",")}`).toBe(`${file}: `);
    }
  });

  test("worker name and route pattern are unique per tenant", () => {
    const names = configs.map((c) => c.cfg.name);
    expect(new Set(names).size).toBe(names.length);

    const patterns = configs.flatMap((c) => c.cfg.routes.map((r) => r.pattern));
    expect(new Set(patterns).size).toBe(patterns.length);

    for (const { file, cfg } of configs) {
      for (const route of cfg.routes) {
        expect(`${file} ${route.pattern} custom_domain=${route.custom_domain}`).toBe(
          `${file} ${route.pattern} custom_domain=true`,
        );
      }
    }
  });

  test("binding names are identical across tenants", () => {
    const shape = configs.map((c) =>
      [
        c.cfg.hyperdrive.map((h) => h.binding).join(","),
        c.cfg.kv_namespaces.map((k) => k.binding).join(","),
        c.cfg.queues.producers.map((q) => q.binding).join(","),
      ].join("|"),
    );
    const first = shape[0]!;
    for (let i = 0; i < configs.length; i++) {
      expect(`${configs[i]!.file}: ${shape[i]}`).toBe(
        `${configs[i]!.file}: ${first}`,
      );
    }
    expect(first).toBe("HYPERDRIVE|CACHE|EVENT_QUEUE");
  });

  test("hyperdrive id, kv id and queue name are unique per tenant", () => {
    const hyperdriveIds = configs.flatMap((c) => c.cfg.hyperdrive.map((h) => h.id));
    expect(new Set(hyperdriveIds).size).toBe(hyperdriveIds.length);

    const kvIds = configs.flatMap((c) => c.cfg.kv_namespaces.map((k) => k.id));
    expect(new Set(kvIds).size).toBe(kvIds.length);

    const queues = configs.flatMap((c) => c.cfg.queues.producers.map((q) => q.queue));
    expect(new Set(queues).size).toBe(queues.length);
  });

  test("each producer queue has a matching consumer in the same file", () => {
    for (const { file, cfg } of configs) {
      const consumed = cfg.queues.consumers.map((q) => q.queue).sort().join(",");
      const produced = cfg.queues.producers.map((q) => q.queue).sort().join(",");
      expect(`${file}: ${consumed}`).toBe(`${file}: ${produced}`);
    }
  });

  test("no vars value is an unresolved placeholder", () => {
    // Infra ids (hyperdrive, kv, queue) may stay as <PLACEHOLDER> until the
    // create commands have run - a wrong id fails loudly at deploy time.
    // A wrong flag value fails silently in production, so vars must be real.
    for (const { file, cfg } of configs) {
      for (const [key, value] of Object.entries(cfg.vars)) {
        const unresolved =
          value.includes("<") || value.includes(">") || value.startsWith("REPLACE_WITH");
        expect(`${file}:${key} unresolved=${unresolved}`).toBe(
          `${file}:${key} unresolved=false`,
        );
      }
    }
  });

  test("TARGET_WALLET is a plain wallet number", () => {
    for (const { file, cfg } of configs) {
      expect(`${file}: ${cfg.vars.TARGET_WALLET}`).toMatch(/: [0-9]+$/);
    }
  });

  test("every tenant declares the same required secrets", () => {
    const required = configs.map((c) => (c.cfg.secrets?.required ?? []).slice().sort().join(","));
    const first = required[0]!;
    for (let i = 0; i < configs.length; i++) {
      expect(`${configs[i]!.file}: ${required[i]}`).toBe(`${configs[i]!.file}: ${first}`);
    }
    expect(first).toBe(
      "HFM_API_KEY,INTERNAL_API_KEY,LINE_CHANNEL_ACCESS_TOKEN,LINE_CHANNEL_SECRET",
    );
  });

  test("FLEX_SUMMARY_VERSION is flex-v1 or flex-v2", () => {
    for (const { file, cfg } of configs) {
      expect(`${file}: ${cfg.vars.FLEX_SUMMARY_VERSION}`).toMatch(
        /: flex-v[12]$/,
      );
    }
  });

  test("TENANT matches the file name", () => {
    for (const { file, cfg } of configs) {
      const fromFile = file.replace(/^wrangler\./, "").replace(/\.jsonc$/, "");
      expect(`${file}: ${cfg.vars.TENANT}`).toBe(`${file}: ${fromFile}`);
    }
  });

  test("workers_dev is false so the *.workers.dev URL is not a second webhook", () => {
    for (const { file, cfg } of configs) {
      expect(`${file}: ${cfg.workers_dev}`).toBe(`${file}: false`);
    }
  });

  test("queue consumers take one event at a time and never retry", () => {
    // max_batch_size 1: a batch is handled sequentially, so with a bigger batch
    // a slow lookup makes the next customer's 60s reply token expire.
    // max_retries 0: a retry can reuse a spent reply token, and replyOrPush
    // then pushes a duplicate answer (billed per member in a group).
    // No max_concurrency: the cap would queue lookups behind each other.
    for (const { file, cfg } of configs) {
      for (const consumer of cfg.queues.consumers) {
        const settings = [
          `batch=${consumer.max_batch_size}`,
          `timeout=${consumer.max_batch_timeout}`,
          `retries=${consumer.max_retries}`,
          `concurrency=${consumer.max_concurrency}`,
          `dlq=${consumer.dead_letter_queue === `${consumer.queue}-dlq`}`,
        ].join(" ");
        expect(`${file}: ${settings}`).toBe(
          `${file}: batch=1 timeout=0 retries=0 concurrency=undefined dlq=true`,
        );
      }
    }
  });

  test("shared keys have not drifted between tenant files", () => {
    const shared = configs.map((c) =>
      [c.cfg.main, c.cfg.compatibility_date, c.cfg.triggers.crons.join(";")].join("|"),
    );
    const first = shared[0]!;
    for (let i = 0; i < configs.length; i++) {
      expect(`${configs[i]!.file}: ${shared[i]}`).toBe(
        `${configs[i]!.file}: ${first}`,
      );
    }
    // The 5 minute health check and the 00:30 Bangkok (17:30 UTC) daily scan.
    // The daily client report cron was removed on purpose in commit 96e6a0e
    // and must not come back through a tenant config.
    expect(first).toBe("./src/worker.ts|2026-09-22|*/5 * * * *;30 17 * * *");
  });
});
