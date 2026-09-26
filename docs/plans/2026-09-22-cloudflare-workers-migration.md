# Cloudflare Workers Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use subagent-driven development (recommended) or inline plan execution to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/api` from a single Docker container on a VPS to per-tenant Cloudflare Workers, so each client (`maow`, `simple-trade`) gets its own Worker, its own database, and its own feature-flag values from one shared codebase.

**Architecture:** The LINE webhook Worker only verifies the signature and enqueues events, because LINE times a webhook out after 2 seconds and `ctx.waitUntil` is capped at 30 seconds. A Cloudflare Queue consumer does all slow HFM and LINE work inside a 15 minute budget. `croner` becomes Cron Triggers, PostgreSQL goes through Hyperdrive, and the warm in-process cache moves to Workers KV. Flags and secrets stay in `process.env`, which Cloudflare fills per Worker, so the 39 existing reads do not change. Each tenant is a complete standalone `wrangler.<tenant>.jsonc` file deployed with `wrangler deploy -c`.

**Tech Stack:** Cloudflare Workers, Wrangler 4, Hono 4, Cloudflare Queues, Workers KV, Hyperdrive, Drizzle ORM + postgres.js, Bun (build and test only), TypeScript strict.

---

## Why this is not a lift-and-shift

Three verified facts force real design changes. Do not skip this section.

| Fact | Source | Consequence |
| --- | --- | --- |
| LINE times out a webhook after **2 seconds** | [LINE webhook error statistics](https://developers.line.biz/en/docs/messaging-api/check-webhook-error-statistics/#check-error-reason), reason `request_timeout` | The handler cannot do the HFM work inline. |
| `ctx.waitUntil` is capped at **30 seconds** after the response | [Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) | "ACK then finish in the background" silently drops replies on a slow HFM day. |
| Isolates are created and evicted at any time | [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/) | Every module-level cache and flag in `src/` is unreliable. |

This plan was reviewed after its first draft. Appendix D lists what the review changed and why.

Today `src/routes/webhook.ts:205-274` returns `200 OK` and leaves the event handlers running as floating promises. Bun keeps the process alive so this works. On Workers the isolate can be torn down the moment the response is returned, so this exact pattern loses customer replies. Cloudflare Queues is the fix: the producer ACKs in milliseconds, the consumer gets 15 minutes.

## Research inputs

Three research files back this plan. Read them when a step needs more detail.

- `docs/research/cf-workers-migration-facts.md` - verified Cloudflare platform facts with documentation URLs.
- `docs/research/api-workers-compat-inventory.md` - file-by-file Workers-incompatibility inventory with line numbers.
- `docs/research/root-agent-findings.md` - the 13 blockers found by direct reading.

## File structure

| Path | Responsibility |
| --- | --- |
| `src/worker.ts` | NEW. The only entrypoint. `export default { fetch, scheduled, queue }`. |
| `src/config/env.ts` | NEW. `WorkerEnv` binding types and `assertProcessEnvPopulated()`. |
| `src/cache/kv.ts` | NEW. AsyncLocalStorage scope for the KV binding (`runWithCache`, `getCache`). |
| `src/queue/types.ts` | NEW. Queue message envelope. |
| `src/queue/consumer.ts` | NEW. Queue consumer: one LINE event to one reply. |
| `src/services/webhook-dispatcher.ts` | NEW. Event-processing logic moved out of `src/routes/webhook.ts`, so the route stays thin per the repo layering rule. |
| `src/routes/webhook.ts` | SHRINKS to signature check, parse, enqueue, 200. |
| `src/routes/internal.ts` | Loses the two log-file endpoints. |
| `src/utils/logger.ts` | REWRITE. JSON `console.log` logger, no pino, no `node:fs`. |
| `src/db/connection.ts` | REWRITE. Per-invocation client from the Hyperdrive binding. |
| `src/db/state.repository.ts` | NEW. Durable job state (replaces module-level flags) and LINE event claims (answer each event once). |
| `src/jobs/index.ts` | REWRITE. `dispatchCron(cron)` instead of croner registration. Only the 5 minute job is scheduled. |
| `src/index.ts` | DELETED at the end. |
| `wrangler.maow.jsonc`, `wrangler.simple-trade.jsonc` | NEW. One complete spec per tenant. |
| `tests/tenant-config.test.ts` | NEW. Guards against tenant config drift. |

## Task order and dependencies

```
Task 1  toolchain + binding types -> everything depends on it
Task 2  webhook split              -> needs Task 1
Task 3  logger                     -> needs Task 1
Task 4  database / Hyperdrive      -> needs Task 1
Task 5  durable state + dedupe     -> needs Tasks 2 and 4
Task 6  worker entrypoint          -> needs Tasks 1-5
Task 7  runtime API fixes          -> independent, can run any time after Task 1
Task 8  tenant configs             -> needs Task 6
Task 9  scripts and tooling        -> needs Task 8
Task 10 cutover                    -> needs everything
```

Tasks 1 to 7 keep `bun test` green the whole way. Nothing deploys until Task 8.

---

## Task 1: Workers toolchain and the binding contract

This task installs the Cloudflare toolchain and types the Worker bindings. It does not touch
any existing `process.env` read.

### Why the 39 `process.env` reads stay as they are

Cloudflare fills `process.env` with the Worker's `vars` **and secrets** when
`nodejs_compat_populate_process_env` is on. That flag is on by default for compatibility dates
from 2025-04-01 on, and this plan uses `2026-09-22`
([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/#processenv)).

Each tenant is its own Worker, so inside one Worker `process.env` only ever holds that tenant's
values. Nothing can leak between tenants.

The current code already reads `process.env` per call, not at module load (see the
"Read per call" comments at `src/services/hfm.service.ts:64` and
`src/builders/flex-message.builder.ts:31`), so no read is frozen at the wrong moment.

So the reads stay unchanged. This also keeps all 141 `process.env.X = ...` assignments in
`tests/` working with no change.

Only the bindings that are not strings (`HYPERDRIVE`, `CACHE`, `EVENT_QUEUE`) must come from the
handler's `env` argument. Tasks 4, 5 and 6 pass them through an AsyncLocalStorage scope.

One risk remains: if the populate flag were ever turned off, every read would silently return
`undefined`. `assertProcessEnvPopulated()` below turns that into a loud failure on the first
request. Task 6 calls it in every handler.

**Files:**
- Modify: `apps/api/package.json` (devDependencies)
- Modify: `apps/api/tsconfig.json` (full replacement)
- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/tests/worker-env.test.ts`

- [x] **Step 1: Install the Cloudflare toolchain**

```bash
cd apps/api
bun add -d wrangler@4.136.2 @cloudflare/workers-types@5.20260922.1
```

Expected: `installed wrangler@4.136.2 with binaries: - wrangler` and
`installed @cloudflare/workers-types@5.20260922.1`.

The `devDependencies` block in `apps/api/package.json` must then read exactly:

```json
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260922.1",
    "@types/bun": "latest",
    "drizzle-kit": "^0.31.10",
    "wrangler": "^4.136.2"
  },
```

> Deviation: `bun add` saved the two new deps as exact pins (`5.20260922.1`, `4.136.2`, no caret), so the carets were added by hand to match this block; `bun install` afterwards confirms the lockfile already satisfies the caret ranges ("no changes").

- [x] **Step 2: Replace `apps/api/tsconfig.json` with the Workers-aware version**

The current file has no `types` key, so TypeScript knows nothing about `Hyperdrive`,
`KVNamespace`, `Queue`, `MessageBatch`, `ExecutionContext` or `ScheduledController`.
Setting `types` turns automatic `@types` inclusion off, so both entries must be listed.

Replace the whole file with:

```jsonc
{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,

    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    // Workers runtime globals (Hyperdrive, KVNamespace, Queue, ExecutionContext,
    // ScheduledController) plus the Bun globals the test suite still needs.
    // Both must be listed: setting "types" turns off automatic @types inclusion.
    "types": ["@cloudflare/workers-types", "bun"],

    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
```

This combination was verified on TypeScript 5.9.3 with `@cloudflare/workers-types@5.20260922.1`
and `@types/bun@1.4.2`: Workers globals and `bun:test` compile together with no duplicate-global
errors.

> Deviation: against this repo the exact tsconfig above does not typecheck on its own: workers-types 5.20260922.1 re-declares the web platform globally (`class Blob`, `declare const Buffer: any`, ...), and under `skipLibCheck` the silent merges drop `Blob.json`/`Blob.formData`/`Blob.image` and collapse `Buffer.toString` to zero args (6 errors in scripts/ and src/utils/logger.ts). Fixed forward with one additive ambient file, `apps/api/src/types/workers-types-compat.d.ts`, which restores exactly those bun-types members; the tsconfig above is unchanged. The lockfile resolution of the floating `"@types/bun": "latest"` entry was also refreshed 1.3.13 -> 1.4.2 (the version this step cites); package.json is unchanged.

- [x] **Step 3: Run the typecheck and the suite**

Start the test database first, from the repo root:

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
docker compose up -d postgres-test
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
cd apps/api && bun run typecheck && bun test
```

Expected: typecheck exits 0 and every test passes. Nothing uses the new types yet, so this
proves the tsconfig change alone breaks nothing.

- [x] **Step 4: Commit**

```bash
git add apps/api/package.json apps/api/bun.lock apps/api/tsconfig.json
git commit -m "chore: add wrangler and Workers types"
```

- [x] **Step 5: Write the failing test**

Create `apps/api/tests/worker-env.test.ts`:

```ts
import { test, expect, afterEach } from "bun:test";
import { assertProcessEnvPopulated, type WorkerEnv } from "../src/config/env";

const originalTenant = process.env.TENANT;

afterEach(() => {
  if (originalTenant === undefined) delete process.env.TENANT;
  else process.env.TENANT = originalTenant;
});

test("passes when process.env mirrors the bindings", () => {
  process.env.TENANT = "maow";
  expect(() =>
    assertProcessEnvPopulated({ TENANT: "maow" } as WorkerEnv),
  ).not.toThrow();
});

test("throws when process.env is empty", () => {
  delete process.env.TENANT;
  expect(() =>
    assertProcessEnvPopulated({ TENANT: "maow" } as WorkerEnv),
  ).toThrow("process.env is not populated");
});

test("throws when process.env holds another tenant", () => {
  process.env.TENANT = "simple-trade";
  expect(() =>
    assertProcessEnvPopulated({ TENANT: "maow" } as WorkerEnv),
  ).toThrow("process.env is not populated");
});
```

- [x] **Step 6: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/worker-env.test.ts
```

Expected: FAIL with `Cannot find module '../src/config/env'`.

- [x] **Step 7: Write the binding contract**

Create `apps/api/src/config/env.ts`:

```ts
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
```

- [x] **Step 8: Run the test to verify it passes**

```bash
cd apps/api && bun test tests/worker-env.test.ts && bun run typecheck
```

Expected: PASS, 3 tests, and typecheck exits 0.

- [x] **Step 9: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/tests/worker-env.test.ts
git commit -m "feat: type the Worker bindings"
```

---

## Task 2: Split the webhook into a producer route and a queue consumer

This task removes the single highest-risk defect in the migration.

`src/routes/webhook.ts:205-274` loops over the events, starts `processTextEvent(...)`,
`processPostbackEvent(...)`, `processJoinEvent(...)` and `processLeaveEvent(...)` as
floating promises, then returns `200 OK`. On Bun the process stays alive and the work
finishes. On Cloudflare Workers the isolate can be destroyed once the response is
returned, so those replies are silently lost.

LINE gives a webhook **2 seconds** to answer, so the work cannot move inline either.
The answer is Cloudflare Queues: the route enqueues and ACKs in milliseconds, and the
consumer gets a 15 minute budget.

This also fixes the layering violation the repo rules already call out. `routes/` should
be thin HTTP handlers; today `webhook.ts` holds 24 KB of business logic.

**Files:**
- Create: `apps/api/src/queue/types.ts`
- Create: `apps/api/src/services/webhook-dispatcher.ts`
- Create: `apps/api/src/queue/consumer.ts`
- Create: `apps/api/tests/helpers/inline-queue.ts`
- Create: `apps/api/tests/webhook-producer.test.ts`
- Modify: `apps/api/src/routes/webhook.ts` (shrinks from 690 to about 90 lines)
- Modify: `apps/api/tests/webhook.test.ts:2236`, `tests/webhook-logging.test.ts:114`,
  `tests/line-uids.test.ts:311` (one app factory per file, no assertion changes)

- [x] **Step 1: Create the queue message types**

Create `apps/api/src/queue/types.ts`:

```ts
import type { WebhookEvent } from "../types/line.types";

// One queue message carries one LINE event. LINE batches up to 20 events into
// a single webhook call, and each one needs its own reply token and its own
// retry behaviour, so the batch is fanned out here rather than in the consumer.
export interface LineEventMessage {
  kind: "line-event";
  tenant: string;
  webhookEventId: string;
  // Epoch ms of the webhook arrival. The LINE reply token expires 60s after
  // the event, so the consumer checks this before spending it.
  receivedAt: number;
  destination?: string;
  event: WebhookEvent;
}

export type QueueMessage = LineEventMessage;
```

- [x] **Step 2: Move the event-processing logic into a service**

Create `apps/api/src/services/webhook-dispatcher.ts`. This is a **pure move** with no
logic change. Cut these top-level declarations out of `src/routes/webhook.ts` and paste
them in, keeping every comment:

| Declaration | Current location |
| --- | --- |
| `lastTradeDeadlineMs` | `webhook.ts:41` |
| `webhookEventIdOf` | `webhook.ts:48` |
| `sendReply`, `ReplyType` | `webhook.ts:62` |
| `lineErrorFields` | `webhook.ts:96` |
| `logUpstreamLatency` | `webhook.ts:109` |
| `RETRY_MESSAGE`, `NOT_ALLOWED_MESSAGE`, `usageMessage` | `webhook.ts:~130-148` |
| `recordGroupTraffic` | `webhook.ts:281` |
| `notifyRetry` | `webhook.ts:294` |
| `processTextEvent` | `webhook.ts:319` |
| `parseQueryString` | `webhook.ts:426` |
| `processPostbackEvent` | `webhook.ts:438` |
| `handleLookupAndReply` | `webhook.ts:494` |
| `groupWelcomeMessage`, `groupNotRegisteredMessage` | `webhook.ts:617,624` |
| `processJoinEvent` | `webhook.ts:628` |
| `labelGroup` | `webhook.ts:674` |
| `processLeaveEvent` | `webhook.ts:685` |

Keep `MAX_WEBHOOK_EVENTS` in the route: it is a transport concern.
Export `webhookEventIdOf` so the route can stamp the message.
Then add the new public entrypoint at the end of the file:

```ts
/**
 * Handles exactly one LINE event to completion. Called by the queue consumer,
 * never by the HTTP route, because the HFM lookups behind it take seconds and
 * LINE times a webhook out after 2s.
 */
export async function dispatchWebhookEvent(
  message: LineEventMessage,
): Promise<void> {
  const { event, webhookEventId } = message;
  const db = getDb();

  logInfo(
    "webhook",
    {
      webhookEventId,
      eventType: event.type,
      sourceType: event.source?.type,
      chatId: event.source?.groupId ?? event.source?.roomId ?? event.source?.userId,
      hasUserId: typeof event.source?.userId === "string",
      isRedelivery: event.deliveryContext?.isRedelivery === true,
    },
    "webhook event received",
  );

  // Every later decision (permission, reply target, loading animation) comes
  // from this triple, never from event.source directly.
  const ctx = getChatContext(event);
  if (!ctx) {
    logInfo("webhook", { webhookEventId, reason: "no_chat_context" }, "event skipped");
    return;
  }

  if (ctx.userId) {
    // Telemetry only - a database hiccup must never stop the customer's reply.
    await recordLineUserRequest(db, ctx.userId, event.type).catch((err) =>
      logError("line-user", err),
    );
  }

  if (isTextMessageEvent(event)) {
    await recordGroupTraffic(db, ctx, event.type);
    const { replyToken } = event;
    try {
      await processTextEvent(event, ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
      await notifyRetry(replyToken, ctx, webhookEventId);
    }
    return;
  }

  if (isPostbackEvent(event)) {
    await recordGroupTraffic(db, ctx, event.type);
    const { replyToken } = event;
    try {
      await processPostbackEvent(event, ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
      await notifyRetry(replyToken, ctx, webhookEventId);
    }
    return;
  }

  if (isJoinEvent(event)) {
    // No notifyRetry here: the retry notice is about a failed lookup and would
    // make no sense as an answer to an invite.
    try {
      await processJoinEvent(event, ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
    }
    return;
  }

  if (isLeaveEvent(event)) {
    try {
      await processLeaveEvent(ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
    }
    return;
  }

  // follow, unfollow, videoComplete, ... - no handler and no reply.
  logInfo("webhook", { webhookEventId, reason: "unhandled_event_type" }, "event skipped");
}
```

- [x] **Step 3: Await the background work the move carried over**

The move in Step 2 also carried four fire-and-forget calls into the dispatcher. In a queue
consumer they are the same defect this task exists to fix: once `dispatchWebhookEvent`
returns, the consumer acks, `queue()` returns, Task 6 disposes the database client, and the
runtime may cancel whatever is still running. The consumer has a 15 minute budget, so each
one is simply awaited.

In `src/services/webhook-dispatcher.ts`:

(a) `recordGroupTraffic` (moved from `webhook.ts:281-292`) becomes async and awaits its write.
Replace the whole function with:

```ts
// Group registry telemetry. join and leave are deliberately not recorded
// here: their own handlers own the `active` flag, and an upsert racing with
// them could resurrect a group the bot has just left. Telemetry only, so a
// failure is logged and never stops the reply.
async function recordGroupTraffic(
  db: DrizzleDb,
  ctx: ChatContext,
  eventType: string,
): Promise<void> {
  if (ctx.chatType === "user") return;
  try {
    await recordLineGroupEvent(db, {
      chatId: ctx.chatId,
      chatType: ctx.chatType,
      eventType,
    });
  } catch (err) {
    logError("line-group", err);
  }
}
```

(b) Both loading-animation calls (moved from `webhook.ts:370-372` and `webhook.ts:503-505`)
change from:

```ts
    showLoadingForChat(ctx).catch((err) => {
      logError("line-loading", err);
    });
```

to:

```ts
    // Awaited, not fire-and-forget: in a queue consumer an unawaited call can be
    // cancelled, and awaiting also stops the old race where the loading request
    // could land after the reply and show a spinner under the answer.
    await showLoadingForChat(ctx).catch((err) => {
      logError("line-loading", err);
    });
```

The second site sits at function level, so its indentation is two spaces instead of four.

(c) In `processJoinEvent` (moved from `webhook.ts:628-672`), delete this line (from
`webhook.ts:660`) together with its two-line comment:

```ts
  if (ctx.chatType === "group") void labelGroup(db, ctx.chatId);
```

and replace the tail of the function, from `if (!isChatAllowed(ctx)) {` to the closing brace,
with:

```ts
  try {
    if (!isChatAllowed(ctx)) {
      await sendReply(webhookEventId, "reply", () =>
        replyText(event.replyToken, groupNotRegisteredMessage(ctx.chatId)),
      );
      return;
    }

    await sendReply(webhookEventId, "reply", () =>
      replyText(event.replyToken, groupWelcomeMessage()),
    );
  } finally {
    // The group name is for the operator list only, so it runs after the
    // greeting and never holds it up. It is awaited, and in a finally so a
    // failed greeting does not skip it, because the queue consumer's work ends
    // when this function returns. labelGroup never throws.
    if (ctx.chatType === "group") await labelGroup(db, ctx.chatId);
  }
}
```

Then confirm nothing fire-and-forget is left in the dispatcher:

```bash
cd apps/api && grep -nE "^\s*void |\)\.catch\(" src/services/webhook-dispatcher.ts
```

Expected: only lines that begin with `await` (the two loading calls and
`await recordLineUserRequest(...).catch(...)`). Any other hit is a call that the runtime can
cancel; await it.

- [x] **Step 4: Shrink the route to a producer**

Replace the whole of `apps/api/src/routes/webhook.ts` with:

```ts
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { verifyLineSignature } from "../utils/signature";
import { webhookEventIdOf } from "../services/webhook-dispatcher";
import { logInfo, logWarn } from "../utils/logger";
import type { WorkerEnv } from "../config/env";
import type { LineEventMessage } from "../queue/types";
import type { WebhookBody } from "../types/line.types";

const MAX_WEBHOOK_EVENTS = 20;

const webhook = new Hono<{ Bindings: WorkerEnv }>();

webhook.post(
  "/",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.text("Payload Too Large", 413),
  }),
  async (c) => {
    const rawBody = await c.req.text();
    const sig = c.req.header("x-line-signature") ?? "";

    if (
      !verifyLineSignature(rawBody, sig, process.env.LINE_CHANNEL_SECRET ?? "")
    ) {
      return c.text("Unauthorized", 400);
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody) as WebhookBody;
    } catch {
      return c.text("Bad Request", 400);
    }

    const events = body.events ?? [];

    // Batch boundary: when this line is absent, LINE never delivered and the
    // gap is upstream of the app. When it is present, follow the
    // webhookEventId to see why the bot stayed quiet.
    logInfo(
      "webhook",
      { destination: body.destination, eventCount: events.length },
      "webhook batch received",
    );

    const eventsToProcess = events.slice(0, MAX_WEBHOOK_EVENTS);
    if (events.length > MAX_WEBHOOK_EVENTS) {
      logWarn(
        "webhook",
        {
          destination: body.destination,
          received: events.length,
          kept: MAX_WEBHOOK_EVENTS,
          dropped: events.length - MAX_WEBHOOK_EVENTS,
        },
        "webhook batch truncated",
      );
    }

    // LINE gives this endpoint 2 seconds before it records a request_timeout,
    // and a Wallet ID lookup needs seconds of HFM calls. So nothing is done
    // here: each event becomes one queue message and the consumer replies.
    const tenant = process.env.TENANT ?? "unknown";
    const messages: LineEventMessage[] = eventsToProcess.map((event) => ({
      kind: "line-event" as const,
      tenant,
      webhookEventId: webhookEventIdOf(event),
      receivedAt: Date.now(),
      destination: body.destination,
      event,
    }));

    if (messages.length > 0) {
      await c.env.EVENT_QUEUE.sendBatch(
        messages.map((body) => ({ body })),
      );
    }

    return c.text("OK", 200);
  },
);

export default webhook;
```

- [x] **Step 5: Write the queue consumer**

Create `apps/api/src/queue/consumer.ts`:

```ts
import { dispatchWebhookEvent } from "../services/webhook-dispatcher";
import { logError, logInfo } from "../utils/logger";
import type { QueueMessage } from "./types";

/**
 * Every tenant config sets max_batch_size to 1, so each LINE event gets its own
 * consumer invocation. A slow lookup can then never make another customer's
 * reply token (60s) expire while it waits in the same batch.
 *
 * Failures are not retried: every tenant config sets max_retries to 0. A retry
 * could reuse a reply token that is already spent, and replyOrPush would then
 * fall back to a push - a duplicate answer for the customer, billed per member
 * in a group. message.retry() therefore sends the message straight to the dead
 * letter queue, where the operator can inspect it.
 */
export async function handleQueueBatch(
  batch: MessageBatch<QueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    const started = Date.now();
    try {
      await dispatchWebhookEvent(message.body);
      message.ack();
      logInfo(
        "queue",
        {
          webhookEventId: message.body.webhookEventId,
          attempts: message.attempts,
          // Time spent waiting in the queue. Kept off the "webhook event
          // received" line on purpose: tests/webhook-logging.test.ts pins that
          // line's exact field set.
          queueLagMs: started - message.body.receivedAt,
          durationMs: Date.now() - started,
        },
        "queue message handled",
      );
    } catch (err) {
      logError("queue", err);
      message.retry();
    }
  }
}
```

- [x] **Step 6: Write the inline queue test helper**

The existing suite asserts on reply content by posting to the route. Keeping those
2,000 lines of assertions is worth more than testing the transport split, so the tests
inject a queue that runs the consumer synchronously.

Create `apps/api/tests/helpers/inline-queue.ts`:

```ts
import type { Hono } from "hono";
import { handleQueueBatch } from "../../src/queue/consumer";
import type { QueueMessage } from "../../src/queue/types";

export interface InlineQueue {
  send(body: QueueMessage): Promise<void>;
  sendBatch(items: { body: QueueMessage }[]): Promise<void>;
  sent: QueueMessage[];
}

/**
 * Runs the real consumer inline instead of going through Cloudflare Queues, so
 * a test can post a webhook body and assert on the LINE reply it produces.
 * Production is asynchronous; this helper only collapses the transport.
 */
export function createInlineQueue(): InlineQueue {
  const sent: QueueMessage[] = [];
  const run = async (bodies: QueueMessage[]): Promise<void> => {
    sent.push(...bodies);
    await handleQueueBatch({
      messages: bodies.map((body) => ({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body,
        ack: () => {},
        retry: () => {},
      })),
      queue: "test",
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<QueueMessage>);
  };
  return {
    sent,
    send: (body) => run([body]),
    sendBatch: (items) => run(items.map((i) => i.body)),
  };
}

/**
 * Makes app.fetch(req) inject a fresh inline queue, so the existing tests that
 * call app.fetch with one argument keep working unchanged.
 */
export function withInlineQueue<T extends Hono<any>>(app: T): T {
  const original = app.fetch.bind(app);
  app.fetch = ((request: Request, env?: object, ctx?: ExecutionContext) =>
    original(
      request,
      { ...(env ?? {}), EVENT_QUEUE: createInlineQueue() },
      ctx,
    )) as T["fetch"];
  return app;
}
```

- [x] **Step 7: Point the existing app tests at the inline queue**

Each of the three files builds its app in exactly one factory function. Change only that
factory, so none of the 35 `app.fetch(...)` call sites needs an edit.

| File | Factory |
| --- | --- |
| `tests/webhook.test.ts` | `importWebhook()` at line 2236 |
| `tests/webhook-logging.test.ts` | `importWebhook()` at line 114 |
| `tests/line-uids.test.ts` | `createApp()` at line 311 |

Use `withInlineQueue` from `tests/helpers/inline-queue.ts` (Step 6).

In `tests/webhook.test.ts`, change the last line of `importWebhook()` from:

```ts
  return { app };
```

to:

```ts
  return { app: withInlineQueue(app) };
```

Make the same one-line change in `tests/webhook-logging.test.ts` `importWebhook()`.
In `tests/line-uids.test.ts` `createApp()`, change `return app;` to
`return withInlineQueue(app);`.

Add this import at the top of each of the three files:

```ts
import { withInlineQueue } from "./helpers/inline-queue";
```

> Deviation: The plan's `Bun.sleep(...)` waits are `new Promise((r) => setTimeout(r, ...))` in the
> current files. Only the 5 fixed waits that solely covered fire-and-forget work were removed
> (webhook.test.ts: one 50ms, one 300ms, three 100ms group-silence waits; the 300ms wait's
> dedicated comment went with it). The 7 remaining sleeps are poll intervals inside adaptive
> while-loops (`waitFor`, `waitForUsers`, `waitForGroups`) and stay, so their polling behaviour
> is unchanged. Per the plan, a wait is removed only if the test still passes without it.

Because the route now awaits `sendBatch`, and the inline queue awaits the consumer, every
assertion that relied on the old floating promise now has a real happens-before edge. A
`Bun.sleep(...)` that only waited for background work can be removed. There are 9 such waits
in `tests/webhook.test.ts`, 2 in `tests/webhook-logging.test.ts` and 1 in
`tests/line-uids.test.ts`. Remove a wait only if the test still passes without it.

- [x] **Step 8: Run the existing suite**

```bash
cd apps/api && bun test tests/webhook.test.ts tests/webhook-logging.test.ts tests/line-uids.test.ts
```

Expected: PASS with no assertion changes. If a test fails on ordering, it was depending
on the old fire-and-forget timing; fix the test, not the code.

- [x] **Step 9: Write the producer test**

Create `apps/api/tests/webhook-producer.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import webhook from "../src/routes/webhook";
import type { QueueMessage } from "../src/queue/types";

const SECRET = "test_secret";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64");
}

function collectingQueue() {
  const sent: QueueMessage[] = [];
  return {
    sent,
    sendBatch: async (items: { body: QueueMessage }[]) => {
      sent.push(...items.map((i) => i.body));
    },
  };
}

function textEvent(id: string) {
  return {
    type: "message",
    webhookEventId: id,
    replyToken: "rt",
    source: { type: "user", userId: "Uabc123" },
    message: { type: "text", id: "1", text: "98241376" },
  };
}

describe("webhook producer", () => {
  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.LINE_CHANNEL_SECRET;
  });

  test("rejects a bad signature without enqueueing", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const body = JSON.stringify({ events: [textEvent("a")] });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": "wrong" },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(400);
    expect(queue.sent).toHaveLength(0);
  });

  test("enqueues one message per event and returns 200", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const body = JSON.stringify({
      destination: "Udest",
      events: [textEvent("a"), textEvent("b")],
    });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": sign(body) },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[0]!.webhookEventId).toBe("a");
    expect(queue.sent[0]!.kind).toBe("line-event");
    expect(queue.sent[0]!.destination).toBe("Udest");
    expect(typeof queue.sent[0]!.receivedAt).toBe("number");
  });

  test("truncates a batch larger than 20 events", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const events = Array.from({ length: 25 }, (_, i) => textEvent(`e${i}`));
    const body = JSON.stringify({ events });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": sign(body) },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toHaveLength(20);
  });

  test("answers an empty event list without touching the queue", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const body = JSON.stringify({ events: [] });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": sign(body) },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toHaveLength(0);
  });
});
```

- [x] **Step 10: Run the producer test**

```bash
cd apps/api && bun test tests/webhook-producer.test.ts
```

Expected: PASS, 4 tests.

- [x] **Step 11: Run the whole suite and typecheck**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: PASS.

- [x] **Step 12: Commit**

```bash
git add apps/api/src apps/api/tests
git commit -m "refactor: enqueue LINE events instead of floating promises"
```

---

## Interface notes for Tasks 3 and 4

Tasks 3 and 4 introduce or keep these names. Later tasks rely on them.

| Addition | Where | Why |
| --- | --- | --- |
| `closeDb(): Promise<void>` kept in `src/db/connection.ts` | existing export, unchanged signature | 5 test files and 3 scripts call it (`tests/webhook-logging.test.ts:169`, `scripts/trigger-daily-client-report.ts:23,26`, `scripts/trigger-hfm-healthcheck.ts:42,45`, `scripts/seed-mock-client-snapshots.ts:177`). It now closes the `process.env.DATABASE_URL` fallback client only. |
| `resetDbForTests(): void` kept in `src/db/connection.ts` | existing export, unchanged signature | 6 test files call it (`tests/webhook.test.ts:55,80,770,2243`, `tests/health.test.ts:34,42`, `tests/line-uids.test.ts:53,77,253,311`, `tests/line-groups-endpoint.test.ts:18,38`, `tests/webhook-logging.test.ts:111,177`). |
| `applyTestSchema(db): Promise<void>` in `tests/db-helpers.ts` | NEW test-only helper | New home for the DDL that `initDb` used to run. 8 test files call `initDb` today and must keep creating their tables. |
| `scripts/migrate-tenant.ts` plus env names `DATABASE_URL_MAOW` and `DATABASE_URL_SIMPLE_TRADE` | NEW script | Applies `drizzle/*.sql` directly to a tenant Postgres, never through Hyperdrive. |
| `tests/migrations.test.ts` | NEW test file | Drift guard: the runtime no longer creates tables, so a table missing from `drizzle/` is now a silent data-loss bug. |
| package.json scripts `db:generate`, `migrate:maow`, `migrate:simple-trade`, `tail:maow`, `tail:simple-trade` | `apps/api/package.json` | Task 3 adds `tail:*`. The wrangler-config task must not add it a second time. |
| `drizzle/` un-ignored in `apps/api/.gitignore:18-19` | existing file | `drizzle/` is currently gitignored, so generated migrations would never reach a deploy. |

**Dependency:** Tasks 3 and 4 assume Task 1 has installed `@cloudflare/workers-types` and set `types` in `tsconfig.json`, because Task 4 uses the `Hyperdrive` type.
The logger reads `LOG_LEVEL` and `TENANT` straight from `process.env`, which Cloudflare fills per Worker (Task 1 explains why).

---

## Task 3: Replace pino with a Workers JSON logger

**Why:** `src/utils/logger.ts:1-3` imports `pino`, `node:path` and `node:fs`.
pino targets Node streams and `process.stdout`, and its maintainers state it is "essentially unsupported right now on that platform" for Cloudflare Workers (<https://github.com/pinojs/pino/issues/2035>).
`node:fs` on Workers is a virtual in-memory filesystem, so `readLog`, `listLogDates` and the `logs/` directory can never return real data there.

**Files:**
- Modify: `apps/api/src/utils/logger.ts:1-117` (full rewrite, 117 lines to about 70)
- Modify: `apps/api/src/routes/internal.ts:3`, `:10`, `:50-68` (delete the log routes)
- Modify: `apps/api/package.json:26-28` (remove `pino`, `pino-pretty`, `pino-roll`), `:6-16` (add `tail:*` scripts)
- Modify: `apps/api/.env.example` (add `LOG_LEVEL`)
- Modify: `apps/api/AGENTS.md` (document `bun run tail:<tenant>`)
- Rewrite: `apps/api/tests/logger.test.ts:1-29` (all 3 tests test `parseLog`, which is deleted)
- Modify: `apps/api/tests/flex-message.builder.test.ts:436-438` (retype the `logger.warn` stub)
- Modify: `apps/api/tests/health.test.ts` (add a describe block proving `/internal/logs` is gone)

### Call sites of the logger, complete list

`grep -rn "utils/logger" src tests scripts --include=*.ts` gives exactly these importers:

| File:line | Import | Breaks? |
| --- | --- | --- |
| `src/builders/flex-message.builder.ts:3` | `import { logger } from "../utils/logger";`, used at `:45` as `logger.warn({ context: "flex-version" }, msg)` | No. The new `logger.warn(o, m?)` has the same shape. |
| `src/index.ts:5` | `import { logger, logError } from "./utils/logger";`, used at `:19`, `:24`, `:39`, `:44` | No. All four calls are `logger.info(object, string)`. `src/index.ts` is deleted at the end of the migration by the worker task. |
| `src/routes/internal.ts:3` | `import { readLog, parseLog, listLogDates } from "../utils/logger";` | **Yes.** All three are deleted. Fixed in Step 9. |
| `src/routes/webhook.ts:20` | `import { logError, logInfo, logWarn } from "../utils/logger";` | No. Signatures are unchanged. |
| `src/services/hfm.service.ts:1` | `import { logError } from "../utils/logger";` | No. |
| `src/services/last-trade.service.ts:2` | `import { logError } from "../utils/logger";` | No. |
| `src/services/line.service.ts:1` | `import { logError } from "../utils/logger";` | No. |
| `tests/flex-message.builder.test.ts:9` | `import { logger } from "../src/utils/logger";`, then reassigns `logger.warn` at `:438` and restores it at `:443` | **Yes, one line.** `logger` stays a plain mutable object literal, so the swap keeps working, but the `@ts-expect-error` at `:437` becomes unused and breaks `bun run typecheck`. Fixed in Step 5. |
| `tests/logger.test.ts:2` | `import { parseLog } from "../src/utils/logger";` | **Yes.** All 3 tests in the file test `parseLog`. Rewritten in Step 1. |
| `tests/webhook-logging.test.ts:30` | `mock.module("../src/utils/logger", ...)` returning `{ logger, logError, logInfo, logWarn }` | No. The stub already matches the new export set and never touches `readLog`/`parseLog`/`listLogDates`. |

No other file in `src/`, `tests/` or `scripts/` imports the logger.

### Existing logging tests and what happens to them

| Test file | Tests | Action |
| --- | --- | --- |
| `tests/logger.test.ts` | `"parseLog formats pino timestamp with dayjs"` (`:4`), `"parseLog handles multiple lines"` (`:14`), `"parseLog skips unparseable lines"` (`:25`) | **Delete all 3.** `parseLog` exists only to re-read pino output off disk. Replaced by the new JSON-emitter tests in Step 1. |
| `tests/flex-message.builder.test.ts:433-447` `"unrecognized value falls back to flex-v1 and warns once"` | Swaps `logger.warn` for a recorder | **Keep the test, retype the stub.** Step 3 keeps `logger` a mutable object; Step 5 drops the now-unused `@ts-expect-error` at `:437`. |
| `tests/webhook-logging.test.ts` (all 614 lines) | Asserts `logInfo`/`logWarn`/`logError` calls through `mock.module` | **Keep unchanged.** |
| `tests/health.test.ts` | No log-route test exists today | **Add** one describe block in Step 7. |

`grep -rn "internal/logs" tests` returns nothing, so no test covers the two deleted routes today.

- [x] **Step 1: Rewrite tests/logger.test.ts against the JSON logger**
> Deviation: The file is the plan's content except its import block. In the full suite,
> tests/webhook-logging.test.ts calls mock.module on the plain "../src/utils/logger"
> specifier, and bun registers those mocks before other files' imports, so this file
> resolved to the recording stub and all 9 console-capture tests failed (11 pass
> standalone, 9 fail in the suite). bun 1.3.5 has no per-file isolation and
> mock.restore() does not undo mock.module. Correction: load the real module through a
> runtime-variable "?real" query specifier (its own unmocked module instance) with a
> type-only import as the type anchor; every test body stays byte-identical to the
> plan.

Replace the whole content of `apps/api/tests/logger.test.ts` with this file.

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as loggerMod from "../src/utils/logger";
import { logError, logInfo, logWarn, logger } from "../src/utils/logger";

const ORIGINAL_LOG = console.log;
const ORIGINAL_ERROR = console.error;

let out: Record<string, unknown>[] = [];
let err: Record<string, unknown>[] = [];

beforeEach(() => {
  out = [];
  err = [];
  console.log = (line: unknown) => {
    out.push(line as Record<string, unknown>);
  };
  console.error = (line: unknown) => {
    err.push(line as Record<string, unknown>);
  };
  process.env.TENANT = "maow";
  delete process.env.LOG_LEVEL;
});

afterEach(() => {
  console.log = ORIGINAL_LOG;
  console.error = ORIGINAL_ERROR;
  delete process.env.TENANT;
  delete process.env.LOG_LEVEL;
});

test("logInfo emits one structured object on console.log", () => {
  logInfo("webhook", { eventId: "abc", durationMs: 12 }, "handled");

  expect(out).toHaveLength(1);
  expect(err).toHaveLength(0);
  const line = out[0]!;
  expect(line.level).toBe("info");
  expect(line.context).toBe("webhook");
  expect(line.eventId).toBe("abc");
  expect(line.durationMs).toBe(12);
  expect(line.msg).toBe("handled");
  expect(typeof line.time).toBe("number");
});

test("every line carries the tenant field", () => {
  logInfo("webhook", { eventId: "abc" }, "handled");
  logWarn("webhook", { eventId: "abc" }, "slow");
  logError("webhook", new Error("boom"));

  const all = [...out, ...err];
  expect(all).toHaveLength(3);
  for (const line of all) {
    expect(line.tenant).toBe(process.env.TENANT ?? "unknown");
    expect(Object.keys(line)).toContain("tenant");
  }
});

test("logWarn and logError go to console.error", () => {
  logWarn("hfm", { clientId: 1 }, "retry");
  logError("hfm", new Error("boom"));

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(2);
  expect(err[0]!.level).toBe("warn");
  expect(err[1]!.level).toBe("error");
});

test("logError keeps the message and the stack in msg", () => {
  const error = new Error("boom");
  logError("hfm", error);

  expect(err).toHaveLength(1);
  expect(String(err[0]!.msg)).toContain("boom");
  expect(String(err[0]!.msg)).toContain(error.stack!);
});

test("logError stringifies a non-Error throw", () => {
  logError("hfm", "plain string failure");

  expect(err).toHaveLength(1);
  expect(err[0]!.msg).toBe("plain string failure");
});

test("debug is dropped at the default info level", () => {
  logger.debug({ context: "boot" }, "verbose");

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(0);
});

test("LOG_LEVEL=warn drops info and keeps warn", () => {
  process.env.LOG_LEVEL = "warn";

  logInfo("webhook", { eventId: "abc" }, "handled");
  logWarn("webhook", { eventId: "abc" }, "slow");

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(1);
  expect(err[0]!.level).toBe("warn");
});

test("LOG_LEVEL=debug lets debug through", () => {
  process.env.LOG_LEVEL = "debug";

  logger.debug({ context: "boot" }, "verbose");

  expect(out).toHaveLength(1);
  expect(out[0]!.level).toBe("debug");
});

test("an unknown LOG_LEVEL falls back to info", () => {
  process.env.LOG_LEVEL = "loud";

  logger.debug({ context: "boot" }, "verbose");
  logInfo("webhook", { eventId: "abc" }, "handled");

  expect(out).toHaveLength(1);
  expect(out[0]!.level).toBe("info");
});

test("logger.warn stays reassignable for the flex builder test", () => {
  const original = logger.warn;
  const seen: string[] = [];
  logger.warn = (_o: object, m?: string) => {
    seen.push(m ?? "");
  };
  try {
    logger.warn({ context: "flex-version" }, "replaced");
  } finally {
    logger.warn = original;
  }
  expect(seen).toEqual(["replaced"]);
});

test("the filesystem log readers are gone", () => {
  expect("readLog" in loggerMod).toBe(false);
  expect("parseLog" in loggerMod).toBe(false);
  expect("listLogDates" in loggerMod).toBe(false);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun test tests/logger.test.ts`

Expected: FAIL.
The current pino logger writes to stdout through its own stream, not through `console.log` or `console.error`, so the captured line arrays stay empty and the shape tests fail with `expect(received).toHaveLength(expected)`.
`the filesystem log readers are gone` fails too, because `readLog`, `parseLog` and `listLogDates` are still exported.

- [x] **Step 3: Rewrite src/utils/logger.ts**
> Deviation: The rewritten logger drops pino, whose .d.ts imports were the only thing
> pulling @types/node into the tsc program. Without it, workers-types' `declare const
> process: any` flattened bun-types' typed `process`, `process.exit(1)` returned `any`,
> and untouched scripts/fetch-client-performance-range.ts:18 failed to narrow (TS2339).
> Extended src/types/workers-types-compat.d.ts additively (its documented purpose) with
> `/// <reference types="node" />`; @types/node is a bun-types dependency, so the
> reference always resolves. tsconfig untouched.

Replace the whole content of `apps/api/src/utils/logger.ts` (currently 117 lines) with this file.

```ts
type Level = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<Level, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const DEFAULT_LEVEL_VALUE = LEVEL_VALUE.info;

// Workers Logs truncates a single log line at 256 KB and caps the whole
// request at 256 KB of log data, after which the rest of the request's logs
// are dropped. So log ids, counts, reason enums and durations only. Never dump
// an HFM or LINE payload in here: one dump costs the entire incident's logs.

function thresholdValue(): number {
  // Read per call, not at module load, so tests can flip LOG_LEVEL between
  // cases. On Workers, process.env holds this tenant's vars.
  const configured = (process.env.LOG_LEVEL ?? "info").trim() as Level;
  return LEVEL_VALUE[configured] ?? DEFAULT_LEVEL_VALUE;
}

function emit(level: Level, obj: object, msg?: string): void {
  if (LEVEL_VALUE[level] < thresholdValue()) return;

  // One object argument, not a pre-stringified line: Workers Logs indexes
  // every field of an object passed to console.log with unlimited cardinality,
  // while a JSON string arrives as one unqueryable message blob.
  const line: Record<string, unknown> = {
    level,
    time: Date.now(),
    tenant: process.env.TENANT ?? "unknown",
    ...obj,
    ...(msg === undefined ? {} : { msg }),
  };

  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// A plain mutable object on purpose. tests/flex-message.builder.test.ts:438
// swaps `logger.warn` for a recorder and restores it at :443.
export const logger = {
  debug(o: object, m?: string): void {
    emit("debug", o, m);
  },
  info(o: object, m?: string): void {
    emit("info", o, m);
  },
  warn(o: object, m?: string): void {
    emit("warn", o, m);
  },
  error(o: object, m?: string): void {
    emit("error", o, m);
  },
};

export function logError(context: string, error: unknown): void {
  const message =
    error instanceof Error
      ? `${error.message} | ${error.stack ?? ""}`
      : String(error);
  logger.error({ context }, message);
}

// Structured info/warn for permanent production logging. `fields` carries the
// searchable values (ids, durations, reason enums); `message` stays a short
// stable phrase so log greps stay simple.
export function logInfo(
  context: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  logger.info({ context, ...fields }, message);
}

export function logWarn(
  context: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  logger.warn({ context, ...fields }, message);
}
```

- [x] **Step 4: Run the logger test to verify it passes**

Run: `cd apps/api && bun test tests/logger.test.ts`
Expected: PASS, 11 pass, 0 fail.

- [x] **Step 5: Fix the type of the logger stub in the flex builder test**
> Deviation: The stub retyping lands exactly as specified and its tests pass (44 pass,
> including "unrecognized value falls back to flex-v1 and warns once"). The step's
> "typecheck clean" condition cannot hold between Steps 3 and 9: src/routes/internal.ts
> still imports the deleted readLog/parseLog/listLogDates (TS2305), which the plan's own
> Step 8 anticipates ("the route file must be fixed now anyway"). Step 5 is verified
> after Step 9 lands and before the Step 6 commit.

`apps/api/tests/flex-message.builder.test.ts:436-438` currently reads:

```ts
    const originalWarn = logger.warn.bind(logger);
    // @ts-expect-error - test double for the pino warn signature
    logger.warn = (_obj: unknown, msg: string) => warned.push(msg);
```

The `@ts-expect-error` directive exists because the stub did not match pino's `LogFn` overloads.
The new `logger` is an object literal, so its methods are checked bivariantly and the stub now assigns cleanly.
An unused `@ts-expect-error` is itself a TypeScript error, so `bun run typecheck` fails if the directive stays.
Replace those three lines with:

```ts
    const originalWarn = logger.warn;
    logger.warn = (_obj: object, msg?: string) => {
      warned.push(msg ?? "");
    };
```

Line 443 stays exactly as it is:

```ts
      logger.warn = originalWarn;
```

Then verify:

```bash
cd apps/api
bun run typecheck
bun test tests/flex-message.builder.test.ts
```

Expected: typecheck clean, and the flex builder tests pass, including `"unrecognized value falls back to flex-v1 and warns once"`.

- [x] **Step 6: Commit the logger rewrite**
> Deviation: The commit lands after Step 9's route deletion so the working tree (and the
> pre-commit gate) typechecks clean, and before the Step 11 commit; both commits keep the
> staged file sets this step prescribes. It additionally stages the Step 3 Deviation
> repair, src/types/workers-types-compat.d.ts, which the logger rewrite typechecks only
> with. Commit: 4dbfa88.

```bash
cd apps/api
git add src/utils/logger.ts tests/logger.test.ts tests/flex-message.builder.test.ts
git commit -m "refactor: replace pino with JSON console logger"
```

- [x] **Step 7: Write the failing test for the deleted /internal/logs routes**

Append this describe block to the end of `apps/api/tests/health.test.ts`.
It sits outside the existing `describe("GET /internal/health", ...)` block, so it needs no database.

```ts
describe("removed log routes", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = "test_key";
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  test("GET /internal/logs is gone", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/logs?key=test_key"),
    );
    expect(res.status).toBe(404);
  });

  test("GET /internal/logs/:date is gone", async () => {
    const internalMod = await import("../src/routes/internal");
    const app = new Hono();
    app.route("/internal", internalMod.default);

    const res = await app.fetch(
      new Request("http://localhost/internal/logs/20260922?key=test_key"),
    );
    expect(res.status).toBe(404);
  });
});
```

- [x] **Step 8: Run it to verify it fails**

Run: `cd apps/api && bun test tests/health.test.ts -t "log routes"`

Expected: FAIL.
Both tests fail with `expect(received).toBe(expected)` showing `Received: 200` for `/internal/logs`, because `src/routes/internal.ts:50-53` still answers with `{ dates: [] }`.
If the import itself throws `Export named 'readLog' not found`, the logger rewrite in Step 3 already landed and the route file must be fixed now anyway.

- [x] **Step 9: Delete the log routes from src/routes/internal.ts**

Delete line 3 exactly:

```ts
import { readLog, parseLog, listLogDates } from "../utils/logger";
```

Delete line 10 exactly:

```ts
const MAX_LOG_ENTRIES = 200;
```

Delete lines 50 to 68 exactly, both routes and the blank line between them:

```ts
internal.get("/logs", async (c) => {
  const dates = listLogDates();
  return c.json({ dates });
});

internal.get("/logs/:date", async (c) => {
  const date = c.req.param("date");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Number(limitParam) || MAX_LOG_ENTRIES,
    MAX_LOG_ENTRIES
  );
  const content = readLog(date);
  if (!content) {
    return c.json({ error: "No logs found for this date" }, 404);
  }
  const entries = parseLog(content, limit);
  return c.json({ date, entries });
});
```

Nothing else in the file changes.
`/internal/health`, `/internal/line-uids` and `/internal/line-groups` stay exactly as they are, including the comment at `:82-83`.

- [x] **Step 10: Run the route tests to verify they pass**

Run: `cd apps/api && bun test tests/health.test.ts`
Expected: PASS, including the 2 new tests.
This file needs the test database, so start it first from the repo root with `docker compose up -d postgres-test` and export `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test`.

- [x] **Step 11: Commit the route deletion**
> Deviation: Commit 4f49843.

```bash
cd apps/api
git add src/routes/internal.ts tests/health.test.ts
git commit -m "feat: drop disk-backed /internal/logs routes"
```

- [x] **Step 12: Remove pino from package.json and add the tail scripts**

In `apps/api/package.json`, delete these three lines from `dependencies` (currently lines 26, 27, 28):

```json
    "pino": "^10.3.1",
    "pino-pretty": "^13.1.3",
    "pino-roll": "^4.0.0",
```

The `dependencies` block must end up exactly like this:

```json
  "dependencies": {
    "croner": "^10.0.1",
    "dayjs": "^1.11.20",
    "drizzle-orm": "^0.45.2",
    "hono": "^4.12.15",
    "postgres": "^3.4.9"
  }
```

In the same file, add the two tail scripts after `"seed:mock-snapshots"`, so `scripts` ends exactly like this:

```json
    "seed:mock-snapshots": "bun run scripts/seed-mock-client-snapshots.ts",
    "tail:maow": "wrangler tail -c wrangler.maow.jsonc",
    "tail:simple-trade": "wrangler tail -c wrangler.simple-trade.jsonc"
```

Then refresh the lockfile:

```bash
cd apps/api
bun install
```

- [x] **Step 13: Verify pino is really gone**
> Deviation: The grep is not literally empty: tests/webhook-logging.test.ts:27 keeps a
> pre-existing prose comment ("Swap the pino logger for a recording stub...") and this
> task must not touch that file. No code, import, config, or lockfile reference remains
> (bun.lock has zero pino entries); the dependency is fully gone.

```bash
cd apps/api
grep -rn "pino" src tests scripts package.json
```

Expected: no output at all.
Then run the full suite and the typechecker:

```bash
cd apps/api
bun run typecheck
bun test
```

Expected: typecheck clean, all tests pass.

- [x] **Step 14: Document the operator replacement for /internal/logs**

Add `LOG_LEVEL` to `apps/api/.env.example`, right after line 25 (`PORT=3000`):

```
# Logger threshold: debug, info, warn or error. Default info.
LOG_LEVEL=info
```

Add this section to the end of `apps/api/AGENTS.md`:

```markdown
## Logs

There is no `logs/` directory and no `/internal/logs` endpoint any more.
The Worker emits one JSON object per log line through `console.log` and `console.error`.

- Live tail one tenant: `bun run tail:maow` or `bun run tail:simple-trade`.
- Filter a live tail by level: `bun run tail:maow -- --status error`.
- Historical search: the Workers Logs UI for the tenant Worker, which indexes
  every field of the emitted object (`level`, `tenant`, `context`, `msg`, ids).
- Retention is 7 days on the Paid plan, 3 days on Free.

Never log an HFM or LINE payload.
Workers Logs caps one request at 256 KB of log data and drops the rest.
```

- [x] **Step 15: Commit the dependency and docs change**
> Deviation: Commit e03e651.

```bash
cd apps/api
git add package.json bun.lock .env.example AGENTS.md
git commit -m "chore: drop pino deps, document wrangler tail"
```

---

## Task 4: Hyperdrive-backed per-invocation database layer

**Why:** `src/db/connection.ts:8-9` holds the client and the Drizzle instance in module singletons, built with `postgres(connUrl, { max: 10 })` at `:15`.
On Workers an isolate is created and evicted at any time and a module singleton is per isolate, so a pool cannot be shared and `max: 10` fights the 6-connection outbound limit.
`src/db/connection.ts:20-93` also runs 8 `CREATE TABLE` plus 2 `ALTER TABLE` statements at boot, and `src/index.ts:12` executes that with a top-level `await`.
Top-level await that does I/O is module-load work with no request context, which is exactly what Workers forbids.

**Files:**
- Modify: `apps/api/src/db/connection.ts:1-106` (full rewrite)
- Modify: `apps/api/src/index.ts:7`, `:11-12` (drop `initDb` from the boot path)
- Modify: `apps/api/tests/db-helpers.ts:1-99` (add `applyTestSchema`, reuse it in `createTestDb`)
- Modify: `apps/api/tests/daily-client-report.test.ts:5,42`
- Modify: `apps/api/tests/health.test.ts:6,32`
- Modify: `apps/api/tests/line-groups-endpoint.test.ts:6,16`
- Modify: `apps/api/tests/line-uids.test.ts:7,51`
- Modify: `apps/api/tests/snapshot.repository.test.ts:5,50`
- Modify: `apps/api/tests/sqlite.service.test.ts:5,33,34,62,78,79,80`
- Modify: `apps/api/tests/webhook-logging.test.ts:7,109`
- Modify: `apps/api/tests/webhook.test.ts:7,53`
- Modify: `apps/api/scripts/seed-mock-client-snapshots.ts:3,105-106`
- Modify: `apps/api/.gitignore:18-19`
- Modify: `apps/api/package.json` scripts block
- Modify: `apps/api/.env.example`
- Create: `apps/api/scripts/migrate-tenant.ts`
- Create: `apps/api/tests/db-connection.test.ts`
- Create: `apps/api/tests/migrations.test.ts`
- Generated (never hand-edited): `apps/api/drizzle/*.sql` and `apps/api/drizzle/meta/*`

### schema.ts versus the initDb DDL, table by table

Read `src/db/schema.ts:1-125` against `src/db/connection.ts:22-92`.

| Table in the `initDb` DDL | Declared in `schema.ts` | Notes |
| --- | --- | --- |
| `client_snapshots` (`connection.ts:23-31`) | yes, `clientSnapshots` (`schema.ts:12-31`) | Same 6 columns. The DDL `UNIQUE(snapshot_date, client_id)` matches the named constraint `client_snapshots_snapshot_date_client_id_unique` (`schema.ts:25-28`). |
| `notify_recipients` (`:37-42`) | yes, `notifyRecipients` (`schema.ts:33-38`) | Same 4 columns. |
| `daily_report_notifications` (`:44-47`) | yes, `dailyReportNotifications` (`schema.ts:40-45`) | Same 2 columns. |
| `line_users` (`:49-55`) | yes, `lineUsers` (`schema.ts:47-57`) | Same 5 columns. |
| `line_groups` (`:57-66`) | yes, `lineGroups` (`schema.ts:62-75`) | Same 8 columns. |
| `report_range_snapshots` (`:68-76`) | yes, `reportRangeSnapshots` (`schema.ts:77-96`) | Same 6 columns plus the same 3-column unique. |
| `client_request_snapshots` (`:78-82`) | yes, `clientRequestSnapshots` (`schema.ts:98-108`) | Same 3 columns. |
| `client_request_snapshot_rows` (`:86-91`) | yes, `clientRequestSnapshotRows` (`schema.ts:110-125`) | Same 4 columns, same FK to `client_request_snapshots.id`, same unique. |
| index `idx_snapshot_date` (`:32-33`) | yes (`schema.ts:29`) | Same name. |
| index `idx_req_snapshot_date` (`:83-84`) | yes (`schema.ts:107`) | Same name. |
| `ALTER TABLE client_snapshots ADD COLUMN IF NOT EXISTS name TEXT` (`:34`) | covered by `name: text("name")` (`schema.ts:18`) | Historic backfill for databases created before the column existed. A fresh `CREATE TABLE` from `schema.ts` already has it. |
| `ALTER TABLE client_snapshots ADD COLUMN IF NOT EXISTS email TEXT` (`:35`) | covered by `email: text("email")` (`schema.ts:19`) | Same. |

**Result: zero tables are lost.**
All 8 tables and both indexes exist in `schema.ts`, so `drizzle-kit generate` reproduces the complete schema.

Two live gaps to carry forward:

1. The two `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements only matter for an **existing** production database created before `name` and `email` were added.
   A generated migration will not emit them, because `schema.ts` declares the columns as part of the table.
   Before running `scripts/migrate-tenant.ts` against a database that already has data, check with `\d client_snapshots` in `psql` that `name` and `email` exist.
   Step 24 of this task covers that check.
2. `job_state` (the table behind `src/db/state.repository.ts`, added in Task 5) exists in **neither** the DDL nor `schema.ts` today.
   The task that adds `src/db/state.repository.ts` must add the table to `src/db/schema.ts` and then re-run `bun run db:generate` to emit a second migration file.
   `tests/migrations.test.ts` from Step 1 of this task must gain `"job_state"` in its `REQUIRED_TABLES` list at the same time.

### The repository layer needs no change

Read the first lines of every file in `src/repositories/`:

- `line-group.repository.ts:2` `import type { DrizzleDb } from "../db/connection";`
- `line-user.repository.ts:2,13-14` `export async function recordLineUserRequest(db: DrizzleDb, ...)`
- `recipient.repository.ts:2,16-19` `export async function seedFromEnv(db: DrizzleDb, envValue: string)`
- `report-range.repository.ts:2,13-18` `export async function getRangeSnapshot(db: DrizzleDb, ...)`
- `request-snapshot.repository.ts:2,16-20` `export async function insertRequestSnapshot(db: DrizzleDb, ...)`
- `snapshot.repository.ts:2,8` `export async function countByDate(db: DrizzleDb, date: string)`

Every exported repository function already takes `db: DrizzleDb` as its first parameter and never calls `getDb()` itself.
`export type DrizzleDb` keeps the same name and the same `PostgresJsDatabase<typeof schema>` definition after the rewrite.
**Confirmed: no file under `src/repositories/` is modified by this task.**

### Why `getDb()` must keep a process.env fallback

`tests/db-helpers.ts:6-11` builds its own client from `TEST_DATABASE_URL` and never calls `getDb()`:

```ts
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

export async function createTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });
```

So the helper itself is unaffected.
The pressure comes from the tests that drive a route or a job, where the code under test calls `getDb()` with no injection point.
Those tests set `process.env.DATABASE_URL` and rely on `getDb()` picking it up:

- `tests/webhook.test.ts:61` and `:2237` set `process.env.DATABASE_URL = TEST_DATABASE_URL`, then `:1987`, `:2018`, `:2068`, `:2126` call `getDb()`.
- `tests/webhook.test.ts:769-770` sets `process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/none"` and calls `resetDbForTests()` to force a database failure. The fallback must therefore be lazy and re-created after `resetDbForTests()`, never built at module load.
- `tests/health.test.ts:16` sets it, then `/internal/health` calls `getDb()` at `src/routes/internal.ts:26`.
- `tests/line-uids.test.ts:59`, `:245` set it, then `/internal/line-uids` calls `getDb()` at `src/routes/internal.ts:71`.
- `tests/line-groups-endpoint.test.ts:30` sets it, then `/internal/line-groups` calls `getDb()` at `src/routes/internal.ts:85`.
- `tests/webhook-logging.test.ts:154` sets it and closes the fallback pool in `afterEach` at `:169` with the comment at `:167-168`.

The 11 Postgres-backed test files are `webhook`, `webhook-logging`, `line-uids`, `line-groups-endpoint`, `health`, `daily-client-report`, `snapshot.repository`, `line-group.repository`, `line-user.repository`, `recipient.repository` and `sqlite.service`.
With the ALS fallback in place, none of them changes its database wiring.

- [x] **Step 1: Write the migration drift guard test**

Create `apps/api/tests/migrations.test.ts` with this content.

```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The runtime no longer creates tables: initDb is gone and nothing runs DDL at
// boot. drizzle/ is now the only thing that can build a tenant database, so a
// table that falls out of the generated migration set is silent data loss.
const MIGRATIONS_DIR = "drizzle";

const REQUIRED_TABLES = [
  "client_snapshots",
  "notify_recipients",
  "daily_report_notifications",
  "line_users",
  "line_groups",
  "report_range_snapshots",
  "client_request_snapshots",
  "client_request_snapshot_rows",
];

const REQUIRED_INDEXES = ["idx_snapshot_date", "idx_req_snapshot_date"];

function allMigrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf-8"))
    .join("\n");
}

test("every schema.ts table has a CREATE TABLE in drizzle/", () => {
  const sqlText = allMigrationSql();
  for (const table of REQUIRED_TABLES) {
    expect(sqlText).toMatch(
      new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${table}"`),
    );
  }
});

test("both lookup indexes are in drizzle/", () => {
  const sqlText = allMigrationSql();
  for (const index of REQUIRED_INDEXES) {
    expect(sqlText).toContain(`"${index}"`);
  }
});

test("the drizzle journal exists", () => {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: unknown[] };
  expect(journal.entries.length).toBeGreaterThan(0);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun test tests/migrations.test.ts`

Expected: FAIL, all 3 tests.
The failure is `ENOENT: no such file or directory, scandir 'drizzle'`, because `apps/api/drizzle/` does not exist yet.

- [x] **Step 3: Un-ignore drizzle/ and generate the migrations**

`apps/api/.gitignore:18-19` currently reads:

```
# Drizzle Kit generated migrations
drizzle/
```

Replace those two lines with:

```
# Drizzle Kit generated migrations are committed on purpose: they are the only
# thing that builds a tenant database now that boot-time DDL is gone.
# Never hand-edit them, regenerate with `bun run db:generate`.
```

Then generate.
`drizzle.config.ts:1-10` already points at `schema: "./src/db/schema.ts"` and `out: "./drizzle"`, so no config change is needed.
`generate` reads the schema file and writes SQL; it does not connect to a database, so the `dbCredentials.url` at `drizzle.config.ts:8` is irrelevant here.

```bash
cd apps/api
bunx drizzle-kit generate --name init_schema
```

Expected output: `[✓] Your SQL migration file ➜ drizzle/0000_init_schema.sql 🚀`.
Inspect the result before trusting it:

```bash
cd apps/api
ls drizzle drizzle/meta
grep -c "CREATE TABLE" drizzle/0000_init_schema.sql
```

Expected: `drizzle/0000_init_schema.sql` plus `drizzle/meta/_journal.json` and `drizzle/meta/0000_snapshot.json`, and a `CREATE TABLE` count of 8.

- [x] **Step 4: Run the drift guard to verify it passes**

Run: `cd apps/api && bun test tests/migrations.test.ts`
Expected: PASS, 3 pass, 0 fail.

- [x] **Step 5: Commit the generated migrations**

```bash
cd apps/api
git add .gitignore drizzle tests/migrations.test.ts
git commit -m "feat: commit drizzle migrations for tenant DBs"
```

- [x] **Step 6: Move the boot DDL into the test helper**

Add `applyTestSchema` to `apps/api/tests/db-helpers.ts`.
The SQL is copied verbatim from `src/db/connection.ts:22-92`, including the two `ALTER TABLE` statements, so nothing a test relies on changes.
Replace the whole content of `apps/api/tests/db-helpers.ts` with this file.

```ts
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

// Test-only schema builder. This DDL used to live in src/db/connection.ts as
// initDb() and ran on every boot. The Worker has no boot step, so production
// schema now comes from drizzle/ through scripts/migrate-tenant.ts, and the
// test suite keeps this fast idempotent copy instead of running the migrator
// once per test file.
export async function applyTestSchema(
  db: PostgresJsDatabase<Record<string, unknown>> | PostgresJsDatabase<typeof schema>,
): Promise<void> {
  const target = db as PostgresJsDatabase<Record<string, unknown>>;
  await target.execute(sql`
    CREATE TABLE IF NOT EXISTS client_snapshots (
      id              SERIAL PRIMARY KEY,
      snapshot_date   TEXT NOT NULL,
      client_id       INTEGER NOT NULL,
      name            TEXT,
      email           TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(snapshot_date, client_id)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_date
      ON client_snapshots(snapshot_date);
    ALTER TABLE client_snapshots ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE client_snapshots ADD COLUMN IF NOT EXISTS email TEXT;

    CREATE TABLE IF NOT EXISTS notify_recipients (
      id         SERIAL PRIMARY KEY,
      line_uid   TEXT NOT NULL UNIQUE,
      label      TEXT,
      active     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_report_notifications (
      snapshot_date TEXT PRIMARY KEY,
      sent_at       TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS line_users (
      line_uid        TEXT PRIMARY KEY,
      first_seen_at   TIMESTAMP NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
      request_count   INTEGER NOT NULL DEFAULT 1,
      last_event_type TEXT
    );

    CREATE TABLE IF NOT EXISTS line_groups (
      chat_id         TEXT PRIMARY KEY,
      chat_type       TEXT NOT NULL,
      label           TEXT,
      first_seen_at   TIMESTAMP NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
      request_count   INTEGER NOT NULL DEFAULT 1,
      last_event_type TEXT,
      active          INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS report_range_snapshots (
      id         SERIAL PRIMARY KEY,
      period     TEXT NOT NULL,
      from_date  TEXT NOT NULL,
      to_date    TEXT NOT NULL,
      raw_json   TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(period, from_date, to_date)
    );

    CREATE TABLE IF NOT EXISTS client_request_snapshots (
      id            SERIAL PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_req_snapshot_date
      ON client_request_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS client_request_snapshot_rows (
      id          SERIAL PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES client_request_snapshots(id),
      client_id   INTEGER NOT NULL,
      UNIQUE(snapshot_id, client_id)
    );
  `);
}

export async function createTestDb() {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  await db.execute(sql`
    DROP TABLE IF EXISTS line_groups CASCADE;
    DROP TABLE IF EXISTS client_request_snapshot_rows CASCADE;
    DROP TABLE IF EXISTS client_request_snapshots CASCADE;
    DROP TABLE IF EXISTS report_range_snapshots CASCADE;
    DROP TABLE IF EXISTS line_users CASCADE;
    DROP TABLE IF EXISTS daily_report_notifications CASCADE;
    DROP TABLE IF EXISTS notify_recipients CASCADE;
    DROP TABLE IF EXISTS client_snapshots CASCADE;
  `);

  await applyTestSchema(db);

  return { db, client };
}

export async function closeTestDb(client: postgres.Sql) {
  await client.end();
}
```

- [x] **Step 7: Repoint all 8 test files from initDb to applyTestSchema**

Make exactly these edits. Nothing else in these files changes.

`apps/api/tests/daily-client-report.test.ts` line 5, replace:

```ts
import { initDb } from "../src/db/connection";
```

with:

```ts
import { applyTestSchema } from "./db-helpers";
```

and line 42, replace `  await initDb(db);` with `  await applyTestSchema(db);`.

`apps/api/tests/health.test.ts` line 6, replace:

```ts
import { initDb, resetDbForTests } from "../src/db/connection";
```

with:

```ts
import { resetDbForTests } from "../src/db/connection";
import { applyTestSchema } from "./db-helpers";
```

and line 32, replace `    await initDb(db);` with `    await applyTestSchema(db);`.

`apps/api/tests/line-groups-endpoint.test.ts` line 6, replace:

```ts
import { initDb, getDb, resetDbForTests } from "../src/db/connection";
```

with:

```ts
import { getDb, resetDbForTests } from "../src/db/connection";
import { applyTestSchema } from "./db-helpers";
```

and line 16, replace `  await initDb(db);` with `  await applyTestSchema(db);`.

`apps/api/tests/line-uids.test.ts` line 7, replace:

```ts
import { initDb, resetDbForTests, getDb } from "../src/db/connection";
```

with:

```ts
import { resetDbForTests, getDb } from "../src/db/connection";
import { applyTestSchema } from "./db-helpers";
```

and line 51, replace `  await initDb(db);` with `  await applyTestSchema(db);`.

`apps/api/tests/snapshot.repository.test.ts` line 5, replace:

```ts
import { initDb } from "../src/db/connection";
```

with:

```ts
import { applyTestSchema } from "./db-helpers";
```

and line 50, replace `  await initDb(db);` with `  await applyTestSchema(db);`.

`apps/api/tests/webhook-logging.test.ts` line 7, replace:

```ts
import { closeDb, initDb, resetDbForTests } from "../src/db/connection";
```

with:

```ts
import { closeDb, resetDbForTests } from "../src/db/connection";
import { applyTestSchema } from "./db-helpers";
```

and line 109, replace `  await initDb(db);` with `  await applyTestSchema(db);`.

`apps/api/tests/webhook.test.ts` line 7, replace:

```ts
import { initDb, resetDbForTests } from "../src/db/connection";
```

with:

```ts
import { resetDbForTests } from "../src/db/connection";
import { applyTestSchema } from "./db-helpers";
```

and line 53, replace `  await initDb(db);` with `  await applyTestSchema(db);`.

`apps/api/tests/sqlite.service.test.ts` line 5, replace:

```ts
import { initDb } from "../src/db/connection";
```

with:

```ts
import { applyTestSchema } from "./db-helpers";
```

In the same file replace line 33 `test("initDb creates tables and indexes", async () => {` with:

```ts
test("applyTestSchema creates tables and indexes", async () => {
```

replace line 34 `  await initDb(db);` with `  await applyTestSchema(db);`,
replace line 62 `  await initDb(db);` with `  await applyTestSchema(db);`,
replace line 78 with:

```ts
test("applyTestSchema is idempotent, calling twice does not error", async () => {
```

and replace lines 79-80 with:

```ts
  await applyTestSchema(db);
  await expect(applyTestSchema(db)).resolves.toBeUndefined();
```

- [x] **Step 8: Run the full suite to verify nothing regressed**

Start the test database from the repo root first:

```bash
docker compose up -d postgres-test
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
cd apps/api
bun test
```

Expected: PASS, the same test count as before plus the 3 from `tests/migrations.test.ts`.
`initDb` is still exported at this point, just unused by the test suite.

- [x] **Step 9: Commit the test-helper move**

```bash
cd apps/api
git add tests/db-helpers.ts tests/daily-client-report.test.ts tests/health.test.ts \
  tests/line-groups-endpoint.test.ts tests/line-uids.test.ts \
  tests/snapshot.repository.test.ts tests/sqlite.service.test.ts \
  tests/webhook-logging.test.ts tests/webhook.test.ts
git commit -m "test: move boot DDL into applyTestSchema helper"
```

- [x] **Step 10: Drop initDb from the seed script**

`apps/api/scripts/seed-mock-client-snapshots.ts` line 3, replace:

```ts
import { getDb, initDb, closeDb } from "../src/db/connection";
```

with:

```ts
import { getDb, closeDb } from "../src/db/connection";
```

Then replace lines 105-106:

```ts
  const db = getDb();
  await initDb(db);
```

with:

```ts
  // Schema comes from drizzle/ now, not from the app. Run
  // `bun run migrate:maow` (or the matching tenant) before seeding.
  const db = getDb();
```

Verify the script still typechecks:

```bash
cd apps/api
bun run typecheck
```

Expected: no errors.

- [x] **Step 11: Write the failing test for the new connection layer**

Create `apps/api/tests/db-connection.test.ts` with this content.

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as connectionMod from "../src/db/connection";
import {
  closeDb,
  getDb,
  openDb,
  resetDbForTests,
  runWithDb,
  type DbHandle,
} from "../src/db/connection";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://jametirakarn@localhost:5432/hfm_test";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let handles: DbHandle[] = [];

function track(handle: DbHandle): DbHandle {
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  handles = [];
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  resetDbForTests();
});

afterEach(async () => {
  // Each openDb() and each getDb() fallback opens a real pool. Close them or
  // the files running after this one hit "too many clients".
  for (const handle of handles) await handle.dispose();
  await closeDb();
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  resetDbForTests();
});

test("openDb returns a working handle", async () => {
  const handle = track(openDb(TEST_DATABASE_URL));

  const rows = await handle.db.execute(sql`SELECT 1 AS one`);
  expect(rows[0]!.one).toBe(1);
});

test("dispose resolves and is safe to await", async () => {
  const handle = openDb(TEST_DATABASE_URL);
  await handle.db.execute(sql`SELECT 1`);

  await expect(handle.dispose()).resolves.toBeUndefined();
});

test("runWithDb scopes getDb to the handle", () => {
  const handle = track(openDb(TEST_DATABASE_URL));

  const scoped = runWithDb(handle, () => getDb());
  expect(scoped).toBe(handle.db);
});

test("the scope wins even after the fallback was created", () => {
  const fallback = getDb();
  const handle = track(openDb(TEST_DATABASE_URL));

  const scoped = runWithDb(handle, () => getDb());
  expect(scoped).toBe(handle.db);
  expect(scoped).not.toBe(fallback);
  expect(getDb()).toBe(fallback);
});

test("runWithDb survives an await inside the callback", async () => {
  const handle = track(openDb(TEST_DATABASE_URL));

  const scoped = await runWithDb(handle, async () => {
    await handle.db.execute(sql`SELECT 1`);
    return getDb();
  });
  expect(scoped).toBe(handle.db);
});

test("getDb falls back to process.env.DATABASE_URL and caches it", async () => {
  const first = getDb();
  const second = getDb();

  expect(first).toBe(second);
  const rows = await first.execute(sql`SELECT 1 AS one`);
  expect(rows[0]!.one).toBe(1);
});

test("resetDbForTests forces a new fallback client", () => {
  const first = getDb();
  resetDbForTests();
  const second = getDb();

  expect(second).not.toBe(first);
});

test("getDb throws when there is no scope and no DATABASE_URL", () => {
  delete process.env.DATABASE_URL;
  resetDbForTests();

  expect(() => getDb()).toThrow("DATABASE_URL is not set");
});

test("initDb is gone from the runtime path", () => {
  expect("initDb" in connectionMod).toBe(false);
});
```

- [x] **Step 12: Run it to verify it fails**

Run: `cd apps/api && bun test tests/db-connection.test.ts`

Expected: FAIL.
Bun fails at import time with `SyntaxError: Export named 'openDb' not found in module '.../src/db/connection.ts'.`

- [x] **Step 13: Rewrite src/db/connection.ts**

Replace the whole content of `apps/api/src/db/connection.ts` (currently 106 lines) with this file.

```ts
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

/** Per-invocation. `dispose()` MUST be handed to ctx.waitUntil(). */
export interface DbHandle {
  db: DrizzleDb;
  dispose: () => Promise<void>;
}

// One client per Worker invocation. Hyperdrive owns the real pool and the warm
// origin connections, so this client only has to outlive a single fetch,
// scheduled or queue call.
//
// max 5, never higher: a Worker may keep at most 6 outbound connections waiting
// for response headers at once, and the LINE reply and HFM fetches compete for
// that same budget. 5 leaves exactly one slot for the reply that pays the
// 60s reply-token deadline.
// fetch_types false: skips the type-introspection round trip postgres.js
// otherwise makes on connect. We use no custom array types.
// prepare true: Hyperdrive can only cache prepared statements, and an unnamed
// statement defeats its pool.
export function openDb(connectionString: string): DbHandle {
  const client = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    prepare: true,
  });
  const db = drizzle(client, { schema });
  return { db, dispose: () => client.end() };
}

const dbStorage = new AsyncLocalStorage<DbHandle>();

/** ALS-scoped accessor so existing call sites keep using `getDb()` with no args. */
export function runWithDb<T>(handle: DbHandle, fn: () => T): T {
  return dbStorage.run(handle, fn);
}

// Fallback client for `bun test` and the bun scripts in scripts/, which run in
// a normal process with no Worker bindings and no ALS scope. Built lazily, so
// a test can set process.env.DATABASE_URL, call resetDbForTests() and get a
// client for the new URL (tests/webhook.test.ts:769-770 depends on exactly
// that to simulate a dead database).
let _client: postgres.Sql | null = null;
let _db: DrizzleDb | null = null;

export function getDb(): DrizzleDb {
  const scoped = dbStorage.getStore();
  if (scoped) return scoped.db;

  if (_db) return _db;
  const connUrl = process.env.DATABASE_URL;
  if (!connUrl) throw new Error("DATABASE_URL is not set");
  _client = postgres(connUrl, { max: 5, fetch_types: false, prepare: true });
  _db = drizzle(_client, { schema });
  return _db;
}

/** Closes the process.env fallback client. Scripts and tests only. */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export function resetDbForTests(): void {
  _client = null;
  _db = null;
}
```

`initDb` is deleted with this rewrite.
No file under `src/` calls it any more after Step 14.

- [x] **Step 14: Drop initDb from src/index.ts**

`apps/api/src/index.ts` line 7, replace:

```ts
import { getDb, initDb, closeDb } from "./db/connection";
```

with:

```ts
import { closeDb } from "./db/connection";
```

Then delete lines 11 and 12 together with the blank line that follows them:

```ts
const db = getDb();
await initDb(db);
```

The file keeps everything else, including the middleware at `:14-28`, the route mounts at `:30-31`, `registerJobs()` at `:33` and the shutdown handlers at `:43-49`.
`src/index.ts` itself is deleted at the end of the migration by the worker task.

- [x] **Step 15: Run the connection test to verify it passes**

```bash
docker compose up -d postgres-test   # from the repo root, if not already running
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
cd apps/api
bun test tests/db-connection.test.ts
```

Expected: PASS, 9 pass, 0 fail.

- [x] **Step 16: Run the full suite and the typechecker**

```bash
cd apps/api
bun run typecheck
bun test
```

Expected: typecheck clean, every test file green.
If `tests/webhook.test.ts` reports `too many clients already`, a handle or the fallback client was left open; check the `afterEach` in `tests/db-connection.test.ts`.

- [x] **Step 17: Commit the connection rewrite**

```bash
cd apps/api
git add src/db/connection.ts src/index.ts scripts/seed-mock-client-snapshots.ts tests/db-connection.test.ts
git commit -m "feat: per-invocation db handle with ALS scope"
```

- [x] **Step 18: Add the tenant migration script**

Create `apps/api/scripts/migrate-tenant.ts` with this content.

```ts
// Applies apps/api/drizzle/*.sql to one tenant database.
//
// This talks to the tenant Postgres DIRECTLY, never through Hyperdrive.
// Hyperdrive is a Workers binding with no CLI surface, its query cache does not
// invalidate on write, and DDL behind a shared pool is the wrong place to take
// a migration lock. Point DATABASE_URL_<TENANT> at the origin database.
//
// Usage: bun run scripts/migrate-tenant.ts maow
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const tenant = process.argv[2];
if (!tenant) {
  console.error("usage: bun run scripts/migrate-tenant.ts <tenant>");
  process.exit(1);
}

const envName = `DATABASE_URL_${tenant.toUpperCase().replace(/-/g, "_")}`;
const url = process.env[envName];
if (!url) {
  console.error(`[migrate] ${envName} is not set`);
  process.exit(1);
}

// max 1: a migration is strictly serial and drizzle takes its own lock.
const client = postgres(url, { max: 1 });
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log(`[migrate] migrations applied to ${tenant}`);
} catch (error) {
  console.error(`[migrate] failed for ${tenant}:`, error);
  process.exitCode = 1;
} finally {
  await client.end();
}
```

Add the scripts to `apps/api/package.json`.
Replace the `"db:push"` line (currently line 11) with:

```json
    "db:generate": "bunx drizzle-kit generate",
    "migrate:maow": "bun --env-file=.env.maow.admin run scripts/migrate-tenant.ts maow",
    "migrate:simple-trade": "bun --env-file=.env.simple-trade.admin run scripts/migrate-tenant.ts simple-trade",
```

`db:push` is removed on purpose.
`drizzle-kit push` diffs straight against a live database and never writes a file, so it would silently undo the whole point of committing `drizzle/`.

- [x] **Step 19: Smoke-test the migration script against the test database**

Run it against a scratch database so a real tenant is never touched:

```bash
docker compose up -d postgres-test   # from the repo root
cd apps/api
psql postgresql://test:test@localhost:5433/hfm_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
DATABASE_URL_SCRATCH=postgresql://test:test@localhost:5433/hfm_test \
  bun run scripts/migrate-tenant.ts scratch
```

Expected output: `[migrate] migrations applied to scratch`.
Verify the tables landed:

```bash
psql postgresql://test:test@localhost:5433/hfm_test -c "\dt"
```

Expected: the 8 application tables are listed.
Run it a second time and confirm it is a no-op that still prints `[migrate] migrations applied to scratch`, because drizzle records applied migrations in its own `drizzle.__drizzle_migrations` table.

- [x] **Step 20: Commit the migration script**

```bash
cd apps/api
git add scripts/migrate-tenant.ts package.json
git commit -m "feat: add per-tenant drizzle migration script"
```

- [ ] **Step 21: Create one Hyperdrive config per tenant**
> Awaiting operator: real Cloudflare resources and the tenant origin DB URLs (`wrangler hyperdrive create` per tenant, never from this session).

These are operator commands, not code.
Run them once per tenant with the origin Postgres credentials for that tenant.
Never paste a real connection string into a file in this repo.

```bash
cd apps/api
bunx wrangler hyperdrive create hfm-maow \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DBNAME" \
  --caching-disabled

bunx wrangler hyperdrive create hfm-simple-trade \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DBNAME" \
  --caching-disabled

bunx wrangler hyperdrive list
```

Each command prints an `id`.
Those two ids go into the `hyperdrive` binding of `wrangler.maow.jsonc` and `wrangler.simple-trade.jsonc`, both under the binding name `HYPERDRIVE`, which is owned by the wrangler-config task.

`--caching-disabled` is not optional here.
Hyperdrive query caching is ON by default with a 60s `max_age`, and it does **not** invalidate on write.
This app reads its own writes on every important path:

- `src/jobs/daily-client-report.ts:250` calls `countByDate(db, today)`, then `:261` calls `insertMany(db, today, ...)`. A cached count would make the next invocation insert the same day twice.
- `src/routes/webhook.ts:698` calls `recordLineGroupEvent(getDb(), ...)` and the operator immediately reads the new group from `GET /internal/line-groups` (`src/routes/internal.ts:86`) to fill `LINE_GROUP_WHITELIST_IDS`, which `.env.example:17-18` documents as the only way to learn a group ID.
- the `job_state` table (Task 5) is a write-then-read edge detector. A 60s stale read resurrects the previous state and re-sends the "HFM down" alert.

If a caching config is ever wanted for a genuinely read-only query, create a second Hyperdrive config and a second binding; never flip caching on for `HYPERDRIVE`.

Note: the Wrangler CLI is a Node CLI and running it through `bunx` is not verified by Cloudflare docs.
If `bunx wrangler` misbehaves, put the same command in a package.json script and run it with `bun run`, which is the form the deploy scripts already use.

- [x] **Step 22: Document the local dev and migration env vars**

Add these lines to `apps/api/.env.example`, after line 23 (`TEST_DATABASE_URL=...`):

```
# Local `wrangler dev` only. Wrangler resolves the HYPERDRIVE binding from this
# variable when it runs without --remote; the suffix is the binding name.
# It beats localConnectionString in the wrangler config. With it, the Worker
# talks to Postgres directly: no pooling and no query caching apply locally.
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://user:password@localhost:5432/hfm

# Direct origin URLs for scripts/migrate-tenant.ts only. Never Hyperdrive URLs.
DATABASE_URL_MAOW=postgresql://user:password@host:5432/hfm_maow
DATABASE_URL_SIMPLE_TRADE=postgresql://user:password@host:5432/hfm_simple_trade
```

Local dev then works like this:

```bash
cd apps/api
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://user:password@localhost:5432/hfm"
bun run dev:maow
```

- [x] **Step 23: State where dispose() is handed to ctx.waitUntil**

No code in this task calls `ctx.waitUntil`.
`src/worker.ts` is owned by the worker task, and that task must open and dispose the handle in every one of the three entrypoints:

```ts
// src/worker.ts - owned by the worker task, shown here as the contract for dispose()
const handle = openDb(env.HYPERDRIVE.connectionString);
const work = runWithDb(handle, async () => {
  // fetch(), scheduled() or queue() body goes here
});
ctx.waitUntil(work.finally(() => handle.dispose()));
return await work;
```

The dispose call must be chained onto the end of the deferred work, not passed to `ctx.waitUntil` as a separate task.
`ctx.waitUntil` tasks run concurrently, so a separate `ctx.waitUntil(handle.dispose())` would close the client while queries are still in flight.
The whole extension is capped at 30s after the response, which is well inside the 60s LINE reply-token window.

- [ ] **Step 24: Check the production databases before the first migrate**
> Awaiting operator: the tenant origin DB URLs (`DATABASE_URL_MAOW` / `DATABASE_URL_SIMPLE_TRADE`); no production database may be touched here.

Before `bun run migrate:maow` or `bun run migrate:simple-trade` touches a database that already holds data, confirm the two historic columns are present:

```bash
psql "$DATABASE_URL_MAOW" -c "\d client_snapshots"
```

Expected: the column list contains `name` and `email`.
Those two came from `ALTER TABLE client_snapshots ADD COLUMN IF NOT EXISTS ...` in the old `initDb` (`src/db/connection.ts:34-35`) and the generated migration does not repeat them.
If either column is missing, add it by hand in `psql` with `ALTER TABLE client_snapshots ADD COLUMN IF NOT EXISTS name TEXT;` before migrating.
Do not hand-edit anything under `apps/api/drizzle/`: that directory is generated by `bun run db:generate` from `src/db/schema.ts`, and the repo rule in `AGENTS.md` forbids editing it.

Then run the migration per tenant:

```bash
cd apps/api
# DATABASE_URL_MAOW and DATABASE_URL_SIMPLE_TRADE come from the git-ignored
# .env.<tenant>.admin files created in Task 9 (see Task 9 Step 10).
bun run migrate:maow
bun run migrate:simple-trade
```

Expected: `[migrate] migrations applied to maow` and `[migrate] migrations applied to simple-trade`.

- [x] **Step 25: Final verification and commit**
> Deviation: the literal `grep -rn "initDb" tests scripts` still shows 4 lines that are the plan's own reference code from Steps 1, 6 and 11 (the `initDb is gone from the runtime path` guard test and two comments). The step's intent holds: no live import or call remains - `grep -rn "initDb" src` and `grep -rn "max: 10" src` both return nothing.

```bash
cd apps/api
grep -rn "initDb" src tests scripts
grep -rn "max: 10" src
bun run typecheck
bun test
```

Expected: both greps return no output, typecheck is clean, and the whole suite passes.

```bash
cd apps/api
git add .env.example
git commit -m "docs: document hyperdrive and tenant migrate vars"
```

## Interface notes for Tasks 5, 6 and 7

Tasks 5, 6 and 7 introduce these names. Later tasks rely on them.

| Addition | Where | Why |
| --- | --- | --- |
| `src/cache/kv.ts` (NEW): `KvCache`, `runWithCache`, `getCache` | Task 5 Step 3 | `refreshLastTradeCache()` is already called with no arguments by `dispatchCron` in Task 6, and the queue consumer calls `getLastTradeMapWithin(deadlineMs)` with no binding argument. The KV binding therefore has to arrive through an async scope, exactly like `runWithDb`. |
| `GetLastTradeMapOptions.kv?: KvCache \| null` | Task 5 Step 4 | Test seam. Overrides the ambient binding; `undefined` means "use the scope". |
| `refreshLastTradeCache(options?): Promise<number \| null>` | Task 5 Step 4 | The cron-side writer. Already referenced by Task 6 Step 3. |
| `LAST_TRADE_KV_KEY = "last-trade:v1"` | Task 5 Step 4 | Exported so the tenant configs and tests use one literal. |
| `jobState` table in `src/db/schema.ts` | Task 5 Step 8 | Backs `getJobState` / `setJobState` from the contract. |
| `RunHfmHealthCheckOptions.getStateFn` / `.setStateFn` | Task 5 Step 15 | Keeps the health-check tests free of a real database, the way `db`, `getUidsFn` and `pushToAllFn` already are. |
| `LAST_HEALTHY_KEY = "hfm_healthcheck:last_healthy"` | Task 5 Step 15 | Replaces the `lastHealthy` module flag. `__resetHealthState()` is deleted with it. |
| `isTimeoutError(e)` in `src/services/hfm.service.ts` | Task 7 Step 8 | `AbortSignal.timeout()` aborts with `TimeoutError`, not `AbortError`. |
| `fetchClients` default timeout drops from `120_000` to `30_000` | Task 7 Step 10 | 120s is longer than LINE's whole 60s reply-token window. |
| `REPLY_FETCH_TIMEOUT_MS` / `CRON_FETCH_TIMEOUT_MS` in `src/jobs/daily-client-report.ts` | Task 7 Step 18 | Explicit per-path ceilings instead of one inherited default. |

**Wiring.** Task 6 Step 6 opens this scope: `withScope` in `src/worker.ts` wraps every handler
in `runWithDb(handle, () => runWithCache(env.CACHE, fn))`. Without it `getCache()` returns
`null` in production and every reply falls back to a live HFM fetch.

**Note on `src/db/state.repository.ts`.** The contract lists it as NEW without an owner.
It is created here, in Task 5 Step 11, because Task 5 is its only consumer.
If Task 4 has already created it with the contract signature, skip that part of Step 11 and run its test.

---

## Task 5: Replace module-level mutable state with durable state

Three module-level singletons decide behaviour today.
An isolate is created and evicted at any time, so all three are unreliable on Workers.
Each one gets a different store, chosen from what the value actually needs.

| State | File:line today | New store | Reason |
| --- | --- | --- | --- |
| `cache` + `inflight` last-trade map | `src/services/last-trade.service.ts:17-18` | Workers KV, written by the `*/5` cron, with an in-isolate memo as L1 | Shared across isolates and colos, tolerates a staleness window, read by every customer lookup. |
| `lastHealthy` up/down flag | `src/jobs/hfm-healthcheck.ts:13` | PostgreSQL `job_state` row | Edge detection has to read back its own last write. KV cannot promise that. |
| `warnedFlexVersion` log guard | `src/builders/flex-message.builder.ts:33` | Unchanged, stays in module scope | Losing it on isolate eviction only means one extra warning per isolate. Correctness does not depend on it. |

**Why KV for the map but the database for the flag.**
KV is eventually consistent: "Changes may take up to 60 seconds or more to be visible in other
global network locations" (<https://developers.cloudflare.com/kv/concepts/how-kv-works/>).
For a map that a cron refreshes every 5 minutes, a 60 second window is inside the staleness
budget that already exists today.
For an up/down flag read and written by a cron that fires every 5 minutes, a 60 second window
is a correctness bug: a tick could read the pre-write value, decide the state changed again and
send a second "HFM API down" alert.
The database row is read-after-write correct, and one extra query every 5 minutes costs nothing.

**Files:**
- Create: `apps/api/src/cache/kv.ts`
- Create: `apps/api/tests/last-trade-kv.test.ts`
- Rewrite: `apps/api/src/services/last-trade.service.ts`
- Modify: `apps/api/src/db/schema.ts` (append one table)
- Create: `apps/api/src/db/state.repository.ts`
- Create: `apps/api/tests/state.repository.test.ts`
- Modify: `apps/api/tests/db-helpers.ts:14`, `:86-92`
- Modify: `apps/api/src/db/connection.ts:86-92`
- Modify: `apps/api/tests/sqlite.service.test.ts:42-49`
- Rewrite: `apps/api/src/jobs/hfm-healthcheck.ts`
- Rewrite: `apps/api/tests/hfm-healthcheck.test.ts`
- Modify: `apps/api/src/builders/flex-message.builder.ts:31-37`
- Modify: `apps/api/tests/flex-message.builder.test.ts:433-447`

### 5a. The last-trade map moves to KV

Read `src/services/last-trade.service.ts` in full before starting.
The current shape is a 5 minute TTL (`:5`, `:45`), a 15s fetch timeout (`:6`), a 3 attempt
retry ladder with 1s and 2s backoff (`:7-8`, `:105-121`), single-flight de-duplication
(`:49-54`) and stale-while-revalidate (`:56-65`).
A cold cache costs up to 3 x 15s + 3s = ~48s, which is why `getLastTradeMapWithin` exists.

On Workers the cold-isolate path is the normal path, not the exception, because the isolate
that serves a lookup is usually not the isolate that ran the last cron tick.
**This step removes the cold-isolate ~7s `/api/clients/` hit from the customer reply path
completely.** The `*/5 * * * *` cron writes the whole map to KV under `last-trade:v1`, and a
lookup reads that key instead of calling HFM.
The read order is: in-isolate memo, then KV, then and only then a live fetch.

**One writer, so the KV write limit is not a risk.** KV allows one write per second per key
(<https://developers.cloudflare.com/kv/platform/limits/>).
Only `refreshLastTradeCache()` writes `last-trade:v1`, and only the 5 minute cron calls it,
so the key is written once per 300 seconds per tenant.
Nothing in the request path writes it.

**These nine existing tests must still pass unchanged** (`tests/last-trade.service.test.ts`):

1. `getLastTradeMap > maps row.id -> last_trade on a successful fetch`
2. `getLastTradeMap > retries within one call when the first fetch flakes then succeeds`
3. `getLastTradeMap > returns null after 3 failed attempts with no cache`
4. `getLastTradeMap > serves stale cache immediately and refreshes in the background`
5. `getLastTradeMap > does not refetch while the cache is fresh`
6. `getLastTradeMap > coalesces concurrent callers into one in-flight fetch`
7. `getLastTradeMapWithin > returns the map when the fetch finishes inside the deadline`
8. `getLastTradeMapWithin > returns null at the deadline instead of blocking on a slow fetch`
9. `getLastTradeMapWithin > background refresh still warms the cache after the deadline fires`

They keep passing because they never pass a `kv` option and no `runWithCache` scope is open
under `bun test`, so `getCache()` returns `null` and the old single-flight path runs untouched.

- [x] **Step 1: Write the failing KV test**

Create `apps/api/tests/last-trade-kv.test.ts`:

```ts
import { expect, test, describe, beforeEach, afterAll, mock } from "bun:test";
import {
  getLastTradeMap,
  refreshLastTradeCache,
  resetLastTradeCache,
  LAST_TRADE_KV_KEY,
} from "../src/services/last-trade.service";
import { runWithCache, type KvCache } from "../src/cache/kv";
import type { HFMClientsResult, HFMClientRow } from "../src/types/hfm.types";

function makeRow(overrides: Partial<HFMClientRow>): HFMClientRow {
  return { id: 0, wallet: 0, last_trade: null, ...overrides } as HFMClientRow;
}

interface FakeKv extends KvCache {
  store: Map<string, string>;
  puts: { key: string; value: string; options?: { expirationTtl?: number } }[];
  gets: { key: string; options: { type: "json"; cacheTtl?: number } }[];
}

function fakeKv(seed?: unknown): FakeKv {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(LAST_TRADE_KV_KEY, JSON.stringify(seed));
  const kv: FakeKv = {
    store,
    puts: [],
    gets: [],
    async get(key, options) {
      kv.gets.push({ key, options });
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key, value, options) {
      kv.puts.push({ key, value, options });
      store.set(key, value);
    },
  };
  return kv;
}

describe("last-trade KV cache", () => {
  beforeEach(() => {
    resetLastTradeCache();
  });

  // bun test shares one process across files, so a populated memo would leak
  // into tests/webhook-logging.test.ts and hide its deadline assertions.
  afterAll(() => {
    resetLastTradeCache();
  });

  test("reads the map from KV and never calls HFM", async () => {
    const kv = fakeKv({
      v: 1,
      fetchedAt: Date.now(),
      entries: [[101, "2026-07-19T10:00:00Z"], [202, null]],
    });
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({ ok: true, data: [] }),
    );

    const map = await getLastTradeMap({ kv, fetchClientsFn });

    expect(map!.get(101)).toBe("2026-07-19T10:00:00Z");
    expect(map!.get(202)).toBeNull();
    expect(fetchClientsFn).toHaveBeenCalledTimes(0);
    expect(kv.gets[0]).toEqual({
      key: LAST_TRADE_KV_KEY,
      options: { type: "json", cacheTtl: 60 },
    });
  });

  test("picks the binding up from runWithCache", async () => {
    const kv = fakeKv({ v: 1, fetchedAt: Date.now(), entries: [[7, "T"]] });
    const map = await runWithCache(kv, () => getLastTradeMap());
    expect(map!.get(7)).toBe("T");
  });

  test("falls back to exactly one live fetch on a KV miss", async () => {
    const kv = fakeKv();
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: false,
        reason: "server_error",
      }),
    );

    const map = await getLastTradeMap({ kv, fetchClientsFn });

    expect(map).toBeNull();
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("serves the memo instead of refetching after a KV miss", async () => {
    const kv = fakeKv();
    let now = 0;
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 101, last_trade: "A" })],
      }),
    );

    await getLastTradeMap({ kv, fetchClientsFn, nowMs: () => now });
    now = 6 * 60 * 1000; // past the 5 minute memo TTL
    const second = await getLastTradeMap({ kv, fetchClientsFn, nowMs: () => now });

    expect(second!.get(101)).toBe("A");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("a KV read failure degrades to a live fetch", async () => {
    const kv = fakeKv();
    kv.get = async () => {
      throw new Error("kv down");
    };
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [makeRow({ id: 5, last_trade: "B" })],
      }),
    );

    const map = await getLastTradeMap({ kv, fetchClientsFn });

    expect(map!.get(5)).toBe("B");
    expect(fetchClientsFn).toHaveBeenCalledTimes(1);
  });

  test("refreshLastTradeCache writes the whole map with a 900s TTL", async () => {
    const kv = fakeKv();
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: true,
        data: [
          makeRow({ id: 101, last_trade: "A" }),
          makeRow({ id: 202, last_trade: null }),
        ],
      }),
    );

    const size = await refreshLastTradeCache({
      kv,
      fetchClientsFn,
      nowMs: () => 1_000,
    });

    expect(size).toBe(2);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe(LAST_TRADE_KV_KEY);
    expect(kv.puts[0]!.options).toEqual({ expirationTtl: 900 });
    expect(JSON.parse(kv.puts[0]!.value)).toEqual({
      v: 1,
      fetchedAt: 1_000,
      entries: [[101, "A"], [202, null]],
    });
  });

  test("refreshLastTradeCache retries three times without sleeping", async () => {
    const kv = fakeKv();
    let calls = 0;
    const fetchClientsFn = mock(async (): Promise<HFMClientsResult> => {
      calls += 1;
      if (calls < 3) return { ok: false, reason: "server_error" };
      return { ok: true, data: [makeRow({ id: 9, last_trade: "C" })] };
    });

    const startedAt = Date.now();
    const size = await refreshLastTradeCache({ kv, fetchClientsFn });
    const elapsed = Date.now() - startedAt;

    expect(size).toBe(1);
    expect(calls).toBe(3);
    expect(elapsed).toBeLessThan(100);
  });

  test("refreshLastTradeCache writes nothing when every attempt fails", async () => {
    const kv = fakeKv();
    const fetchClientsFn = mock(
      async (): Promise<HFMClientsResult> => ({
        ok: false,
        reason: "server_error",
      }),
    );

    const size = await refreshLastTradeCache({ kv, fetchClientsFn });

    expect(size).toBeNull();
    expect(kv.puts).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/last-trade-kv.test.ts
```

Expected: FAIL with

```text
error: Cannot find module '../src/cache/kv' from '/.../apps/api/tests/last-trade-kv.test.ts'
```

- [x] **Step 3: Create the KV scope**

Create `apps/api/src/cache/kv.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structural subset of the Workers KVNamespace binding used by this codebase.
 * Declared locally so `src/` still typechecks under `bun test`, where the
 * Cloudflare types are not loaded, and so tests can pass a plain fake.
 */
export interface KvCache {
  get(
    key: string,
    options: { type: "json"; cacheTtl?: number },
  ): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

// Request-scoped, never module-scoped: an isolate is shared by many requests
// and is evicted at any time, so the binding is carried in the async scope the
// Worker entrypoint opens, exactly like the config and the database handle.
const storage = new AsyncLocalStorage<KvCache | null>();

export function runWithCache<T>(kv: KvCache | null, fn: () => T): T {
  return storage.run(kv, fn);
}

/**
 * Returns the KV binding for this invocation, or null when there is no scope.
 * `bun test` and the local scripts run without a scope, so every caller must
 * treat null as "no shared cache" and fall back to a live fetch.
 */
export function getCache(): KvCache | null {
  return storage.getStore() ?? null;
}
```

- [x] **Step 4: Rewrite the last-trade service**

Replace the whole of `apps/api/src/services/last-trade.service.ts`:

```ts
import { fetchClients } from "./hfm.service";
import { logError, logInfo } from "../utils/logger";
import { getCache, type KvCache } from "../cache/kv";
import type { HFMClientsResult } from "../types/hfm.types";

const FRESH_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000]; // between attempts 1->2 and 2->3

// One blob per tenant. The version suffix lets the payload shape change
// without reading a stale object written by the previous deployment.
export const LAST_TRADE_KV_KEY = "last-trade:v1";
// 15 minutes: three */5 cron ticks may fail before the blob disappears.
const KV_TTL_SECONDS = 900;
// KV's own per-colo read cache. 60s is the default and 30s is the floor.
const KV_CACHE_TTL_SECONDS = 60;

type LastTradeMap = Map<number, string | null>;

interface CacheEntry {
  map: LastTradeMap;
  fetchedAt: number;
}

// Serialized shape of the KV blob. A Map is not JSON, so it travels as entries.
interface LastTradePayload {
  v: 1;
  fetchedAt: number;
  entries: [number, string | null][];
}

// L1 only. An isolate is created and evicted at any time, so this memo is a
// best-effort read-through in front of KV and is never the source of truth.
let memo: CacheEntry | null = null;
let inflight: Promise<LastTradeMap | null> | null = null;

export interface GetLastTradeMapOptions {
  fetchClientsFn?: () => Promise<HFMClientsResult>;
  sleepFn?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  // Overrides the ambient binding from runWithCache(). Tests pass a fake.
  kv?: KvCache | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function resetLastTradeCache(): void {
  memo = null;
  inflight = null;
}

function toEntries(result: {
  data: { id: number; last_trade: string | null }[];
}): [number, string | null][] {
  return result.data.map((row) => [row.id, row.last_trade]);
}

// Fetches the account-id -> last_trade map. On Workers the */5 cron owns the
// refresh and this call is a KV read, so the customer reply path never pays
// the ~7s HFM /api/clients/ round trip on a cold isolate. Returns null only
// when KV is empty and the live fallback fetch fails too.
export async function getLastTradeMap(
  options: GetLastTradeMapOptions = {},
): Promise<LastTradeMap | null> {
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepFn ?? defaultSleep;
  const fetchClientsFn =
    options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));
  const kv = options.kv !== undefined ? options.kv : getCache();

  if (memo && now() - memo.fetchedAt < FRESH_TTL_MS) {
    return memo.map;
  }

  if (kv) return readThroughKv(kv, fetchClientsFn, now);

  // No KV binding in scope: bun test, scripts and local runs keep the original
  // single-flight, stale-while-revalidate behaviour of the Bun server.
  if (!inflight) {
    inflight = refresh(fetchClientsFn, sleep, now).finally(() => {
      inflight = null;
    });
  }
  const refreshing = inflight;

  if (memo) {
    refreshing.catch((err) => logError("last-trade", err));
    return memo.map;
  }

  return refreshing;
}

// KV path. No retry ladder and no background promise on purpose: work that is
// not awaited is cancelled when the invocation ends, and resuming it inside a
// later invocation raises "Cannot perform I/O on behalf of a different
// request". Retries live in refreshLastTradeCache(), which the cron awaits.
async function readThroughKv(
  kv: KvCache,
  fetchClientsFn: () => Promise<HFMClientsResult>,
  now: () => number,
): Promise<LastTradeMap | null> {
  try {
    const payload = (await kv.get(LAST_TRADE_KV_KEY, {
      type: "json",
      cacheTtl: KV_CACHE_TTL_SECONDS,
    })) as LastTradePayload | null;

    if (payload && Array.isArray(payload.entries)) {
      const map: LastTradeMap = new Map(payload.entries);
      memo = {
        map,
        fetchedAt:
          typeof payload.fetchedAt === "number" ? payload.fetchedAt : now(),
      };
      return map;
    }
  } catch (err) {
    logError("last-trade", err);
  }

  // KV miss: the cron has not run yet, or the blob expired after 15 minutes.
  if (memo) return memo.map;

  const result = await fetchClientsFn();
  if (result.ok) {
    const map: LastTradeMap = new Map(toEntries(result));
    memo = { map, fetchedAt: now() };
    return map;
  }
  logError(
    "last-trade",
    `last-trade KV miss and live fetch failed (${result.reason})`,
  );
  return null;
}

// Cron-side refresh. Writes the whole map to KV so every isolate in every colo
// reads it without touching HFM. Only this function writes the key, so the KV
// limit of one write per second per key can never be hit by a 5 minute cron.
// There is no sleep between attempts: setTimeout does not reliably delay on
// Workers, and each attempt already costs a real round trip of up to 15s.
export async function refreshLastTradeCache(
  options: GetLastTradeMapOptions = {},
): Promise<number | null> {
  const now = options.nowMs ?? Date.now;
  const fetchClientsFn =
    options.fetchClientsFn ?? (() => fetchClients(FETCH_TIMEOUT_MS));
  const kv = options.kv !== undefined ? options.kv : getCache();

  let result: HFMClientsResult | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await fetchClientsFn();
    if (result.ok) break;
    logError(
      "last-trade",
      `refreshLastTradeCache attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
    );
  }

  if (!result || !result.ok) return null;

  const entries = toEntries(result);
  memo = { map: new Map(entries), fetchedAt: now() };

  if (!kv) return entries.length;

  const payload: LastTradePayload = { v: 1, fetchedAt: now(), entries };
  await kv.put(LAST_TRADE_KV_KEY, JSON.stringify(payload), {
    expirationTtl: KV_TTL_SECONDS,
  });
  logInfo(
    "last-trade",
    { size: entries.length, key: LAST_TRADE_KV_KEY },
    "last-trade cache written to KV",
  );
  return entries.length;
}

// Same contract as getLastTradeMap but never blocks the caller longer than
// deadlineMs. The budget is no longer about the ~48s retry ladder: on Workers
// the ladder lives in the cron, so this guards the two remaining costs, a KV
// read and, only on a KV miss, one live /api/clients/ call. The real ceiling
// is the fetch timeout below, because AbortSignal.timeout is a runtime timer
// while setTimeout "will not delay for the full time specified" on Workers.
export async function getLastTradeMapWithin(
  deadlineMs: number,
  options: GetLastTradeMapOptions = {},
): Promise<LastTradeMap | null> {
  const bounded: GetLastTradeMapOptions = {
    ...options,
    fetchClientsFn: options.fetchClientsFn ?? (() => fetchClients(deadlineMs)),
  };

  const pending = getLastTradeMap(bounded).catch((err) => {
    logError("last-trade", err);
    return null;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LastTradeMap | null>((resolve) => {
    timer = setTimeout(() => {
      logError(
        "last-trade",
        `getLastTradeMapWithin exceeded ${deadlineMs}ms; replying without a fresh map`,
      );
      resolve(memo?.map ?? null);
    }, deadlineMs);
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(
  fetchClientsFn: () => Promise<HFMClientsResult>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<LastTradeMap | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await fetchClientsFn();
    if (result.ok) {
      const map: LastTradeMap = new Map(toEntries(result));
      memo = { map, fetchedAt: now() };
      return map;
    }
    logError(
      "last-trade",
      `getLastTradeMap attempt ${attempt}/${MAX_ATTEMPTS} failed (${result.reason})`,
    );
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_MS[attempt - 1]!);
    }
  }

  if (memo) {
    logError("last-trade", "getLastTradeMap fetch failed; serving stale cache");
    return memo.map;
  }
  logError("last-trade", "getLastTradeMap fetch failed; no cache available");
  return null;
}
```

- [x] **Step 5: Run both last-trade test files**

```bash
cd apps/api && bun test tests/last-trade-kv.test.ts tests/last-trade.service.test.ts
```

Expected: PASS, 17 tests (8 new plus the 9 listed above, unchanged).

- [x] **Step 6: Typecheck**

```bash
cd apps/api && bun run typecheck
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/cache/kv.ts apps/api/src/services/last-trade.service.ts apps/api/tests/last-trade-kv.test.ts
git commit -m "feat: back last-trade map with Workers KV"
```

### 5b. The health-check flag moves to the database

`src/jobs/hfm-healthcheck.ts:13` holds `let lastHealthy = true`, and the comment at `:10-12`
already admits the weakness: "a restart while HFM is down re-sends the down alert once".
On Workers that restart is every cron tick that lands on a fresh isolate, so the
"HFM API ขัดข้อง" alert would repeat every 5 minutes until HFM recovers.

The flag moves to `job_state` under the key `hfm_healthcheck:last_healthy` with the values
`"1"` and `"0"`.
No row means "up", so the current baseline is preserved: a first failed probe alerts and a
first successful probe stays quiet.

**Not KV.** A KV read can return a value up to 60 seconds stale, and negative lookups are
cached too, so a tick could read "up" right after writing "down" and alert twice.
Edge detection needs read-after-write, so it uses the database.
The cost is one `SELECT` and, only on a transition, one `INSERT ... ON CONFLICT` every 5 minutes.

- [x] **Step 8: Add the job_state table to the schema**

Append to `apps/api/src/db/schema.ts` (after `clientRequestSnapshotRows`, which ends at line 125):

```ts
// Durable key/value state for jobs. The Bun server kept edge-detection flags in
// module memory; a Worker isolate can be evicted between two cron ticks, so the
// flag has to live somewhere that survives the isolate. The database is used
// rather than KV because KV is eventually consistent for up to 60 seconds and
// an edge detector must read its own last write.
export const jobState = pgTable("job_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
});
```

`pgTable`, `text`, `timestamp` and `sql` are already imported at `src/db/schema.ts:1-10`.

Never hand-write the migration SQL.
The schema file is the source of truth. Generate the migration with the script Task 4 added:

```bash
cd apps/api && bun run db:generate
```

Expected: a new file in `apps/api/drizzle/` that creates `job_state`. Commit it without editing it.

Then add `"job_state"` to the `REQUIRED_TABLES` list in `apps/api/tests/migrations.test.ts`
(Task 4), so the drift guard fails if the table ever drops out of the migrations.

- [x] **Step 9: Write the failing state repository test**

Create `apps/api/tests/state.repository.test.ts`:

```ts
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { createTestDb, closeTestDb } from "./db-helpers";
import { getJobState, setJobState } from "../src/db/state.repository";
import type { DrizzleDb } from "../src/db/connection";
import type postgres from "postgres";

let db: DrizzleDb;
let client: postgres.Sql;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db as unknown as DrizzleDb;
  client = created.client;
});

afterAll(async () => {
  await closeTestDb(client);
});

describe("job state repository", () => {
  test("returns null for a key that was never written", async () => {
    expect(await getJobState(db, "never:written")).toBeNull();
  });

  test("stores and reads back a value", async () => {
    await setJobState(db, "hfm_healthcheck:last_healthy", "0");
    expect(await getJobState(db, "hfm_healthcheck:last_healthy")).toBe("0");
  });

  test("overwrites an existing key instead of inserting a second row", async () => {
    await setJobState(db, "overwrite:me", "1");
    await setJobState(db, "overwrite:me", "0");
    expect(await getJobState(db, "overwrite:me")).toBe("0");
  });

  test("keeps separate keys independent", async () => {
    await setJobState(db, "key:a", "1");
    await setJobState(db, "key:b", "0");
    expect(await getJobState(db, "key:a")).toBe("1");
    expect(await getJobState(db, "key:b")).toBe("0");
  });
});
```

- [x] **Step 10: Run the test to verify it fails**

The suite needs the test database.
From the repo root run `docker compose up -d postgres-test` and export
`TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test` first.

```bash
cd apps/api && bun test tests/state.repository.test.ts
```

Expected: FAIL with

```text
error: Cannot find module '../src/db/state.repository' from '/.../apps/api/tests/state.repository.test.ts'
```

- [x] **Step 11: Create the state repository and the test tables**

Create `apps/api/src/db/state.repository.ts`:

```ts
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "./connection";
import { jobState } from "./schema";

/**
 * Durable key/value state for background jobs. This replaces the module-level
 * flags the Bun process used to hold, which a Worker isolate cannot keep: the
 * isolate that runs one cron tick is not the isolate that runs the next one.
 *
 * The database, not KV, is the store here. A KV read can serve a value up to
 * 60 seconds stale, and edge detection has to read back exactly what the last
 * tick wrote.
 */
export async function getJobState(
  db: DrizzleDb,
  key: string,
): Promise<string | null> {
  const rows = await db
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setJobState(
  db: DrizzleDb,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(jobState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: jobState.key,
      set: { value, updatedAt: now },
    });
}
```

In `apps/api/tests/db-helpers.ts`, add the drop to the `DROP TABLE` list inside
`createTestDb()` (Task 4 Step 6 shape):

```ts
    DROP TABLE IF EXISTS job_state CASCADE;
```

and append the table to the DDL inside `applyTestSchema()`, after the
`client_request_snapshot_rows` block:

```ts
    CREATE TABLE IF NOT EXISTS job_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
```

`initDb` no longer exists after Task 4, so there is no runtime DDL to update.

Add one assertion to `apps/api/tests/sqlite.service.test.ts` after line 49:

```ts
  expect(tableNames).toContain("job_state");
```

- [x] **Step 12: Run the state tests**

```bash
cd apps/api && bun test tests/state.repository.test.ts tests/sqlite.service.test.ts
```

Expected: PASS, 7 tests.

- [x] **Step 13: Write the failing health-check test**

Replace the whole of `apps/api/tests/hfm-healthcheck.test.ts`:

```ts
import { expect, test, describe } from "bun:test";
import {
  runHfmHealthCheck,
  LAST_HEALTHY_KEY,
} from "../src/jobs/hfm-healthcheck";
import type { DrizzleDb } from "../src/db/connection";

// Captures every pushToAll call so we can assert on count and message content.
// The liveness flag now lives in the database, so the harness stands in for
// src/db/state.repository.ts with a plain Map. Surviving the isolate is the
// whole point, so the map is created once and shared by every run.
function makeHarness(healthSeq: boolean[], seed?: string) {
  const sent: string[] = [];
  const state = new Map<string, string>();
  if (seed !== undefined) state.set(LAST_HEALTHY_KEY, seed);
  let i = 0;
  return {
    sent,
    state,
    run: () =>
      runHfmHealthCheck({
        db: {} as DrizzleDb,
        checkHealthyFn: async () => healthSeq[i++]!,
        getUidsFn: async () => ["Utest123"],
        pushToAllFn: async (_uids, text) => {
          sent.push(text);
        },
        getStateFn: async (_db, key) => state.get(key) ?? null,
        setStateFn: async (_db, key, value) => {
          state.set(key, value);
        },
      }),
  };
}

test("no alert while the API stays up (baseline up -> up)", async () => {
  const h = makeHarness([true]);
  await h.run();
  expect(h.sent).toEqual([]);
});

test("transition-only: up -> down -> down -> up sends exactly two alerts", async () => {
  const h = makeHarness([true, false, false, true]);
  await h.run(); // up -> up: nothing
  await h.run(); // up -> down: down alert
  await h.run(); // down -> down: nothing (no spam)
  await h.run(); // down -> up: recovered alert

  expect(h.sent.length).toBe(2);
  expect(h.sent[0]).toContain("ขัดข้อง");
  expect(h.sent[1]).toContain("กลับมาใช้งานได้");
});

test("first probe down (from up baseline) alerts once", async () => {
  const h = makeHarness([false]);
  await h.run();
  expect(h.sent.length).toBe(1);
  expect(h.sent[0]).toContain("ขัดข้อง");
});

test("a fresh isolate reads the stored flag and does not repeat the alert", async () => {
  // Nothing in module memory says "already down"; only the stored row does.
  const h = makeHarness([false, false], "0");
  await h.run();
  await h.run();
  expect(h.sent).toEqual([]);
});

test("stores 0 when the API goes down and 1 when it recovers", async () => {
  const h = makeHarness([false, true]);
  await h.run();
  expect(h.state.get(LAST_HEALTHY_KEY)).toBe("0");
  await h.run();
  expect(h.state.get(LAST_HEALTHY_KEY)).toBe("1");
});

describe("no recipients", () => {
  test("records the transition without sending", async () => {
    const sent: string[] = [];
    const state = new Map<string, string>();
    const opts = {
      db: {} as DrizzleDb,
      getUidsFn: async () => [] as string[],
      pushToAllFn: async (_uids: string[], text: string) => {
        sent.push(text);
      },
      getStateFn: async (_db: DrizzleDb, key: string) => state.get(key) ?? null,
      setStateFn: async (_db: DrizzleDb, key: string, value: string) => {
        state.set(key, value);
      },
    };

    // up -> down with no recipients: nothing sent, but state must advance to down.
    await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => false });
    expect(sent).toEqual([]);
    expect(state.get(LAST_HEALTHY_KEY)).toBe("0");

    // down -> up should now be a real transition (recovered), still no recipients.
    await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => true });
    expect(sent).toEqual([]);
    expect(state.get(LAST_HEALTHY_KEY)).toBe("1");

    // up -> up: confirm state settled at "up" (no further transition logic fires).
    await runHfmHealthCheck({ ...opts, checkHealthyFn: async () => true });
    expect(sent).toEqual([]);
  });
});
```

- [x] **Step 14: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/hfm-healthcheck.test.ts
```

Expected: FAIL with

```text
SyntaxError: Export named 'LAST_HEALTHY_KEY' not found in module '/.../apps/api/src/jobs/hfm-healthcheck.ts'.
```

- [x] **Step 15: Move the flag into the database**

Apply five edits to `apps/api/src/jobs/hfm-healthcheck.ts`.
Do not touch `DOWN_MESSAGE` and `RECOVERED_MESSAGE` at lines 6-8.

1. Add one import after line 2:

```ts
import { getJobState, setJobState } from "../db/state.repository";
```

2. Replace lines 10-13 (the comment and `let lastHealthy = true`):

```ts
// Durable liveness state. The Bun process kept this in a module-level variable;
// on Workers every cron tick can run in a brand new isolate, so an in-memory
// flag would make the "HFM API down" alert repeat every 5 minutes forever.
// The row is read-after-write correct, which KV is not: a KV read can serve a
// value up to 60 seconds stale and the tick interval is only 5 minutes.
// No row means "up", so a first failed probe alerts while a first successful
// probe stays quiet.
export const LAST_HEALTHY_KEY = "hfm_healthcheck:last_healthy";
```

3. Replace the options interface (currently lines 15-20):

```ts
export interface RunHfmHealthCheckOptions {
  db?: DrizzleDb;
  checkHealthyFn?: () => Promise<boolean>;
  pushToAllFn?: (uids: string[], text: string) => Promise<void>;
  getUidsFn?: (db: DrizzleDb) => Promise<string[]>;
  getStateFn?: (db: DrizzleDb, key: string) => Promise<string | null>;
  setStateFn?: (db: DrizzleDb, key: string, value: string) => Promise<void>;
}
```

4. Replace the body of `runHfmHealthCheck` (currently lines 27-52):

```ts
export async function runHfmHealthCheck(
  options: RunHfmHealthCheckOptions = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const checkHealthy = options.checkHealthyFn ?? checkHfmApiHealthy;
  const pushAll = options.pushToAllFn ?? pushToAll;
  const getUids = options.getUidsFn ?? resolveUids;
  const getState = options.getStateFn ?? getJobState;
  const setState = options.setStateFn ?? setJobState;

  const healthy = await checkHealthy();

  const stored = await getState(db, LAST_HEALTHY_KEY);
  const lastHealthy = stored === null ? true : stored === "1";

  // No state change => no notification (avoids spamming every 5 minutes).
  if (healthy === lastHealthy) return;

  const uids = await getUids(db);
  if (uids.length === 0) {
    console.warn("[cron] hfm-healthcheck: no active recipients, skipping notify");
    // Still record the transition so we don't keep re-resolving an empty list.
    await setState(db, LAST_HEALTHY_KEY, healthy ? "1" : "0");
    return;
  }

  const message = healthy ? RECOVERED_MESSAGE : DOWN_MESSAGE;
  // Update state only after a successful push so a failed send retries next tick.
  await pushAll(uids, message);
  await setState(db, LAST_HEALTHY_KEY, healthy ? "1" : "0");
}
```

5. Delete `__resetHealthState` (currently lines 54-57).
There is no module state left to reset, and the new test file no longer imports it.

Confirm nothing else uses it:

```bash
cd apps/api && grep -rn "__resetHealthState" src tests scripts
```

Expected: no output.
> Deviation: Step 15 delete of `__resetHealthState` broke `scripts/trigger-hfm-healthcheck.ts`, which still imported and called it (the plan grep expected no output but listed it). Removed the import, the call and its stale in-memory-baseline comment from that script; no new repository function was invented. The one-shot trigger now reads whatever the database holds.

- [x] **Step 16: Run the health-check tests**

```bash
cd apps/api && bun test tests/hfm-healthcheck.test.ts
```

Expected: PASS, 6 tests.

- [x] **Step 17: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/state.repository.ts apps/api/src/db/connection.ts apps/api/src/jobs/hfm-healthcheck.ts apps/api/tests
git commit -m "feat: store health-check state in the database"
```

### 5c. The flex-version warning flag stays

`src/builders/flex-message.builder.ts:33` holds `let warnedFlexVersion`.
It only stops one "unrecognized FLEX_SUMMARY_VERSION" warning from repeating.
On Workers the flag lives per isolate, so an evicted isolate costs one extra warning line and
nothing else.
No behaviour depends on it, so it stays exactly as it is, and the "warns once" test in
`tests/flex-message.builder.test.ts:433` keeps passing unchanged.

### 5d. Each LINE event is answered once

Cloudflare Queues deliver at least once.
If a message is delivered a second time after its reply went out, the reply token is already
spent, the reply API rejects it, and `replyOrPush` falls back to a push: the customer gets the
same answer twice, and in a group LINE bills that push once per member.

The fix is a claim written before any reply: an atomic
`INSERT ... ON CONFLICT DO NOTHING` on the event's `webhookEventId`.
Only the delivery that inserts the row replies.
Claims reuse the `job_state` table under the `line_event:` key prefix, so no new table is
needed, and the 5 minute cron purges claims older than two days (Task 6 Step 3).

The claim fails open.
If the database is down, the event is answered anyway and a duplicate becomes possible.
That keeps the rule already written in the dispatcher: a database hiccup must never stop the
customer's reply.

**Files:**
- Modify: `apps/api/src/db/state.repository.ts`
- Modify: `apps/api/src/services/webhook-dispatcher.ts`
- Modify: `apps/api/tests/state.repository.test.ts`
- Create: `apps/api/tests/webhook-dispatcher.test.ts`
- Modify: `apps/api/tests/webhook.test.ts`, `tests/webhook-logging.test.ts`, `tests/line-uids.test.ts`,
  `tests/health.test.ts`, `tests/sqlite.service.test.ts` (one line each in the inline `DROP TABLE` list)

- [x] **Step 18: Write the failing claim tests**

Append to `apps/api/tests/state.repository.test.ts`, and extend its import from
`../src/db/state.repository` to
`import { claimLineEvent, getJobState, purgeEventClaims, setJobState } from "../src/db/state.repository";`.
Add these two imports as well:

```ts
import { eq } from "drizzle-orm";
import { jobState } from "../src/db/schema";
```

```ts
describe("LINE event claims", () => {
  test("the first claim wins and a repeat claim loses", async () => {
    expect(await claimLineEvent(db, "evt-claim-1")).toBe(true);
    expect(await claimLineEvent(db, "evt-claim-1")).toBe(false);
  });

  test("concurrent claims for one event have exactly one winner", async () => {
    const results = await Promise.all([
      claimLineEvent(db, "evt-race"),
      claimLineEvent(db, "evt-race"),
      claimLineEvent(db, "evt-race"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("purge removes only old event claims", async () => {
    await claimLineEvent(db, "evt-old");
    await claimLineEvent(db, "evt-new");
    await setJobState(db, "hfm_healthcheck:last_healthy", "1");
    await db
      .update(jobState)
      .set({ updatedAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(jobState.key, "line_event:evt-old"));

    expect(await purgeEventClaims(db, 60_000)).toBe(1);

    // evt-old is gone, so it can be claimed again; evt-new is still held.
    expect(await claimLineEvent(db, "evt-old")).toBe(true);
    expect(await claimLineEvent(db, "evt-new")).toBe(false);
    // Job state that is not an event claim is never purged.
    expect(await getJobState(db, "hfm_healthcheck:last_healthy")).toBe("1");
  });
});
```

- [x] **Step 19: Run the tests to verify they fail**

```bash
cd apps/api && bun test tests/state.repository.test.ts
```

Expected: FAIL with
`SyntaxError: Export named 'claimLineEvent' not found in module '.../src/db/state.repository.ts'`.

- [x] **Step 20: Implement the claim and the purge**

In `apps/api/src/db/state.repository.ts`, change the first import to:

```ts
import { and, eq, like, lt } from "drizzle-orm";
```

and append:

```ts
const LINE_EVENT_PREFIX = "line_event:";

/**
 * Claims a LINE event for processing. Returns true exactly once per
 * webhookEventId. INSERT ... ON CONFLICT DO NOTHING is atomic in PostgreSQL,
 * so two consumer invocations racing on a redelivered message cannot both
 * win. Hyperdrive runs with caching disabled, so no cached read hides the row.
 */
export async function claimLineEvent(
  db: DrizzleDb,
  webhookEventId: string,
): Promise<boolean> {
  const rows = await db
    .insert(jobState)
    .values({
      key: `${LINE_EVENT_PREFIX}${webhookEventId}`,
      value: "claimed",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: jobState.key })
    .returning({ key: jobState.key });
  return rows.length === 1;
}

/**
 * Deletes event claims older than olderThanMs. A claim only has to outlive
 * queue redelivery, which is minutes, so the cron keeps two days. Other
 * job_state keys are never touched. Both sides of the comparison are
 * app-written UTC ISO strings, so the session time zone cannot skew it.
 */
export async function purgeEventClaims(
  db: DrizzleDb,
  olderThanMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .delete(jobState)
    .where(
      and(
        like(jobState.key, `${LINE_EVENT_PREFIX}%`),
        lt(jobState.updatedAt, cutoff),
      ),
    )
    .returning({ key: jobState.key });
  return rows.length;
}
```

- [x] **Step 21: Run the claim tests**

```bash
cd apps/api && bun test tests/state.repository.test.ts
```

Expected: PASS, 7 tests.

- [x] **Step 22: Commit**

```bash
git add apps/api/src/db/state.repository.ts apps/api/tests/state.repository.test.ts
git commit -m "feat: claim LINE events in job_state"
```

- [x] **Step 23: Write the failing duplicate-delivery test**

Create `apps/api/tests/webhook-dispatcher.test.ts`:

```ts
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type postgres from "postgres";
import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import { closeDb, resetDbForTests } from "../src/db/connection";
import { dispatchWebhookEvent } from "../src/services/webhook-dispatcher";
import type { LineEventMessage } from "../src/queue/types";

const ORIGINAL_FETCH = globalThis.fetch;
let client: postgres.Sql;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  resetDbForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

afterAll(async () => {
  await closeDb();
  await closeTestDb(client);
  delete process.env.DATABASE_URL;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

function joinMessage(webhookEventId: string): LineEventMessage {
  return {
    kind: "line-event",
    tenant: "test",
    webhookEventId,
    receivedAt: Date.now(),
    event: {
      type: "join",
      mode: "active",
      timestamp: Date.now(),
      replyToken: "rt-join",
      webhookEventId,
      deliveryContext: { isRedelivery: false },
      source: { type: "group", groupId: "Cdup" },
    } as never,
  };
}

function countReplies(): string[] {
  const replies: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/message/reply")) replies.push(url);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return replies;
}

test("a redelivered event is answered once", async () => {
  const replies = countReplies();
  const message = joinMessage("evt-dup-1");
  await dispatchWebhookEvent(message);
  await dispatchWebhookEvent(message);
  expect(replies).toHaveLength(1);
});

test("a different event is still answered", async () => {
  const replies = countReplies();
  await dispatchWebhookEvent(joinMessage("evt-dup-2"));
  expect(replies).toHaveLength(1);
});
```

- [x] **Step 24: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/webhook-dispatcher.test.ts
```

Expected: FAIL on the first test with `Expected length: 1` / `Received length: 2`.

- [x] **Step 25: Claim the event before replying**

In `apps/api/src/services/webhook-dispatcher.ts`, add to the imports:

```ts
import { claimLineEvent } from "../db/state.repository";
```

In `dispatchWebhookEvent`, directly after the `"webhook event received"` log call and before
`const ctx = getChatContext(event);`, insert:

```ts
  // Queues deliver at least once. A second delivery would find the reply
  // token spent, and replyOrPush would push a duplicate answer, billed per
  // member in a group. Only the delivery that claims the event replies.
  // Fails open: a database hiccup must never stop the customer's reply, so a
  // claim error is logged and the event is handled anyway.
  let firstDelivery = true;
  try {
    firstDelivery = await claimLineEvent(db, webhookEventId);
  } catch (err) {
    logError("webhook-claim", err);
  }
  if (!firstDelivery) {
    logInfo(
      "webhook",
      { webhookEventId, reason: "duplicate_delivery" },
      "event skipped",
    );
    return;
  }
```

- [x] **Step 26: Drop `job_state` in every inline test schema reset**

Five test files reset their tables with their own inline `DROP TABLE` list instead of
`createTestDb()`. Without `job_state` in that list, event claims survive from one `bun test`
run to the next, and a test with a fixed `webhookEventId` (for example
`tests/webhook-logging.test.ts:197`) would be skipped as a duplicate on the second run.

In each of these files, add one line directly after
`DROP TABLE IF EXISTS client_snapshots CASCADE;`:

```ts
    DROP TABLE IF EXISTS job_state CASCADE;
```

Files: `tests/webhook.test.ts`, `tests/webhook-logging.test.ts`, `tests/line-uids.test.ts`,
`tests/health.test.ts`, `tests/sqlite.service.test.ts`.

Then confirm that every reset list now drops it:

```bash
cd apps/api && grep -rL "DROP TABLE IF EXISTS job_state" $(grep -rl "DROP TABLE IF EXISTS client_snapshots CASCADE" tests)
```

Expected: no output.

- [x] **Step 27: Run the dispatcher test and the whole suite twice**

```bash
cd apps/api && bun test tests/webhook-dispatcher.test.ts && bun test && bun test && bun run typecheck
```

Expected: PASS every time. The second full run proves no claim leaks between runs.

- [x] **Step 28: Commit**

```bash
git add apps/api/src/services/webhook-dispatcher.ts apps/api/tests
git commit -m "fix: answer each LINE event once"
```

---

## Task 6: The Worker entrypoint

Everything built so far is wired together here. After this task the app has one
entrypoint with three handlers and no long-lived process.

`src/index.ts` cannot be adapted. It does module-level I/O (`await initDb(db)` at line 12),
registers croner jobs at line 33, warms a cache at lines 37-41, installs `process.on`
signal handlers at lines 45-49, and exports the Bun server shape at lines 51-54. None of
that exists on Workers. It is replaced, not edited.

Only the 5 minute health check is scheduled. The daily 05:00 report cron was removed on
purpose in commit `96e6a0e` ("drop 5am cron job"), and this migration must not bring it back.
`runDailyClientReport` stays reachable through `bun run trigger:daily-client-report` only.

**Files:**
- Rewrite: `apps/api/src/jobs/index.ts`
- Create: `apps/api/src/worker.ts`
- Create: `apps/api/tests/worker.test.ts`
- Delete: `apps/api/src/index.ts`

- [x] **Step 1: Write the failing cron dispatch test**

Create `apps/api/tests/worker.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { cronJobName, CRON_JOBS } from "../src/jobs";

describe("cron dispatch", () => {
  test("maps the five minute schedule to the health check", () => {
    expect(cronJobName("*/5 * * * *")).toBe("hfm-healthcheck");
  });

  // The daily report cron was removed on purpose in commit 96e6a0e.
  test("does not schedule the daily client report", () => {
    expect(cronJobName("0 1 * * *")).toBeNull();
    expect(cronJobName("0 22 * * *")).toBeNull();
    expect(Object.values(CRON_JOBS)).toEqual(["hfm-healthcheck"]);
  });

  test("returns null for an unknown schedule", () => {
    expect(cronJobName("7 7 7 7 7")).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/worker.test.ts
```

Expected: FAIL with `Export named 'cronJobName' not found in module`.

- [x] **Step 3: Rewrite the job registry**

Replace the whole of `apps/api/src/jobs/index.ts`:

```ts
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
```

- [x] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && bun test tests/worker.test.ts
```

Expected: PASS, 3 tests.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/jobs/index.ts apps/api/tests/worker.test.ts
git commit -m "refactor: replace croner registry with cron dispatch"
```

> Deviation: the plan's own step order makes `bun run typecheck` red at this
> intermediate commit: Step 3 removed `registerJobs`, which the still-present
> `src/index.ts` imports (only importer, verified by grep); the file is deleted
> in Step 7 and typecheck is verified clean at Step 8 before the final commit,
> as this task's loop requires.

- [x] **Step 6: Write the Worker entrypoint**

Create `apps/api/src/worker.ts`:

```ts
import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { handleQueueBatch } from "./queue/consumer";
import { dispatchCron } from "./jobs";
import { assertProcessEnvPopulated, type WorkerEnv } from "./config/env";
import { openDb, runWithDb } from "./db/connection";
import { runWithCache } from "./cache/kv";
import { logInfo } from "./utils/logger";
import type { QueueMessage } from "./queue/types";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  // One line per request. Ids and durations only: Workers Logs caps a request
  // at 256 KB of log data, and a payload dump would truncate the tail.
  logInfo(
    "http",
    { method, path, status: c.res.status, durationMs: Date.now() - start },
    `${method} ${path} ${c.res.status}`,
  );
});

app.route("/webhook", webhook);
app.route("/internal", internal);

/**
 * Puts the non-string bindings (database handle, KV cache) in scope for one
 * invocation. Flags and secrets need no scope: they are read from process.env,
 * which Cloudflare fills per Worker, and each tenant is its own Worker.
 * The connection teardown goes to waitUntil so it never delays the response.
 */
async function withScope<T>(
  env: WorkerEnv,
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  assertProcessEnvPopulated(env);
  const handle = openDb(env.HYPERDRIVE.connectionString);
  try {
    return await runWithDb(handle, () => runWithCache(env.CACHE, fn));
  } finally {
    ctx.waitUntil(handle.dispose());
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return withScope(env, ctx, () => app.fetch(request, env, ctx));
  },

  // LINE records a request_timeout after 2s, so the webhook route only
  // enqueues. All the slow work lands here with a 15 minute wall budget.
  async queue(
    batch: MessageBatch<QueueMessage>,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    await withScope(env, ctx, () => handleQueueBatch(batch));
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    await withScope(env, ctx, () => dispatchCron(controller.cron));
  },
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
```

> Deviation: `app.fetch` returns `Response | Promise<Response>`, which the
> typechecker rejects against `withScope`'s `() => Promise<T>` parameter. The
> fetch lambda is `async () => app.fetch(request, env, ctx)` so the union
> flattens to `Promise<Response>`. Intent unchanged.

- [x] **Step 7: Delete the Bun entrypoint**

```bash
cd apps/api && git rm src/index.ts
```

Then check nothing imports it:

```bash
cd apps/api && grep -rn "src/index\|from \"\.\./index\"" src tests scripts
```

Expected: no output. No test file imports `src/index.ts` today.

- [x] **Step 8: Typecheck and run the whole suite**

```bash
cd apps/api && bun run typecheck && bun test
```

Expected: PASS. The Workers types (`ExecutionContext`, `MessageBatch`, `ScheduledController`,
`ExportedHandler`) resolve because Task 1 installed `@cloudflare/workers-types` and set
`types` in `tsconfig.json`.

- [x] **Step 9: Build the Worker bundle**

`bun test` runs on Bun, so it cannot catch a module that only fails inside workerd. The
Wrangler dry run bundles `src/worker.ts` for the real runtime:

```bash
cd apps/api && bunx wrangler deploy --dry-run --outdir /tmp/hfm-bundle-check --name hfm-bot-check \
  --compatibility-date 2026-09-22 src/worker.ts
```

Expected: `--dry-run: exiting now.` with no build error. A failure names the import that
workerd cannot load (for example a leftover `pino` or `node:fs` import) - fix it before moving on.
Task 8 replaces this command with the per-tenant `bun run check:bundle:<tenant>`.

- [x] **Step 10: Commit**

```bash
git add apps/api
git commit -m "feat: add Cloudflare Worker entrypoint"
```

---

## Task 7: Workers-runtime API fixes

Five separate runtime incompatibilities, one audit.
Each one is independent of the others and none of them changes an exported signature.

**Files:**
- Modify: `apps/api/src/services/line.service.ts:163-170`
- Modify: `apps/api/tests/line.service.test.ts` (append one describe block)
- Modify: `apps/api/src/services/hfm.service.ts:15`, `:147-148`, `:153`, `:192-202`,
  `:262-264`, `:269`, `:287-297`, `:299-301`, `:306`, `:321-331`, `:336-339`, `:346`,
  `:361-371`, `:383-384`, `:394`, `:416-422`
- Create: `apps/api/tests/hfm-timeouts.test.ts`
- Modify: `apps/api/src/jobs/daily-client-report.ts:212`, `:268-273`, `:472`, `:482`
- Modify: `apps/api/tests/daily-client-report.test.ts:518-539`
- Modify: `apps/api/src/utils/signature.ts:1`
- Modify: `apps/api/tests/signature.test.ts` (append one test)
- Create: `apps/api/tests/no-unbounded-fanout.test.ts`

### 7a. `Bun.sleep` in the LINE push loop

`src/services/line.service.ts:167` calls `await Bun.sleep(200)` between pushes inside
`pushToAll` (`:163-170`).
`Bun` does not exist on Workers, so this throws `ReferenceError: Bun is not defined` the first
time the daily report or a health-check alert fans out to more than one recipient.

The delay cannot simply be re-implemented with `setTimeout`.
Cloudflare documents that "timers are limited to returning the time of the last I/O ...
they will not delay them for the full time specified"
(<https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/>), so a `setTimeout`
sleep is not a rate limiter.

**Rate-limit consequence: none.** LINE allows **2,000 requests per second** per channel for
push and reply, the "Other API endpoints" row of the rate-limit table
(<https://developers.line.biz/en/reference/messaging-api/#rate-limits>).
The loop already awaits every push, so N recipients cost N sequential round trips of roughly
100-300 ms each, which is about 3-10 requests per second, three orders of magnitude below the
limit.
The 200 ms pacing was protecting against a limit that this loop cannot reach.
Sequential awaiting also keeps exactly one outbound connection waiting for headers, inside the
Workers limit of 6.
If real pacing is ever needed, it belongs in Queues `delaySeconds`, not in a timer.

- [x] **Step 1: Write the failing pacing test**

Append to `apps/api/tests/line.service.test.ts`:

```ts

describe("pushToAll pacing", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("does not sleep between pushes", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

    const startedAt = Date.now();
    await pushToAll(["U001", "U002", "U003"], "hello");
    const elapsed = Date.now() - startedAt;

    // The old implementation slept 200ms between pushes, so three recipients
    // cost 400ms. Bun.sleep does not exist on Workers.
    expect(elapsed).toBeLessThan(100);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/line.service.test.ts -t "does not sleep between pushes"
```

Expected: FAIL with

```text
error: expect(received).toBeLessThan(expected)

Expected: < 100
Received: 405
```

- [x] **Step 3: Remove the sleep**
  > Deviation: the confirm grep `grep -rn "Bun\." src` cannot return "no output" as the step
  > expects, because the step's own replacement comment contains the string "Bun.sleep" and
  > `src/types/workers-types-compat.d.ts` mentions `Bun.file(...)` and `Bun.Image` in doc
  > comments and type declarations. Checked the intent instead: the only non-`.d.ts` match is
  > the new comment itself, and no runtime `Bun.` call remains in `src/`.

Replace `apps/api/src/services/line.service.ts:163-170`:

```ts
// Sequential on purpose. Each push is awaited, so N recipients cost N round
// trips and at most one outbound connection is ever waiting for headers, well
// inside the Workers limit of 6. There is no pacing delay any more: Bun.sleep
// does not exist on Workers and setTimeout is not a reliable sleep there, and
// LINE allows 2,000 requests per second for push, which an awaited loop cannot
// approach. (https://developers.line.biz/en/reference/messaging-api/#rate-limits)
export async function pushToAll(uids: string[], text: string): Promise<void> {
  for (const uid of uids) {
    await pushText(uid, text);
  }
}
```

Then confirm no `Bun.` call is left in `src/`:

```bash
cd apps/api && grep -rn "Bun\." src
```

Expected: no output.

- [x] **Step 4: Run the LINE service tests**

```bash
cd apps/api && bun test tests/line.service.test.ts
```

Expected: PASS, 14 tests.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/line.service.ts apps/api/tests/line.service.test.ts
git commit -m "fix: drop Bun.sleep from the LINE push loop"
```

### 7b. HFM timeouts

Two defects in one file.

**The 120 second default.** `src/services/hfm.service.ts:262` declares
`fetchClients(timeoutMs = 120_000)`.
That default is reachable from the LINE reply path: `src/jobs/daily-client-report.ts:472`
resolves `fetchCurrent` to the bare `fetchClients`, and `generateReportForUser` calls
`buildReportMessages`, which calls it at `src/jobs/daily-client-report.ts:292`.
A LINE reply token is valid for 60 seconds, so a 120 second timeout can only ever expire after
the reply is already impossible.
**The new ceiling is 30 seconds** for the default, and the two real call paths pass their own
value: 20 seconds for the reply path and 45 seconds for the cron.
Rationale: the queue consumer has a 15 minute wall budget, so the binding constraint is not
Cloudflare but the 60 second reply token, and the consumer also spends time on the loading
animation, the reply call and up to two LINE round trips.
20 seconds leaves roughly 40 seconds of headroom inside the token.
The cron path has no token to lose, so it gets 45 seconds per attempt, and its three attempts
are 135 seconds worst case inside the 15 minute wall limit.

**The `setTimeout` + `AbortController` pairs.** Five call sites build their timeout by hand:
`:147-148` and `:200` (`fetchPerformance`), `:263-264` and `:295` (`fetchClients`),
`:300-301` and `:329` (`fetchAllClients`), `:338-339` and `:369` (`fetchClientsByRange`),
`:383-384` and `:420` (`fetchMonthlyVolumeMap`).
On Workers a `setTimeout` timer is not guaranteed to fire on wall-clock time, so the abort may
never happen and the call stops being bounded.
`AbortSignal.timeout(ms)` is a runtime-implemented timer, it is already used in this codebase
at `src/routes/internal.ts:39` and `src/services/line.service.ts:38,59,80,101,190`, and it
removes the `clearTimeout` bookkeeping and the dangling handle in every `finally`.

One consequence must be handled: `AbortSignal.timeout()` aborts with a `DOMException` named
**`TimeoutError`**, not `AbortError`.
Verified in Bun 1.3.5: `AbortSignal.timeout(5).reason.name === "TimeoutError"`, and a real
`fetch` rejects with `name: "TimeoutError"`, message `The operation timed out.`.
The five `catch` blocks currently test `e instanceof Error && e.name === "AbortError"`, so
without a fix every timeout would be reported as `server_error`.
`DOMException` is not an `Error` subclass on every runtime, so the new check is name-based and
avoids `instanceof`.

- [x] **Step 6: Write the failing timeout test**

Create `apps/api/tests/hfm-timeouts.test.ts`:

```ts
import { expect, test, describe, afterEach } from "bun:test";
import {
  fetchPerformance,
  fetchClients,
  fetchAllClients,
  fetchClientsByRange,
} from "../src/services/hfm.service";

const ORIGINAL_FETCH = globalThis.fetch;

// AbortSignal.timeout() aborts with a DOMException named "TimeoutError". This
// is what the Workers runtime and Bun both throw, so every HFM call must map
// it to the "timeout" reason instead of the generic server error.
function timingOutFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as typeof globalThis.fetch;
}

describe("HFM timeouts are reported as timeouts", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("fetchPerformance maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchPerformance({ kind: "wallet", id: 1, label: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchClients maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchClients(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchAllClients maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchAllClients(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchClientsByRange maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchClientsByRange("2026-09-01", "2026-09-22", 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });
});
```

- [x] **Step 7: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/hfm-timeouts.test.ts
```

Expected: FAIL, 4 tests, each with

```text
error: expect(received).toBe(expected)

Expected: "timeout"
Received: "server_error"
```

- [x] **Step 8: Add the timeout-error helper**

In `apps/api/src/services/hfm.service.ts`, insert after line 15
(`const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;`):

```ts

// AbortSignal.timeout() aborts with a DOMException named "TimeoutError", while
// a caller-supplied AbortController aborts with "AbortError". Both mean the
// same thing to us, and DOMException is not an Error subclass on every
// runtime, so the check is name-based and does not use instanceof.
function isTimeoutError(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("name" in e)) return false;
  const name = (e as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}
```

- [x] **Step 9: Convert `fetchPerformance`**

In `apps/api/src/services/hfm.service.ts`, delete lines 147-148:

```ts
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
```

Replace line 153 inside the `fetch` call:

```ts
      signal: AbortSignal.timeout(10_000),
```

Replace the closing `catch`/`finally` of the function (currently lines 192-202) with:

```ts
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      logError("hfm-service", `Request timeout for ${lookup.kind} ${lookup.id}`);
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  }
}
```

- [x] **Step 10: Convert `fetchClients` and lower its default**

In `apps/api/src/services/hfm.service.ts`, replace lines 262-264:

```ts
// The ceiling is 30s, not the old 120s: this call is reachable from the LINE
// reply path (generateReportForUser in jobs/daily-client-report.ts), and the
// reply token dies 60s after the event. A caller with a bigger budget, like
// the daily cron, passes its own timeout explicitly.
export async function fetchClients(timeoutMs = 30_000): Promise<HFMClientsResult> {
  try {
```

Replace line 269 inside the `fetch` call:

```ts
      signal: AbortSignal.timeout(timeoutMs),
```

Replace the closing `catch`/`finally` of the function (currently lines 287-297) with:

```ts
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      logError("hfm-service", "fetchClients request timeout");
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  }
}
```

- [x] **Step 11: Convert `fetchAllClients`**

In `apps/api/src/services/hfm.service.ts`, replace lines 299-301:

```ts
export async function fetchAllClients(timeoutMs = 10_000): Promise<HFMAllClientsResult> {
  try {
```

Replace line 306 inside the `fetch` call:

```ts
      signal: AbortSignal.timeout(timeoutMs),
```

Replace the closing `catch`/`finally` of the function (currently lines 321-331) with:

```ts
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      logError("hfm-service", "fetchAllClients request timeout");
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  }
}
```

- [x] **Step 12: Convert `fetchClientsByRange`**

In `apps/api/src/services/hfm.service.ts`, replace lines 337-339 (the end of the signature and
the two timer lines) with:

```ts
): Promise<HFMAllClientsResult> {
  try {
```

Replace line 346 inside the `fetch` call:

```ts
      signal: AbortSignal.timeout(timeoutMs),
```

Replace the closing `catch`/`finally` of the function (currently lines 361-371) with:

```ts
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      logError("hfm-service", "fetchClientsByRange request timeout");
      return { ok: false, reason: "timeout" };
    }
    logError("hfm-service", e);
    return { ok: false, reason: "server_error" };
  }
}
```

- [x] **Step 13: Convert `fetchMonthlyVolumeMap`**
  > Deviation: the confirm grep cannot return "no output" as written, because the helper comment inserted in
  > Step 8 (text taken verbatim from the plan) contains the word "AbortController". That comment line is the
  > only match; no code-level AbortController/clearTimeout remains in the file.

In `apps/api/src/services/hfm.service.ts`, delete lines 383-384:

```ts
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
```

Replace line 394 inside the `fetch` call:

```ts
      signal: AbortSignal.timeout(timeoutMs),
```

Replace the closing `catch`/`finally` of the function (currently lines 416-422) with:

```ts
  } catch (e: unknown) {
    logError("hfm-service", e);
    return null;
  }
}
```

This function already degrades every failure to `null`, including a timeout, so it needs no
`isTimeoutError` branch.

Then confirm no hand-rolled abort timer is left in the file:

```bash
cd apps/api && grep -n "AbortController\|clearTimeout" src/services/hfm.service.ts
```

Expected: no output.

- [x] **Step 14: Run the HFM tests**

```bash
cd apps/api && bun test tests/hfm-timeouts.test.ts tests/hfm.service.test.ts
```

Expected: PASS, 64 tests.
`tests/hfm.service.test.ts:279-294` still passes: it aborts through the injected signal with
its own `AbortError`, and `isTimeoutError` accepts that name too.

- [x] **Step 15: Commit**

```bash
git add apps/api/src/services/hfm.service.ts apps/api/tests/hfm-timeouts.test.ts
git commit -m "fix: bound HFM calls with AbortSignal.timeout"
```

### 7c. The daily report retry ladder

`src/jobs/daily-client-report.ts:253-279` retries `fetchCurrent()` three times and sleeps
`attempt * 5_000` ms between attempts at `:269` and `:273`, so 15 seconds of the run is pure
sleeping.
`setTimeout` does not reliably delay on Workers, so that sleep is a lie there.

The cron budget is not the problem: a trigger with an interval of one hour or more gets 15
minutes of wall time and 15 minutes of CPU, and network wait costs no CPU.
The fix is to drop the sleeps and bound each attempt instead.
The spacing between attempts is then the call itself: each attempt is a real `/api/clients/`
round trip, about 7 seconds when HFM is healthy and at most `CRON_FETCH_TIMEOUT_MS` when it is
not, so three attempts are 135 seconds worst case.

- [x] **Step 16: Tighten the retry test**

Replace lines 518-539 of `apps/api/tests/daily-client-report.test.ts`:

```ts
  test("does not throw when HFM fetch fails after retries", async () => {
    process.env.TARGET_WALLET = "30506525";
    await seedFromEnv(db, "Utest001");

    let calls = 0;
    const mockFetchFail = async () => {
      calls++;
      return { ok: false as const, reason: "server_error" as const };
    };
    const mockPushAll = async () => {};

    const startedAt = Date.now();
    await runDailyClientReport({
      now: new Date("2026-04-25T22:00:00.000Z"),
      db,
      fetchClientsFn: mockFetchFail,
      pushToAllFn: mockPushAll,
    });
    const elapsed = Date.now() - startedAt;

    expect(calls).toBe(3);
    // The retry ladder used to sleep 5s then 10s between attempts. setTimeout
    // does not reliably delay on Workers, so the sleeps are gone and the wall
    // time is now only the cost of the calls themselves.
    expect(elapsed).toBeLessThan(1_000);
    const today = getIctDateString(new Date("2026-04-25T22:00:00.000Z"));
    expect(await countByDate(db, today)).toBe(0);
  });
```

The `30_000` timeout argument is deliberately gone: the test must finish inside the default
5 second budget now.

- [x] **Step 17: Run the test to verify it fails**

```bash
cd apps/api && bun test tests/daily-client-report.test.ts -t "does not throw when HFM fetch fails after retries"
```

Expected: FAIL with

```text
(fail) runDailyClientReport > does not throw when HFM fetch fails after retries [5053.04ms]
  ^ this test timed out after 5000ms.
```

and these two lines above it:

```text
[cron] ensureTodaySnapshot attempt 1/3 failed (server_error), retrying in 5s...
[cron] ensureTodaySnapshot attempt 2/3 failed (server_error), retrying in 10s...
```

- [x] **Step 18: Remove the sleeps and add explicit ceilings**

In `apps/api/src/jobs/daily-client-report.ts`, insert before line 212
(`export interface RunDailyClientReportOptions {`):

```ts
// The reply path answers a LINE event whose reply token dies 60s after the
// event, so its HFM budget is 20s. The cron has the 15 minute wall budget of a
// >= 1h-interval trigger, so it can afford 45s per attempt; three attempts is
// 135s worst case.
const REPLY_FETCH_TIMEOUT_MS = 20_000;
const CRON_FETCH_TIMEOUT_MS = 45_000;

```

Replace lines 268-273 inside `ensureTodaySnapshot`:

```ts
    if (attempt < maxRetries) {
      // No sleep between attempts. setTimeout does not reliably delay on
      // Workers, and the spacing comes from the call itself: every attempt is
      // a real /api/clients/ round trip of ~7s, bounded by CRON_FETCH_TIMEOUT_MS.
      console.warn(
        `[cron] ensureTodaySnapshot attempt ${attempt}/${maxRetries} failed (${reason}), retrying now...`,
      );
    } else {
```

Replace line 472 inside `generateReportForUser`:

```ts
  const fetchCurrent =
    options.fetchClientsFn ?? (() => fetchClients(REPLY_FETCH_TIMEOUT_MS));
```

Replace line 482 inside `runDailyClientReport`:

```ts
  const fetchCurrent =
    options.fetchClientsFn ?? (() => fetchClients(CRON_FETCH_TIMEOUT_MS));
```

- [x] **Step 19: Run the daily report tests**

```bash
cd apps/api && bun test tests/daily-client-report.test.ts
```

Expected: PASS, 21 tests.
The file drops from about 15 seconds of wall time to under half a second, because the two
sleeps were the bulk of it.

- [x] **Step 20: Commit**

```bash
git add apps/api/src/jobs/daily-client-report.ts apps/api/tests/daily-client-report.test.ts
git commit -m "fix: bound the daily snapshot retry ladder"
```

### 7d. `src/utils/signature.ts` keeps `node:crypto`

**Decision: keep `node:crypto`. Do not rewrite on WebCrypto.**

Three reasons, in order of weight.

1. The exported signature must stay synchronous.
   `verifyLineSignature(rawBody, signature, channelSecret): boolean` is frozen by the contract
   and is called as a plain boolean guard at `src/routes/webhook.ts:165`.
   `crypto.subtle.sign` is asynchronous and has no synchronous form, so a WebCrypto rewrite
   would force `Promise<boolean>` and change every caller.
2. `node:crypto` is fully supported at this compatibility date.
   At `compatibility_date` `2026-09-22`, `nodejs_compat` is on by default, and Cloudflare
   states that "All `node:crypto` APIs are fully supported in Workers" with four exceptions
   (DSA/DH key generation, argon2, ed448/x448, FIPS toggling), none of which is used here
   (<https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/>).
   `createHmac("sha256", ...)`, `timingSafeEqual` and `Buffer` are all in scope.
3. There is no synchronous constant-time compare in WebCrypto.
   A rewrite would also have to hand-roll the comparison that `timingSafeEqual` already does
   correctly, including its throw on a length mismatch, which the current `catch` turns into
   `false` at `src/utils/signature.ts:13-15`.

The file therefore keeps its exact logic and gains one comment explaining why it is safe.
The five existing tests in `tests/signature.test.ts` keep passing untouched:
`valid HMAC signature returns true`, `invalid signature returns false`,
`wrong secret returns false`, `length-mismatched signature returns false without throwing`,
`empty signature returns false`.
One test is added for a non-ASCII body, because both `Buffer.from(rawBody)` inside the HMAC
and the UTF-8 decoding of the webhook body must behave the same on Workers as on Bun.

- [x] **Step 21: Add the non-ASCII signature test**

Append to `apps/api/tests/signature.test.ts`:

```ts

test("verifies a body with non-ASCII characters", () => {
  const body = '{"events":[{"message":{"text":"สวัสดี"}}]}';
  const sig = computeSig(body, SECRET);
  expect(verifyLineSignature(body, sig, SECRET)).toBe(true);
});
```

- [x] **Step 22: Document why the file stays on node:crypto**

Replace the whole of `apps/api/src/utils/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

// Stays on node:crypto on Cloudflare Workers by choice. At compatibility_date
// 2026-09-22 nodejs_compat is on by default and Cloudflare supports all of
// node:crypto except DSA/DH key generation, argon2, ed448/x448 and FIPS
// toggling, so createHmac, timingSafeEqual and Buffer all work as they do on
// Bun. The WebCrypto alternative, crypto.subtle.sign, is async only, which
// would turn this synchronous guard into a Promise and change every caller,
// and WebCrypto has no synchronous constant-time compare to replace
// timingSafeEqual.
export function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string
): boolean {
  const digest = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  try {
    // Throws when the two buffers differ in length, which is exactly the
    // "signature is garbage" case, so the catch answers false.
    return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}
```

- [x] **Step 23: Run the signature tests**

```bash
cd apps/api && bun test tests/signature.test.ts
```

Expected: PASS, 6 tests.

- [x] **Step 24: Commit**

```bash
git add apps/api/src/utils/signature.ts apps/api/tests/signature.test.ts
git commit -m "docs: justify node:crypto for LINE signatures"
```

### 7e. Outbound concurrency audit

Only **6** outbound connections may wait for response headers at once, counting `fetch`, KV
operations, Queues sends and TCP sockets
(<https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections>).
A seventh is queued rather than failed, so an oversized fan-out becomes a silent serialisation,
not an error.

**Audit result: every `Promise.all` and `Promise.allSettled` in `src/`.**

```bash
cd apps/api && grep -rn "Promise.all\|Promise.allSettled\|Promise.race" src
```

| Site | What it does | Over fetch? | In-flight fetches |
| --- | --- | --- | --- |
| `src/services/last-trade.service.ts:94` (`Promise.race`) | Races one already-started refresh against a deadline timer | No | 1 |

There is no `Promise.all` or `Promise.allSettled` anywhere in `src/`.
The only match is the deadline race above, and it starts no additional request.
The one other match in the repo, `tests/last-trade.service.test.ts:134`, is a test awaiting two
calls that the single-flight guard collapses into one fetch.

Every fan-out in `src/` is a sequential `await` loop, so the maximum number of outbound
connections waiting for headers in one invocation is 1:

| Fan-out | File:line | Shape | Max in flight |
| --- | --- | --- | --- |
| LINE push to every recipient | `src/services/line.service.ts:163-170` | `for` loop, awaited | 1 |
| Snapshot retry ladder | `src/jobs/daily-client-report.ts:253-279` | `for` loop, awaited, at most 3 | 1 |
| Last-trade refresh ladder | `src/services/last-trade.service.ts` `refreshLastTradeCache` | `for` loop, awaited, at most 3 | 1 |
| Queue batch | `src/queue/consumer.ts` `handleQueueBatch` (Task 2) | `for` loop, awaited per message | 1 |

**No bounded-concurrency helper is needed.**
Adding one now would be speculative code with no caller.
Instead the audit is frozen as a test, so the next `Promise.all` over fetch cannot land
unnoticed.

- [x] **Step 25: Add the fan-out guard test**

Create `apps/api/tests/no-unbounded-fanout.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Workers allow only 6 outbound connections to wait for response headers at
// once, so an unbounded Promise.all over fetch is a silent queue, not
// parallelism. There is none in src/ today and this test keeps it that way.
// A future bounded fan-out must go through a helper with an explicit limit.
test("src/ has no unbounded Promise.all fan-out", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("Promise.all(") || line.includes("Promise.allSettled(")) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
```

This test uses `node:fs` against the checked-out source tree, so it runs under `bun test` only.
It is never bundled into the Worker.

- [x] **Step 26: Run the guard test**

```bash
cd apps/api && bun test tests/no-unbounded-fanout.test.ts
```

Expected: PASS, 1 test.
It passes immediately because the audit found nothing to fix; its value is the next change.

- [x] **Step 27: Run the whole suite and typecheck**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: PASS.

- [x] **Step 28: Commit**

```bash
git add apps/api/tests/no-unbounded-fanout.test.ts
git commit -m "test: guard against unbounded fetch fan-out"
```

### Verification notes for Tasks 5 and 7

Every code block in these two tasks was applied to a scratch copy of `apps/api` and run with
`bun test` and `bunx tsc --noEmit` against the real test database before being written down.

- Full suite after both tasks: **355 pass, 0 fail, 28 files** in the scratch copy, with three
  repeated clean runs of the Task 5 subset.
- `tests/last-trade.service.test.ts`: all 9 existing tests pass unchanged against the rewritten
  service.
- `tests/daily-client-report.test.ts -t "does not throw when HFM fetch fails after retries"`:
  **15.14s before, 103ms after**.
- Known pre-existing flake, not introduced here: under heavy parallel load
  `tests/webhook-logging.test.ts` "last-trade fetch past the deadline logs a latency warning"
  can exceed its 5s `waitForLog` budget and time out.
  It passed in every unloaded run.
  If it appears in CI, raise that single `waitForLog` timeout rather than changing the handler.

## Interface notes for Tasks 8, 9 and 10

Tasks 8, 9 and 10 introduce these names. Every other task may rely on them.

- `tests/deploy-scripts.test.ts` is a new test file. It guards `package.json` against a tenant that has a wrangler config but no deploy script.
- Each `wrangler.<tenant>.jsonc` carries a `secrets` block with a `required` array of the 4 secret names.
  It holds names only, never values.
  Verified accepted by wrangler 4.136.2: `wrangler deploy --dry-run` prints no "Unexpected fields" warning for it, while a deliberately bogus key does print one.
- Worker names: `hfm-bot-maow`, `hfm-bot-simple-trade`, `hfm-bot-maow-staging`.
- Hostnames: `maow-bot.hfm-automation.com`, `simple-trade-bot.hfm-automation.com`.
  `hfm-automation.com` is a stand-in for the real Cloudflare zone.
  Replace the zone part in both files before the first deploy; the guard test keeps the two patterns unique either way.
- Queue names: `hfm-events-maow` and `hfm-events-simple-trade`, each with a `-dlq` dead letter queue.
- Local files: `.dev.vars.maow`, `.dev.vars.simple-trade`, `.env.maow.admin`, `.env.simple-trade.admin`, and `bundled/`.
  All are git-ignored.
- Test rule refinement: `LINE_WHITELIST_UIDS`, `LINE_GROUP_WHITELIST_IDS` and `LINE_NOTIFY_UIDS` may be the empty string, because empty means "allow everyone" (`apps/api/src/utils/whitelist.ts:29-31`, `:39-40`) and "no seeded recipients".
  Every other `vars` key must be present and non-empty.
- Test rule addition: no `vars` value may contain `<` or `>` or start with `REPLACE_WITH`, and `TARGET_WALLET` must be digits only.
  Angle-bracket placeholders stay legal for infra ids (`hyperdrive`, `kv_namespaces`), because a wrong id fails loudly at deploy time while a wrong flag value fails silently in production.
- The staging config lives at `staging/wrangler.maow-staging.jsonc`, outside the `wrangler.*.jsonc` glob, so the production guard test never sees `workers_dev: true`.

---

## Task 8: Per-tenant wrangler configuration

### Why one complete config file per tenant, not named environments

1. `vars`, `hyperdrive`, `kv_namespaces`, `queues` and secrets are all non-inheritable, so a named environment must repeat every one of them in full anyway.
2. The reuse a named environment would buy is therefore almost zero: only `main`, `compatibility_date`, `limits`, `observability` and `triggers` are shared.
3. The cost is a silent-failure mode: a forgotten non-inheritable key is not a deploy error, it is `undefined` inside the Worker at runtime, on a production LINE webhook.

Source: <https://developers.cloudflare.com/workers/wrangler/configuration/#environments> and the option (a) versus option (b) comparison in `docs/research/cf-workers-migration-facts.md` section 1.

**Files:**
- Create: `apps/api/wrangler.maow.jsonc`
- Create: `apps/api/wrangler.simple-trade.jsonc`
- Create: `apps/api/staging/wrangler.maow-staging.jsonc`
- Create: `apps/api/tests/tenant-config.test.ts`
- Modify: `apps/api/.gitignore:19-25` (the "dotenv environment variable files" block)

All commands in this task run from `apps/api`.

- [x] **Step 1: Confirm the Cloudflare toolchain from Task 1**

Task 1 Step 1 installed `wrangler` and `@cloudflare/workers-types`. Confirm both are in
`devDependencies`:

```bash
cd apps/api && grep -E '"(wrangler|@cloudflare/workers-types)"' package.json
```

Expected: two lines, `"@cloudflare/workers-types": "^5.20260922.1"` and `"wrangler": "^4.136.2"`.
If either is missing, run Task 1 Steps 1 to 4 first.

- [x] **Step 2: Verify the Wrangler binary resolves**

Run: `bunx wrangler --version`
Expected: `4.136.2`.

Record that number. It is the version every command in Tasks 8, 9 and 10 was verified against.

- [x] **Step 3: Write the failing tenant-config guard test**

Create `apps/api/tests/tenant-config.test.ts` with exactly this content.

```ts
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
    // Only the 5 minute job. The daily report cron was removed on purpose in
    // commit 96e6a0e and must not come back through a tenant config.
    expect(first).toBe("./src/worker.ts|2026-09-22|*/5 * * * *");
  });
});
```

- [x] **Step 4: Run the guard test and confirm it fails**

Run: `bun test tests/tenant-config.test.ts`

Expected: FAIL, because no `wrangler.*.jsonc` file exists yet.

```text
error: expect(received).toEqual(expected)

- [
-   "wrangler.maow.jsonc",
-   "wrangler.simple-trade.jsonc",
- ]
+ []

(fail) wrangler tenant configs > both tenant config files exist
 12 pass
 4 fail
```

The other three failures are `binding names are identical across tenants`, `every tenant declares the same required secrets` and `shared keys have not drifted between tenant files`, all reporting `Received: undefined` because the config list is empty.

- [x] **Step 5: Create `apps/api/wrangler.maow.jsonc`**

```jsonc
{
  // Complete tenant spec for `maow`. Deployed with:
  //   bun run deploy:maow   ->  wrangler deploy -c wrangler.maow.jsonc
  // Nothing is inherited from another file. Every key this tenant needs is
  // written here, because wrangler `vars`, `hyperdrive`, `kv_namespaces`,
  // `queues` and secrets are all non-inheritable.
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "hfm-bot-maow",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-09-22",
  // nodejs_compat is on by default at this compatibility date, so it is NOT
  // listed in compatibility_flags. Adding it again is an error.
  "workers_dev": false,
  "routes": [
    { "pattern": "maow-bot.hfm-automation.com", "custom_domain": true }
  ],
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  // CPU ceiling for HTTP invocations. Cron CPU is capped by the platform at
  // 30s for the */5 job, which limits does not raise.
  "limits": { "cpu_ms": 300000 },
  // UTC only. The daily report cron was removed on purpose (commit 96e6a0e);
  // run it by hand with `bun run trigger:daily-client-report`.
  "triggers": { "crons": ["*/5 * * * *"] },
  "vars": {
    "TENANT": "maow",
    "HFM_API_BASE_URL": "https://api.hfaffiliates.com",
    "TARGET_WALLET": "REPLACE_WITH_MAOW_WALLET_ID",
    "DEPOSIT_THRESHOLD_USD": "200",
    "DEPOSIT_THRESHOLD_USC": "20000",
    "LINE_WHITELIST_ENABLED": "true",
    "LINE_WHITELIST_UIDS": "",
    "LINE_GROUP_WHITELIST_ENABLED": "true",
    "LINE_GROUP_WHITELIST_IDS": "",
    "LINE_NOTIFY_UIDS": "",
    "LAST_TRADE_DEADLINE_MS": "8000",
    "FLEX_SUMMARY_VERSION": "flex-v1",
    "LOT_DISPLAY_MODE": "always",
    "LOG_LEVEL": "info"
  },
  // Names only, never values. A missing secret is reported at deploy time.
  "secrets": {
    "required": [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET",
      "HFM_API_KEY",
      "INTERNAL_API_KEY"
    ]
  },
  // Created with --caching-disabled: this app reads its own writes and
  // Hyperdrive's query cache does not invalidate on write.
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<MAOW_HYPERDRIVE_ID>" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "<MAOW_KV_ID>" }],
  "queues": {
    "producers": [{ "binding": "EVENT_QUEUE", "queue": "hfm-events-maow" }],
    "consumers": [
      {
        "queue": "hfm-events-maow",
        // One LINE event per invocation: a batch runs sequentially, so a
        // bigger batch lets one slow lookup expire the next reply token (60s).
        "max_batch_size": 1,
        "max_batch_timeout": 0,
        // No retries: a retry can reuse a spent reply token and push a
        // duplicate answer. Failures go straight to the dead letter queue.
        "max_retries": 0,
        "dead_letter_queue": "hfm-events-maow-dlq"
      }
    ]
  }
}
```

- [x] **Step 6: Create `apps/api/wrangler.simple-trade.jsonc`**

```jsonc
{
  // Complete tenant spec for `simple-trade`. Deployed with:
  //   bun run deploy:simple-trade   ->  wrangler deploy -c wrangler.simple-trade.jsonc
  // Nothing is inherited from another file. Every key this tenant needs is
  // written here, because wrangler `vars`, `hyperdrive`, `kv_namespaces`,
  // `queues` and secrets are all non-inheritable.
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "hfm-bot-simple-trade",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-09-22",
  // nodejs_compat is on by default at this compatibility date, so it is NOT
  // listed in compatibility_flags. Adding it again is an error.
  "workers_dev": false,
  "routes": [
    { "pattern": "simple-trade-bot.hfm-automation.com", "custom_domain": true }
  ],
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  // CPU ceiling for HTTP invocations. Cron CPU is capped by the platform at
  // 30s for the */5 job, which limits does not raise.
  "limits": { "cpu_ms": 300000 },
  // UTC only. The daily report cron was removed on purpose (commit 96e6a0e);
  // run it by hand with `bun run trigger:daily-client-report`.
  "triggers": { "crons": ["*/5 * * * *"] },
  "vars": {
    "TENANT": "simple-trade",
    "HFM_API_BASE_URL": "https://api.hfaffiliates.com",
    "TARGET_WALLET": "REPLACE_WITH_SIMPLE_TRADE_WALLET_ID",
    "DEPOSIT_THRESHOLD_USD": "200",
    "DEPOSIT_THRESHOLD_USC": "20000",
    "LINE_WHITELIST_ENABLED": "true",
    "LINE_WHITELIST_UIDS": "",
    "LINE_GROUP_WHITELIST_ENABLED": "true",
    "LINE_GROUP_WHITELIST_IDS": "",
    "LINE_NOTIFY_UIDS": "",
    "LAST_TRADE_DEADLINE_MS": "8000",
    "FLEX_SUMMARY_VERSION": "flex-v2",
    "LOT_DISPLAY_MODE": "lot_prefix_only",
    "LOG_LEVEL": "info"
  },
  // Names only, never values. A missing secret is reported at deploy time.
  "secrets": {
    "required": [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET",
      "HFM_API_KEY",
      "INTERNAL_API_KEY"
    ]
  },
  // Created with --caching-disabled: this app reads its own writes and
  // Hyperdrive's query cache does not invalidate on write.
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<SIMPLE_TRADE_HYPERDRIVE_ID>" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "<SIMPLE_TRADE_KV_ID>" }],
  "queues": {
    "producers": [{ "binding": "EVENT_QUEUE", "queue": "hfm-events-simple-trade" }],
    "consumers": [
      {
        "queue": "hfm-events-simple-trade",
        // One LINE event per invocation: a batch runs sequentially, so a
        // bigger batch lets one slow lookup expire the next reply token (60s).
        "max_batch_size": 1,
        "max_batch_timeout": 0,
        // No retries: a retry can reuse a spent reply token and push a
        // duplicate answer. Failures go straight to the dead letter queue.
        "max_retries": 0,
        "dead_letter_queue": "hfm-events-simple-trade-dlq"
      }
    ]
  }
}
```

The two tenants differ in exactly seven places: `name`, the route pattern, `TENANT`, `TARGET_WALLET`, `FLEX_SUMMARY_VERSION` (flex-v1 versus flex-v2), `LOT_DISPLAY_MODE`, and the three resource identifiers (Hyperdrive id, KV id, queue name).
Everything else is byte-identical, and the guard test fails if that stops being true.

- [x] **Step 7: Run the guard test and confirm the two wallet failures**

Run: `bun test tests/tenant-config.test.ts`

Expected: FAIL with exactly two failing tests.

```text
Expected: "wrangler.maow.jsonc:TARGET_WALLET unresolved=false"
Received: "wrangler.maow.jsonc:TARGET_WALLET unresolved=true"
(fail) wrangler tenant configs > no vars value is an unresolved placeholder

Expected substring or pattern: /: [0-9]+$/
Received: "wrangler.maow.jsonc: REPLACE_WITH_MAOW_WALLET_ID"
(fail) wrangler tenant configs > TARGET_WALLET is a plain wallet number

 14 pass
 2 fail
```

This is the point of the placeholder rule.
A business flag cannot reach production unresolved, because the test blocks the commit.

- [x] **Step 8: Fill in the two real wallet ids**

> Operator-supplied in-session (2026-09-26): maow=30506525, simple-trade=55946812. Route zones re-pointed from the stand-in hfm-automation.com to the operator's zone eukron.com in the same pass (the plan's interface note says to replace the stand-in zone before the first deploy).

Ask the operator for the HFM partner wallet id of each tenant.
Do not guess and do not copy a value out of `.env`.

In `apps/api/wrangler.maow.jsonc`, replace:

```jsonc
    "TARGET_WALLET": "REPLACE_WITH_MAOW_WALLET_ID",
```

with the real digits, for example:

```jsonc
    "TARGET_WALLET": "1120643",
```

In `apps/api/wrangler.simple-trade.jsonc`, replace:

```jsonc
    "TARGET_WALLET": "REPLACE_WITH_SIMPLE_TRADE_WALLET_ID",
```

with the real digits, for example:

```jsonc
    "TARGET_WALLET": "1120644",
```

- [x] **Step 9: Run the guard test and confirm it passes**

Run: `bun test tests/tenant-config.test.ts`

Expected: PASS.

```text
 16 pass
 0 fail
```

- [x] **Step 10: Commit the tenant configs**

```bash
git add apps/api/wrangler.maow.jsonc apps/api/wrangler.simple-trade.jsonc apps/api/tests/tenant-config.test.ts apps/api/package.json apps/api/bun.lock
git commit -m "feat: add per-tenant wrangler configs"
```

- [x] **Step 11: Create the KV namespace for each tenant**

```bash
cd apps/api
bunx wrangler kv namespace create hfm-cache-maow
bunx wrangler kv namespace create hfm-cache-simple-trade
```

Expected: each command prints a block containing the new namespace id, for example `"id": "3f7a1c4e9b2d4f118c0e5a6b7d8e9f00"`.

Paste the maow id into `apps/api/wrangler.maow.jsonc` replacing `<MAOW_KV_ID>`, and the simple-trade id into `apps/api/wrangler.simple-trade.jsonc` replacing `<SIMPLE_TRADE_KV_ID>`.

- [x] **Step 12: Create the queues and their dead letter queues**

```bash
cd apps/api
bunx wrangler queues create hfm-events-maow
bunx wrangler queues create hfm-events-maow-dlq
bunx wrangler queues create hfm-events-simple-trade
bunx wrangler queues create hfm-events-simple-trade-dlq
```

Expected: `Created queue 'hfm-events-maow'` and one such line per queue.

Queue names are already written into both config files, so nothing needs pasting here.
The dead letter queues must exist before a deploy that references them.

- [ ] **Step 13: Create one Hyperdrive config per tenant, caching disabled**
> Awaiting operator: the tenant origin Postgres URLs (DATABASE_URL_MAOW / DATABASE_URL_SIMPLE_TRADE) - hyperdrive create needs each origin connection string. Wrangler's OAuth scope for hyperdrive create is also unverified; if it fails on permissions, fall back to a dashboard-created token.

```bash
cd apps/api
bunx wrangler hyperdrive create hfm-maow \
  --connection-string="$MAOW_DATABASE_URL" \
  --caching-disabled
bunx wrangler hyperdrive create hfm-simple-trade \
  --connection-string="$SIMPLE_TRADE_DATABASE_URL" \
  --caching-disabled
```

Export `MAOW_DATABASE_URL` and `SIMPLE_TRADE_DATABASE_URL` in the shell first, from the operator's password manager.
Never paste a connection string into a file in this repo and never echo it.

`--caching-disabled` is not optional.
Hyperdrive's query cache is on by default, has a 60s `max_age`, and does not invalidate on write, so a whitelist row or a `job_state` row read right after it was written can come back stale.

Expected: each command prints the new config and its id, for example `id: 8a2c...`.

Paste the maow id into `apps/api/wrangler.maow.jsonc` replacing `<MAOW_HYPERDRIVE_ID>`, and the simple-trade id into `apps/api/wrangler.simple-trade.jsonc` replacing `<SIMPLE_TRADE_HYPERDRIVE_ID>`.

- [x] **Step 14: Verify both configs still pass the guard test**

Run: `bun test tests/tenant-config.test.ts`
Expected: `16 pass`, `0 fail`.

The test does not check the infra ids, so this step only proves that pasting the ids did not break the JSONC syntax or the `vars` block.

- [x] **Step 15: Run the Wrangler compile-time gate on both tenants**
> Deviation: run before Step 13, so both dry-runs print the Hyperdrive binding with its `<..._HYPERDRIVE_ID>` placeholder; every other Expected condition holds (exit 0, all 14 vars + 3 bindings, no `Unexpected fields` warning). Re-run after the real ids land.

```bash
cd apps/api
bunx wrangler deploy --dry-run --outdir bundled/maow -c wrangler.maow.jsonc
bunx wrangler deploy --dry-run --outdir bundled/simple-trade -c wrangler.simple-trade.jsonc
```

Expected for each: a bindings table listing `env.CACHE`, `env.EVENT_QUEUE`, `env.HYPERDRIVE` and all 14 `vars`, then `--dry-run: exiting now.` with exit code 0, and **no** `WARNING ... Unexpected fields` line.

Verified on wrangler 4.136.2 with a stub `src/worker.ts`: exit code 0, `Total Upload: 0.17 KiB`.
This dry run is the single most valuable check in the migration, because it is the only step that compiles the real Worker bundle and reports Workers incompatibilities without touching production.

- [x] **Step 16: Commit the resource ids**
> Deviation: commit 633526b wires only the KV ids (queue names were already in the files); Hyperdrive ids remain placeholders until Step 13, so its paste rides with that step.

```bash
git add apps/api/wrangler.maow.jsonc apps/api/wrangler.simple-trade.jsonc
git commit -m "chore: wire tenant kv, queue and hyperdrive ids"
```

- [ ] **Step 17: Upload the 4 secrets for maow**
> Awaiting operator: the production maow channel secrets (LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, HFM_API_KEY, INTERNAL_API_KEY) from the operator's password manager. The credentials supplied so far are the staging/test channel's.

```bash
cd apps/api
bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN -c wrangler.maow.jsonc
bunx wrangler secret put LINE_CHANNEL_SECRET -c wrangler.maow.jsonc
bunx wrangler secret put HFM_API_KEY -c wrangler.maow.jsonc
bunx wrangler secret put INTERNAL_API_KEY -c wrangler.maow.jsonc
```

Each command prompts for the value and never echoes it.
`-c` is a global Wrangler flag, so it selects the tenant Worker for `secret put` exactly like it does for `deploy`.
A secret uploaded without `-c` lands on whatever Worker the default config names, which is the classic way to give one tenant another tenant's LINE token.

- [ ] **Step 18: Upload the 4 secrets for simple-trade**
> Awaiting operator: the production simple-trade channel secrets, same four keys.

```bash
cd apps/api
bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN -c wrangler.simple-trade.jsonc
bunx wrangler secret put LINE_CHANNEL_SECRET -c wrangler.simple-trade.jsonc
bunx wrangler secret put HFM_API_KEY -c wrangler.simple-trade.jsonc
bunx wrangler secret put INTERNAL_API_KEY -c wrangler.simple-trade.jsonc
```

- [ ] **Step 19: Verify the secret inventory per tenant**
> Awaiting operator: runs after Steps 17-18.

```bash
cd apps/api
bunx wrangler secret list -c wrangler.maow.jsonc
bunx wrangler secret list -c wrangler.simple-trade.jsonc
```

Expected for each: a JSON array with exactly these four names and no values.

```text
[
  { "name": "HFM_API_KEY", "type": "secret_text" },
  { "name": "INTERNAL_API_KEY", "type": "secret_text" },
  { "name": "LINE_CHANNEL_ACCESS_TOKEN", "type": "secret_text" },
  { "name": "LINE_CHANNEL_SECRET", "type": "secret_text" }
]
```

If a name is missing, stop and upload it.
The Worker would otherwise start with `undefined` for that key.

- [x] **Step 20: Create the local dev secret files**
> Deviation: templates created with empty values as the plan's blocks show; filling them is operator work at first local dev (values live in the operator's password manager, never in this repo).

`wrangler dev` loads `.dev.vars.<name>` when `--env <name>` is used, and `.dev.vars` otherwise.
This project uses separate config files rather than named environments, so the per-tenant files are selected explicitly on the command line in Task 9.

Create `apps/api/.dev.vars.maow`:

```text
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
HFM_API_KEY=
INTERNAL_API_KEY=
```

Create `apps/api/.dev.vars.simple-trade`:

```text
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
HFM_API_KEY=
INTERNAL_API_KEY=
```

Fill the values locally from the operator's password manager.
Never commit a filled file.

- [x] **Step 21: Git-ignore every local secret and build artefact**

In `apps/api/.gitignore`, the current dotenv block is at lines 19-25:

```text
# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local
```

Replace that block with:

```text
# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# per-tenant local secrets (wrangler dev) and admin env files (migrations)
.dev.vars
.dev.vars.*
.env.*.admin

# wrangler dry-run output and local state
bundled/
.wrangler/
```

- [x] **Step 22: Prove the secret files are ignored**

Run: `cd apps/api && git status --porcelain --ignored .dev.vars.maow .dev.vars.simple-trade`
Expected: two lines, each starting with `!!`, which means ignored.

```text
!! apps/api/.dev.vars.maow
!! apps/api/.dev.vars.simple-trade
```

If a line starts with `??` the file is untracked but **not** ignored.
Stop and fix `.gitignore` before any commit.

- [x] **Step 23: Commit the ignore rules**

```bash
git add apps/api/.gitignore
git commit -m "chore: ignore per-tenant local secrets"
```

- [x] **Step 24: Confirm each feature flag has one reader**

Flags stay in `process.env`, which Cloudflare fills from this file's `vars` (Task 1 explains why).
No accessor layer is added: each flag already has exactly one getter, and that getter is the
only place that parses it. This check proves that is still true after Tasks 1 to 7.

```bash
cd apps/api && grep -rnoE "process\.env\.(FLEX_SUMMARY_VERSION|LOT_DISPLAY_MODE|DEPOSIT_THRESHOLD_US[DC]|TARGET_WALLET|LAST_TRADE_DEADLINE_MS|LINE_(GROUP_)?WHITELIST_[A-Z]+)" src | cut -d: -f1 | sort | uniq -c
```

Expected, one line per file:

```text
   1 src/builders/flex-message.builder.ts
   2 src/jobs/daily-client-report.ts
   4 src/services/hfm.service.ts
   1 src/services/webhook-dispatcher.ts
   4 src/utils/whitelist.ts
```

| Flag | Getter | File |
| --- | --- | --- |
| `FLEX_SUMMARY_VERSION` | `getFlexSummaryVersion()` | `src/builders/flex-message.builder.ts` |
| `LOT_DISPLAY_MODE` | `getLotDisplayMode()` | `src/services/hfm.service.ts` |
| `DEPOSIT_THRESHOLD_USD`, `DEPOSIT_THRESHOLD_USC` | `getDepositThreshold()` | `src/services/hfm.service.ts` |
| `TARGET_WALLET` | `checkConditions()`, `getTargetWallet()` | `src/services/hfm.service.ts`, `src/jobs/daily-client-report.ts` |
| `LAST_TRADE_DEADLINE_MS` | `lastTradeDeadlineMs()` | `src/services/webhook-dispatcher.ts` (moved there in Task 2) |
| `LINE_WHITELIST_*`, `LINE_GROUP_WHITELIST_*` | `isChatAllowed()` | `src/utils/whitelist.ts` |

A new file in the list means a flag is parsed twice. Route the new read through the existing
getter instead.

- [ ] **Step 25: Checklist for adding a third tenant later**

Save this list as the last section of `apps/api/AGENTS.md` in Task 10.
It is the whole cost of a new tenant.

1. Copy `apps/api/wrangler.maow.jsonc` to `apps/api/wrangler.<tenant>.jsonc`.
2. Change `name` to `hfm-bot-<tenant>`, the route `pattern` to the new hostname, and `TENANT` to `<tenant>`.
3. Set `TARGET_WALLET`, `FLEX_SUMMARY_VERSION`, `LOT_DISPLAY_MODE` and the whitelist vars to the new tenant's values.
   Leave every other `vars` key present, even when the value matches maow.
4. `bunx wrangler kv namespace create hfm-cache-<tenant>` and paste the id into `kv_namespaces`.
5. `bunx wrangler queues create hfm-events-<tenant>` and `bunx wrangler queues create hfm-events-<tenant>-dlq`, then set both queue names in `queues.producers` and `queues.consumers`.
6. `bunx wrangler hyperdrive create hfm-<tenant> --connection-string="$NEW_DATABASE_URL" --caching-disabled` and paste the id into `hyperdrive`.
7. Add `deploy:<tenant>`, `dev:<tenant>`, `tail:<tenant>`, `secrets:<tenant>`, `migrate:<tenant>` and `check:bundle:<tenant>` to `apps/api/package.json`, and extend `deploy:all`.
8. Create `apps/api/.dev.vars.<tenant>` and `apps/api/.env.<tenant>.admin`; both are already git-ignored by the `.dev.vars.*` and `.env.*.admin` patterns.
9. `bunx wrangler secret put` the 4 secrets with `-c wrangler.<tenant>.jsonc`.
10. `bun run migrate:<tenant>` to create the schema in the new database.
11. `bun test tests/tenant-config.test.ts tests/deploy-scripts.test.ts` - both guards must pass.
12. `bunx wrangler deploy --dry-run --outdir bundled/<tenant> -c wrangler.<tenant>.jsonc`.
13. Add the Custom Domain hostname in the Cloudflare zone, deploy, then point the new LINE channel's webhook URL at `https://<hostname>/webhook`.

---

## Task 9: package.json scripts and developer workflow

**Files:**
- Modify: `apps/api/package.json:6-16` (the whole `scripts` block)
- Create: `apps/api/tests/deploy-scripts.test.ts`
- Create: `apps/api/.env.maow.admin` and `apps/api/.env.simple-trade.admin` (both git-ignored)

All commands run from `apps/api`.

Wrangler is a Node CLI.
`bun run <script>` where the script shells out to `wrangler` is the safe form, because `bun run` puts `node_modules/.bin` on the PATH and runs the CLI under its own Node shim.
`bun x wrangler` is documented as UNVERIFIED in `docs/research/cf-workers-migration-facts.md` section 1.
It did work for `wrangler --version` and `wrangler deploy --dry-run` during this plan's verification on wrangler 4.136.2, but the `scripts` entries below still use the plain `wrangler ...` form so the deploy path never depends on that.

- [ ] **Step 1: Confirm the toolchain from Task 1 is installed**

Run: `cd apps/api && bunx wrangler --version`
Expected: `4.136.2`.

If the command fails, run the install from Task 1 Step 1:

```bash
cd apps/api
bun add -d wrangler@4.136.2 @cloudflare/workers-types@5.20260922.1
```

After the install, the `devDependencies` block in `apps/api/package.json` must read exactly:

```json
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260922.1",
    "@types/bun": "latest",
    "drizzle-kit": "^0.31.10",
    "wrangler": "^4.136.2"
  },
```

- [ ] **Step 2: Write the failing deploy-surface test**

Create `apps/api/tests/deploy-scripts.test.ts` with exactly this content.

```ts
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guard for the deploy surface: a tenant that has a wrangler config but no
// deploy script is a tenant nobody can ship, and a script pointing at the
// wrong -c file silently deploys the wrong tenant.

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

const PER_TENANT_PREFIXES = [
  "deploy",
  "dev",
  "tail",
  "secrets",
  "migrate",
  "check:bundle",
] as const;

function tenantNames(): string[] {
  const glob = new Glob("wrangler.*.jsonc");
  return [...glob.scanSync({ cwd: APP_DIR, onlyFiles: true })]
    .map((file) => file.replace(/^wrangler\./, "").replace(/\.jsonc$/, ""))
    .sort();
}

function scripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(`${APP_DIR}package.json`, "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("package.json deploy surface", () => {
  test("every tenant has every per-tenant script", () => {
    const all = scripts();
    for (const tenant of tenantNames()) {
      for (const prefix of PER_TENANT_PREFIXES) {
        const key = `${prefix}:${tenant}`;
        expect(`${key} defined=${typeof all[key] === "string"}`).toBe(
          `${key} defined=true`,
        );
      }
    }
  });

  test("every per-tenant script points at that tenant config file", () => {
    const all = scripts();
    for (const tenant of tenantNames()) {
      for (const prefix of ["deploy", "dev", "tail", "secrets", "check:bundle"]) {
        const key = `${prefix}:${tenant}`;
        const command = all[key] ?? "";
        expect(`${key}: ${command.includes(`-c wrangler.${tenant}.jsonc`)}`).toBe(
          `${key}: true`,
        );
      }
    }
  });

  test("every migrate script targets its own tenant database", () => {
    const all = scripts();
    for (const tenant of tenantNames()) {
      const command = all[`migrate:${tenant}`] ?? "";
      const ok =
        command.includes(`--env-file=.env.${tenant}.admin`) &&
        command.includes(`scripts/migrate-tenant.ts ${tenant}`);
      expect(`migrate:${tenant}: ${ok}`).toBe(`migrate:${tenant}: true`);
    }
  });

  test("deploy:all runs every tenant deploy", () => {
    const all = scripts();
    const command = all["deploy:all"] ?? "";
    for (const tenant of tenantNames()) {
      expect(`deploy:all covers ${tenant}: ${command.includes(`deploy:${tenant}`)}`).toBe(
        `deploy:all covers ${tenant}: true`,
      );
    }
  });

  test("the Bun server scripts are gone", () => {
    const all = scripts();
    expect(`dev=${all.dev} start=${all.start}`).toBe("dev=undefined start=undefined");
  });

  test("test and typecheck stay Bun commands", () => {
    const all = scripts();
    expect(all.test).toBe("bun test");
    expect(all.typecheck).toBe("bunx tsc --noEmit");
  });
});
```

- [ ] **Step 3: Run the deploy-surface test and confirm it fails**

Run: `bun test tests/deploy-scripts.test.ts`

Expected: FAIL, because the current `scripts` block has no per-tenant entries.

```text
Expected: "deploy:maow defined=true"
Received: "deploy:maow defined=false"
(fail) package.json deploy surface > every tenant has every per-tenant script

Expected: "deploy:maow: true"
Received: "deploy:maow: false"
(fail) package.json deploy surface > every per-tenant script points at that tenant config file

Expected: "deploy:all covers maow: true"
Received: "deploy:all covers maow: false"
(fail) package.json deploy surface > deploy:all runs every tenant deploy
(fail) package.json deploy surface > the Bun server scripts are gone
 2 pass
 4 fail
```

The fourth failure is `the Bun server scripts are gone`, which stays red while `dev` and `start` are still present.
The two passing tests are `test and typecheck stay Bun commands` and `every migrate script targets its own tenant database`: Task 4 already added `migrate:maow` and `migrate:simple-trade`.

- [ ] **Step 4: Replace the `scripts` block in `apps/api/package.json`**

`apps/api/package.json:6-16` was this before the migration (Tasks 3 and 4 have since added `db:generate`, `migrate:<tenant>` and `tail:<tenant>`; the replacement below keeps all of them):

```json
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "db:push": "bunx drizzle-kit push",
    "trigger:daily-client-report": "bun run scripts/trigger-daily-client-report.ts",
    "trigger:hfm-healthcheck": "bun run scripts/trigger-hfm-healthcheck.ts",
    "fetch:client-performance": "bun run scripts/fetch-client-performance-range.ts",
    "compare:client-performance": "bun run scripts/compare-client-performance-files.ts",
    "seed:mock-snapshots": "bun run scripts/seed-mock-client-snapshots.ts"
  },
```

Replace it with exactly:

```json
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "check:bundle:maow": "wrangler deploy --dry-run --outdir bundled/maow -c wrangler.maow.jsonc",
    "check:bundle:simple-trade": "wrangler deploy --dry-run --outdir bundled/simple-trade -c wrangler.simple-trade.jsonc",
    "dev:maow": "wrangler dev -c wrangler.maow.jsonc --test-scheduled",
    "dev:simple-trade": "wrangler dev -c wrangler.simple-trade.jsonc --test-scheduled",
    "deploy:maow": "wrangler deploy -c wrangler.maow.jsonc",
    "deploy:simple-trade": "wrangler deploy -c wrangler.simple-trade.jsonc",
    "deploy:all": "bun run deploy:maow && bun run deploy:simple-trade",
    "tail:maow": "wrangler tail -c wrangler.maow.jsonc --format pretty",
    "tail:simple-trade": "wrangler tail -c wrangler.simple-trade.jsonc --format pretty",
    "secrets:maow": "wrangler secret list -c wrangler.maow.jsonc",
    "secrets:simple-trade": "wrangler secret list -c wrangler.simple-trade.jsonc",
    "db:generate": "bunx drizzle-kit generate",
    "migrate:maow": "bun --env-file=.env.maow.admin run scripts/migrate-tenant.ts maow",
    "migrate:simple-trade": "bun --env-file=.env.simple-trade.admin run scripts/migrate-tenant.ts simple-trade",
    "trigger:daily-client-report": "bun run scripts/trigger-daily-client-report.ts",
    "trigger:hfm-healthcheck": "bun run scripts/trigger-hfm-healthcheck.ts",
    "fetch:client-performance": "bun run scripts/fetch-client-performance-range.ts",
    "compare:client-performance": "bun run scripts/compare-client-performance-files.ts",
    "seed:mock-snapshots": "bun run scripts/seed-mock-client-snapshots.ts"
  },
```

What changed and why:

- `dev` and `start` are deleted. There is no long-lived Bun server any more, and `src/index.ts` is deleted in Task 10.
- `db:push` is deleted. It reads a single ambiguous `DATABASE_URL`; in a multi-tenant world that is exactly the command that migrates the wrong database. `migrate:<tenant>` replaces it.
- `test` and `typecheck` are unchanged and stay Bun commands.
- The five `trigger:` / `fetch:` / `compare:` / `seed:` operator scripts stay. They run locally under Bun, not on Workers. Select a tenant for them with `bun --env-file=.env.maow.admin run scripts/trigger-hfm-healthcheck.ts`.

- [ ] **Step 5: Run the deploy-surface test and confirm it passes**

Run: `bun test tests/deploy-scripts.test.ts`

Expected: PASS.

```text
 6 pass
 0 fail
```

- [ ] **Step 6: Confirm the Workers-aware tsconfig from Task 1**

```bash
cd apps/api && grep -n '"types"' tsconfig.json
```

Expected: `"types": ["@cloudflare/workers-types", "bun"],`.
If the line is missing, apply Task 1 Step 2 before continuing.

- [ ] **Step 7: Run the typecheck**

Run: `bun run typecheck`
Expected: no output and exit code 0.

- [ ] **Step 8: Run the whole suite**

Run: `bun test`

Start the test database first from the repo root, because the repository tests use a real PostgreSQL:

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
docker compose up -d postgres-test
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
cd apps/api && bun test
```

Expected: every test passes, including the two new guards `tests/tenant-config.test.ts` and `tests/deploy-scripts.test.ts`.

- [ ] **Step 9: Commit the scripts**

```bash
git add apps/api/package.json apps/api/tests/deploy-scripts.test.ts
git commit -m "chore: add per-tenant wrangler scripts"
```

- [ ] **Step 10: Create the per-tenant admin env files for migrations**

`scripts/migrate-tenant.ts` (Task 4) connects straight to PostgreSQL over TCP from the developer machine.
It does not go through Hyperdrive and it is not part of the Worker bundle.
It therefore needs the raw per-tenant connection string.

Create `apps/api/.env.maow.admin`:

```text
# Origin database for tenant maow. Never the Hyperdrive URL.
DATABASE_URL_MAOW=
# The operator scripts in scripts/ read DATABASE_URL; Bun expands the reference.
DATABASE_URL=${DATABASE_URL_MAOW}
```

Create `apps/api/.env.simple-trade.admin`:

```text
# Origin database for tenant simple-trade. Never the Hyperdrive URL.
DATABASE_URL_SIMPLE_TRADE=
# The operator scripts in scripts/ read DATABASE_URL; Bun expands the reference.
DATABASE_URL=${DATABASE_URL_SIMPLE_TRADE}
```

The migration script reads only the tenant-named variable, so a missing or wrong admin file
makes it exit with `DATABASE_URL_MAOW is not set` instead of migrating whatever database a
plain `DATABASE_URL` points at.
Fill each with that tenant's PostgreSQL URL from the operator's password manager.
Both file names match the `.env.*.admin` ignore pattern added in Task 8 Step 21.

- [ ] **Step 11: Apply the migrations to each tenant database**

```bash
cd apps/api
bun run migrate:maow
bun run migrate:simple-trade
```

Expected: `[migrate] migrations applied to maow`, then `[migrate] migrations applied to simple-trade`.

This replaces the old boot-time DDL in `src/db/connection.ts:22-92`, which ran `CREATE TABLE` on every process start.
A Worker has no boot hook that may do that, so the schema is now applied out of band and before the deploy.

- [ ] **Step 12: Run the Workers-compatibility gate for both tenants**

This step is required before any deploy and after any dependency change.

```bash
cd apps/api
bun run check:bundle:maow
bun run check:bundle:simple-trade
```

Expected for each: the bindings table, then `--dry-run: exiting now.` and exit code 0.

```text
Total Upload: <N> KiB / gzip: <M> KiB
Your Worker has access to the following bindings:
Binding                                  Resource
env.CACHE (<kv id>)                      KV Namespace
env.EVENT_QUEUE (hfm-events-maow)        Queue
env.HYPERDRIVE (<hyperdrive id>)         Hyperdrive Config
env.TENANT ("maow")                      Environment Variable
...
--dry-run: exiting now.
```

Failure modes this catches, and nothing else in the plan does:

- a `node:fs` or `pino` import that survived the logger rewrite, reported as a build error naming the module;
- a module the bundler cannot resolve;
- a bundle above the 64 MiB limit, reported as `Total Upload`;
- an unknown or misspelled config key, reported as `WARNING ... Unexpected fields found in top-level field: "..."`.

Treat any `Unexpected fields` warning as a failure, not a warning.
Verified behaviour on wrangler 4.136.2: a deliberately added `"bogus_key": true` produced exactly that warning, while the real config files produced none.

- [ ] **Step 13: Run one tenant locally**

```bash
cd apps/api
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://test:test@localhost:5433/hfm_test"
bun run dev:maow
```

`bun run dev:maow` expands to `wrangler dev -c wrangler.maow.jsonc --test-scheduled`.
Expected: `Ready on http://localhost:8787`, and a bindings list that matches the dry run.

The `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` variable is how local dev reaches a database; it overrides any `localConnectionString` in the config file.
Local dev talks to that database directly, with no pooling and no Hyperdrive cache.

- [ ] **Step 14: Fire the 5-minute cron locally**

With `bun run dev:maow` still running, in a second terminal:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*"
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*&format=json"
```

Expected: the first returns an empty 200; the second returns `{"outcome":"ok","noRetry":false}`.
The `wrangler dev` window prints the structured JSON log lines emitted by the scheduled handler.

Path note: the Cloudflare docs document `/cdn-cgi/local/scheduled`.
The `--test-scheduled` help text in wrangler 4.136.2 still says "by visiting /__scheduled in browser".
Use the documented `/cdn-cgi/local/scheduled` path; if a future Wrangler rejects it, the legacy `/__scheduled` path is the fallback, not the default.

- [ ] **Step 15: Confirm no daily cron is registered**

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+1+*+*+*&format=json"
```

Expected: `{"outcome":"ok","noRetry":false}`, and the `wrangler dev` window prints
`no job registered for schedule "0 1 * * *"`. No LINE push is attempted.
The daily report cron was removed on purpose in commit `96e6a0e`; `dispatchCron` must ignore
any schedule it does not know.

- [ ] **Step 16: Commit nothing, stop the dev server**

Press Ctrl-C in the `bun run dev:maow` window.
This step produces no repository change; it exists so the runbook in Task 10 starts from a known-good local run.

---

## Task 10: Cutover, verification and rollback runbook

The LINE webhook URL is the only switch.
One field in the LINE Developers Console decides whether a tenant's traffic goes to the VPS container or to the Worker.
That makes cutover one edit and rollback one edit, with no DNS TTL and no deploy in between.

**Files:**
- Create: `apps/api/staging/wrangler.maow-staging.jsonc`
- Modify: `apps/api/AGENTS.md:1-35` (the Bun runtime guidance) and append the new sections
- Modify: `AGENTS.md:17-38` (repo layout table and Commands block)
- Modify: `apps/api/.env.example:1-47` (full replacement)
- Modify: `docker-compose.yml:1-30` (delete the `bot` service, keep `postgres-test`)
- Delete: `apps/api/Dockerfile`, `apps/api/nginx.conf`, `apps/api/.dockerignore`, `apps/api/src/index.ts`

### Phase 1: staging on workers.dev

- [ ] **Step 1: Create the staging resources**

```bash
cd apps/api
bunx wrangler kv namespace create hfm-cache-staging
bunx wrangler queues create hfm-events-staging
bunx wrangler queues create hfm-events-staging-dlq
bunx wrangler hyperdrive create hfm-staging \
  --connection-string="$STAGING_DATABASE_URL" \
  --caching-disabled
```

`STAGING_DATABASE_URL` must point at a **separate** database, not at either production database.
Export it in the shell from the operator's password manager; never write it into a file in this repo.

Expected: the KV command prints a namespace id, each queue command prints `Created queue '...'`, and the Hyperdrive command prints a config id.

- [ ] **Step 2: Create `apps/api/staging/wrangler.maow-staging.jsonc`**

```jsonc
{
  // Staging spec for the maow tenant. It lives outside the wrangler.*.jsonc
  // glob on purpose, so tests/tenant-config.test.ts never sees a config with
  // workers_dev: true. Deploy with:
  //   bunx wrangler deploy -c staging/wrangler.maow-staging.jsonc
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "hfm-bot-maow-staging",
  "main": "../src/worker.ts",
  "compatibility_date": "2026-09-22",
  // Staging is reached on <name>.<account>.workers.dev, so no route is set
  // and workers_dev stays true. Production is the opposite of both.
  "workers_dev": true,
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "limits": { "cpu_ms": 300000 },
  "triggers": { "crons": ["*/5 * * * *"] },
  "vars": {
    "TENANT": "maow-staging",
    "HFM_API_BASE_URL": "https://api.hfaffiliates.com",
    "TARGET_WALLET": "REPLACE_WITH_MAOW_WALLET_ID",
    "DEPOSIT_THRESHOLD_USD": "200",
    "DEPOSIT_THRESHOLD_USC": "20000",
    "LINE_WHITELIST_ENABLED": "true",
    "LINE_WHITELIST_UIDS": "",
    "LINE_GROUP_WHITELIST_ENABLED": "true",
    "LINE_GROUP_WHITELIST_IDS": "",
    "LINE_NOTIFY_UIDS": "REPLACE_WITH_TESTER_LINE_UID",
    "LAST_TRADE_DEADLINE_MS": "8000",
    "FLEX_SUMMARY_VERSION": "flex-v1",
    "LOT_DISPLAY_MODE": "always",
    "LOG_LEVEL": "debug"
  },
  "secrets": {
    "required": [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET",
      "HFM_API_KEY",
      "INTERNAL_API_KEY"
    ]
  },
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<STAGING_HYPERDRIVE_ID>" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "<STAGING_KV_ID>" }],
  "queues": {
    "producers": [{ "binding": "EVENT_QUEUE", "queue": "hfm-events-staging" }],
    "consumers": [
      {
        "queue": "hfm-events-staging",
        // One LINE event per invocation: a batch runs sequentially, so a
        // bigger batch lets one slow lookup expire the next reply token (60s).
        "max_batch_size": 1,
        "max_batch_timeout": 0,
        // No retries: a retry can reuse a spent reply token and push a
        // duplicate answer. Failures go straight to the dead letter queue.
        "max_retries": 0,
        "dead_letter_queue": "hfm-events-staging-dlq"
      }
    ]
  }
}
```

Then replace, in that file only:

- `<STAGING_HYPERDRIVE_ID>` and `<STAGING_KV_ID>` with the ids from Step 1;
- `REPLACE_WITH_MAOW_WALLET_ID` with the same wallet id used in `wrangler.maow.jsonc`;
- `REPLACE_WITH_TESTER_LINE_UID` with the LINE UID of the person doing the smoke test.

- [ ] **Step 3: Create the staging schema**

```bash
cd apps/api
printf 'DATABASE_URL_MAOW_STAGING=%s\n' "$STAGING_DATABASE_URL" > .env.staging.admin
bun --env-file=.env.staging.admin run scripts/migrate-tenant.ts maow-staging
```

Expected: `[migrate] migrations applied to maow-staging`.

`.env.staging.admin` matches the `.env.*.admin` ignore pattern from Task 8 Step 21, so it cannot be committed.

- [ ] **Step 4: Upload the staging secrets from the LINE test channel**

Create a second LINE Messaging API channel for testing, or use the existing development channel.

```bash
cd apps/api
bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN -c staging/wrangler.maow-staging.jsonc
bunx wrangler secret put LINE_CHANNEL_SECRET -c staging/wrangler.maow-staging.jsonc
bunx wrangler secret put HFM_API_KEY -c staging/wrangler.maow-staging.jsonc
bunx wrangler secret put INTERNAL_API_KEY -c staging/wrangler.maow-staging.jsonc
```

Use the **test** channel's token and secret here, never the production tenant's.

- [ ] **Step 5: Dry run, then deploy staging**

```bash
cd apps/api
bunx wrangler deploy --dry-run --outdir bundled/staging -c staging/wrangler.maow-staging.jsonc
bunx wrangler deploy -c staging/wrangler.maow-staging.jsonc
```

Expected: the dry run exits 0 with no `Unexpected fields` warning, and the deploy prints the deployed URL.

```text
Deployed hfm-bot-maow-staging triggers (0.42 sec)
  https://hfm-bot-maow-staging.<account-subdomain>.workers.dev
  schedule: */5 * * * *
```

Record that URL as `$STAGING_URL` for the rest of this task.
Cron trigger changes can take up to 15 minutes to propagate.

- [ ] **Step 6: Point the LINE test channel at staging**

In the LINE Developers Console, open the test channel, then Messaging API, then Webhook settings.

1. Set Webhook URL to `https://hfm-bot-maow-staging.<account-subdomain>.workers.dev/webhook`.
2. Press **Verify**. Expected: `Success`.
3. Turn **Use webhook** on.
4. Turn **Auto-reply messages** and **Greeting messages** off.

### Phase 2: the smoke checklist

Run every item.
Each one has a command or an action and an expected result.

- [ ] **Step 7: Health endpoint**

```bash
curl -s "$STAGING_URL/internal/health?key=$INTERNAL_API_KEY" | head -c 200; echo
```

Expected, exactly:

```json
{"status":"healthy","checks":{"database":"ok","hfm_api":"ok"}}
```

`database: ok` proves the Hyperdrive binding, the connection string and the migrations all work.
`hfm_api: ok` proves the HFM secret reached the Worker through `process.env`.
The `200` itself proves `INTERNAL_API_KEY` reached `process.env`: the route compares against `process.env.INTERNAL_API_KEY`.
If every request instead fails with `process.env is not populated`, `assertProcessEnvPopulated()` from Task 1 caught a disabled `nodejs_compat_populate_process_env`; fix the config, do not remove the check.

- [ ] **Step 8: Health endpoint rejects a wrong key**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$STAGING_URL/internal/health?key=wrong"
```

Expected: `401`.

- [ ] **Step 9: Wallet ID lookup in a one-on-one chat**

From the tester's LINE app, in a one-on-one chat with the test channel's bot, send a real Wallet ID of that tenant, for example:

```text
98241376
```

Expected: a Trading Account Summary Flex card inside a few seconds, with the Volume row present because `LOT_DISPLAY_MODE=always`.

- [ ] **Step 10: Lot-prefixed lookup**

Send:

```text
lot 98241376
```

Expected: the same card, Volume row present.

- [ ] **Step 11: Group chat lookup**

Invite the test bot into a LINE group with a second account, then from that group send:

```text
98241376
```

Expected: the same Flex card, posted into the group.
This checks the `ChatContext` path that works without `event.source.userId`, which LINE omits for group members who have never used the iOS or Android app.

Then check that the join event stored the group name.
The label is written after the welcome reply, inside the queue consumer; if it were still fire-and-forget, the runtime could cancel it and this would stay `null`.

```bash
curl -s "$STAGING_URL/internal/line-groups?key=$INTERNAL_API_KEY"
```

Expected: the test group appears with `"label"` set to the group's display name, not `null`.

- [ ] **Step 12: Unparsed group message stays silent unless the bot is mentioned**

In the same group send `hello`.
Expected: no reply.

Then send a message that mentions the bot, for example `@<bot name> hello`.
Expected: the fallback reply.

- [ ] **Step 13: Report command is one-on-one only**

In the group, send `report`.
Expected: no report.

In a one-on-one chat, send `report`.
Expected: the daily report message.

- [ ] **Step 14: The flex version matches the tenant flag**

Staging runs `FLEX_SUMMARY_VERSION=flex-v1`, so the card shows the cumulative Volume layout and no Rank row.

Now prove the flag actually drives it, without redeploying production:

```bash
cd apps/api
bun run dev:maow
```

In the running dev session the config comes from `wrangler.maow.jsonc`, which is flex-v1.
Stop it, temporarily set `"FLEX_SUMMARY_VERSION": "flex-v2"` in `wrangler.maow.jsonc`, run `bun run dev:maow` again and repeat the lookup against `http://localhost:8787/webhook`.
Expected: the card now shows the This Month status, `Monthly Lots x / 2` and the Rank row.
Revert the file afterwards and confirm with `git diff --exit-code apps/api/wrangler.maow.jsonc`, which must print nothing.

- [ ] **Step 15: The 5-minute cron fires on the deployed Worker**

```bash
cd apps/api
bunx wrangler tail -c staging/wrangler.maow-staging.jsonc --format json
```

Wait for the next 5-minute boundary, up to 5 minutes.

Expected: a scheduled invocation appears with `"outcome":"ok"` and the handler's JSON log lines, each carrying `"tenant":"maow-staging"`.

If nothing appears after 20 minutes, check the Cron Events list in the dashboard.
New or renamed Workers can take up to 30 minutes before events show up there, and trigger changes take up to 15 minutes to propagate.

- [ ] **Step 16: A forced HFM-down alert**

Set the staging Worker's HFM base URL to a host that fails fast, run one cron, then set it back.

```bash
cd apps/api
# 1. break it
#    edit staging/wrangler.maow-staging.jsonc:
#      "HFM_API_BASE_URL": "https://api.invalid.hfaffiliates.test"
bunx wrangler deploy -c staging/wrangler.maow-staging.jsonc
```

Wait for the next 5-minute cron, or trigger it from the dashboard.

Expected: the tester's LINE account receives one "HFM down" alert, and `wrangler tail` shows the health check failing.
Wait for one more cron cycle.
Expected: **no** second alert, because the edge-detection state now lives in `job_state`, not in a module-level `let lastHealthy`.

```bash
# 2. fix it
#    restore "HFM_API_BASE_URL": "https://api.hfaffiliates.com"
bunx wrangler deploy -c staging/wrangler.maow-staging.jsonc
```

Expected on the next cron: one recovery alert, then silence.

- [ ] **Step 17: `wrangler tail` shows structured JSON logs with the tenant field**

```bash
cd apps/api
bunx wrangler tail -c staging/wrangler.maow-staging.jsonc --format json
```

Send one Wallet ID lookup from LINE while the tail runs.

Expected: each log line is a JSON object, and every object carries `"tenant":"maow-staging"` plus the `webhookEventId` of the event being handled.
A line that is a bare string instead of an object means a `console.log("text")` survived somewhere; fix it, because Workers Logs cannot index a string message.

### Phase 3: measure the two riskiest numbers

- [ ] **Step 18: Measure webhook ACK latency, hard limit 2s**

LINE's documented webhook timeout is 2 seconds; a slower response is recorded as `request_timeout` in the webhook error statistics.
Measure the deployed path, not local dev.

```bash
cd apps/api
BODY='{"destination":"U0000000000000000000000000000000","events":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINE_CHANNEL_SECRET" -binary | base64)
seq 1 10 | xargs -I{} curl -s -o /dev/null \
  -w 'status=%{http_code} total=%{time_total}\n' \
  -X POST "$STAGING_URL/webhook" \
  -H 'content-type: application/json' \
  -H "x-line-signature: $SIG" \
  --data "$BODY"
```

`LINE_CHANNEL_SECRET` must be exported in the shell from the operator's password manager for the signature to verify.
Never echo it and never paste it into a file.

Expected: ten lines, every one `status=200`, every `total` under `0.300`.
That is the empty-event path: signature verification and nothing else.

Now repeat with one real text event in the body, which makes the Worker enqueue one queue message:

```bash
cd apps/api
BODY='{"destination":"U0000000000000000000000000000000","events":[{"type":"message","mode":"active","timestamp":1758500000000,"webhookEventId":"01JSMOKE0000000000000000","source":{"type":"user","userId":"U0000000000000000000000000000000"},"replyToken":"00000000000000000000000000000000","message":{"id":"1","type":"text","text":"98241376"}}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINE_CHANNEL_SECRET" -binary | base64)
seq 1 10 | xargs -I{} curl -s -o /dev/null \
  -w 'status=%{http_code} total=%{time_total}\n' \
  -X POST "$STAGING_URL/webhook" \
  -H 'content-type: application/json' \
  -H "x-line-signature: $SIG" \
  --data "$BODY"
```

Expected: ten lines, every one `status=200`, every `total` under `1.000`.
The number to look for is the worst of the ten, not the average.

Pass: worst `total` under 1.000.
Investigate: any `total` between 1.000 and 2.000.
Fail, do not cut over: any `total` at or above 2.000, or any status other than 200.

The stale reply token is harmless here: the queue consumer's LINE reply call fails, which is expected for a synthetic token, and that failure is visible in `wrangler tail`.

- [ ] **Step 19: Measure cron CPU time, hard limit 30s**

The `*/5 * * * *` cron has an interval under one hour, so its CPU limit is **30 seconds**, not the 15 minutes the pricing page implies.
Wall time is 15 minutes and does not count network wait, so a slow HFM call is free; JSON parsing of a large HFM payload is not.

Where the number is:
Cloudflare dashboard, Workers and Pages, `hfm-bot-maow-staging`, then Logs.
Open a scheduled invocation and read the **CPU time** field of the invocation log.
Whether `wrangler tail --format json` also carries a CPU field is UNVERIFIED; the dashboard invocation log is the authoritative source.

Collect the CPU time of five consecutive `*/5 * * * *` invocations.

Pass: every 5-minute invocation under 15,000 ms, which is half the budget.
Investigate: any 5-minute invocation between 15,000 ms and 30,000 ms.
Fail, do not cut over: any 5-minute invocation at or above 30,000 ms, or an invocation whose outcome is `exceededCpu`.

- [ ] **Step 20: Record the measurements in the plan file**

Write the ten latency numbers and the five CPU numbers into `docs/plans/` next to this plan, in a file named `<today>-workers-cutover-measurements.md`.
Sign-off in Step 27 refers to these numbers.

### Phase 4: production cutover

- [ ] **Step 21: Deploy both production tenants**

```bash
cd apps/api
bun test
bun run typecheck
bun run check:bundle:maow
bun run check:bundle:simple-trade
bun run deploy:all
```

Expected: the suite passes, the typecheck is silent, both dry runs exit 0, and each deploy prints its Custom Domain and exactly one schedule, `*/5 * * * *`.

```text
Deployed hfm-bot-maow triggers (0.51 sec)
  maow-bot.hfm-automation.com (custom domain)
  schedule: */5 * * * *
```

At this point both Workers are live but receive no LINE traffic, because the LINE channels still point at the VPS.
Their crons are live, which is why the next step stops the VPS crons before any cron overlap can occur.

- [ ] **Step 22: Stop the VPS bot container, keep it intact**

One writer per database.
Both deployments run the same 5-minute health check against the same tables, so they must never run at the same time against the same tenant database.

On the VPS:

```bash
docker compose stop bot
docker compose ps
```

Expected: the `bot` service shows `exited`, and `postgres-test` is untouched.

Do not run `docker compose down`, do not delete the image, and do not delete the VPS `.env`.
The stopped container is the rollback target.

- [ ] **Step 23: Switch the maow LINE channel to the Worker**

In the LINE Developers Console, open the maow channel, then Messaging API, then Webhook settings.

1. Copy the current Webhook URL into the measurements file first. That string is the rollback value.
2. Set Webhook URL to `https://maow-bot.hfm-automation.com/webhook`.
3. Press **Verify**. Expected: `Success`.
4. Leave **Use webhook** on.

- [ ] **Step 24: Switch the simple-trade LINE channel to the Worker**

Same four actions on the simple-trade channel, with `https://simple-trade-bot.hfm-automation.com/webhook`.

- [ ] **Step 25: Watch both tails for 15 minutes**

```bash
cd apps/api
bun run tail:maow
```

In a second terminal:

```bash
cd apps/api
bun run tail:simple-trade
```

Expected within 15 minutes: real webhook invocations with `outcome: ok`, at least three `*/5 * * * *` scheduled invocations per tenant, and every log line carrying its own `tenant` value.
`hfm-bot-maow` must never log `"tenant":"simple-trade"`.
If it does, a secret or a var was uploaded with the wrong `-c` flag; stop and roll back.

- [ ] **Step 26: Repeat the smoke checklist against production**

Run Steps 7, 8, 9, 10, 11, 12 and 13 again, once per tenant, against the real channels.
The only expected difference: the simple-trade cards use the flex-v2 layout (This Month status, `Monthly Lots x / 2`, Rank row) and show Volume only for a `lot`-prefixed input, because that tenant runs `FLEX_SUMMARY_VERSION=flex-v2` and `LOT_DISPLAY_MODE=lot_prefix_only`.

- [ ] **Step 27: Sign-off**

Sign-off requires all of:

1. every smoke item in Phase 2 passing on both production tenants;
2. the worst webhook ACK latency under 1.000s and none at or above 2.000s;
3. every 5-minute cron CPU time under 15,000 ms;
4. no daily report pushed by either Worker (the cron was removed in commit 96e6a0e; only `bun run trigger:daily-client-report` sends it);
5. 24 hours with no unexplained entry in either dead letter queue.

Check the dead letter queues before signing off:

```bash
cd apps/api
bunx wrangler queues list
```

Expected: `hfm-events-maow-dlq` and `hfm-events-simple-trade-dlq` exist and are empty.

### Phase 5: rollback

- [ ] **Step 28: The rollback procedure, one page**

Trigger: any of these.

- LINE webhook error statistics show `request_timeout` after cutover.
- Replies stop arriving for either tenant.
- A cron invocation ends with `exceededCpu` or an unhandled exception repeats.
- Cards render with the wrong tenant's data.

Actions, in this order.

1. On the VPS: `docker compose start bot`, then `docker compose ps` and wait for `healthy`.
2. In the LINE Developers Console, set each affected channel's Webhook URL back to the VPS URL recorded in Step 23, and press **Verify** until it returns `Success`.
3. Confirm recovery by sending one Wallet ID lookup per affected tenant.
4. Only then investigate.

Rollback does not require a deploy, a DNS change or a code change.
The Workers stay deployed; they simply stop receiving webhooks.

Leave the crons in mind: after a rollback the Worker crons are still registered and would double-write.
So step 5 of a rollback is: `bunx wrangler deploy -c wrangler.maow.jsonc` with `"triggers": { "crons": [] }` temporarily set, or delete the Worker with `bunx wrangler delete -c wrangler.maow.jsonc` if the rollback is permanent.
Do not leave two cron owners on one database.

### Phase 6: documentation and dead files

- [ ] **Step 29: Replace `apps/api/.env.example`**

Replace the whole file with:

```text
# Local development and `bun test` only.
#
# Production values now live in two places, never in a .env file:
#   - wrangler `vars`   -> the 14 plaintext keys in wrangler.<tenant>.jsonc
#   - wrangler secrets  -> the 4 encrypted keys, uploaded with
#                          `bunx wrangler secret put <KEY> -c wrangler.<tenant>.jsonc`
#
# Local Worker runs read their secrets from .dev.vars.<tenant> instead of this
# file. This file still drives `bun test` and the operator scripts under
# scripts/, which run under Bun and read process.env.

# --- secrets (wrangler secret put, never a wrangler var) ---
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
HFM_API_KEY=
INTERNAL_API_KEY=

# --- database ---
# Used by drizzle-kit and the scripts/ operator tools only. The Worker gets its
# connection string from the HYPERDRIVE binding, not from this variable.
# Per tenant, put the real value in .env.<tenant>.admin (git-ignored) and run
# `bun run migrate:<tenant>`.
DATABASE_URL=postgresql://user:password@host:port/database
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test

# --- wrangler vars (production values live in wrangler.<tenant>.jsonc) ---
# TENANT is set by the wrangler config in production; locally it labels logs.
TENANT=maow
HFM_API_BASE_URL=https://api.hfaffiliates.com
TARGET_WALLET=
# Minimum balance for a client to pass the deposit condition (matchAll).
# USD accounts use DEPOSIT_THRESHOLD_USD (default 200). USC accounts report
# balances in cents, so set that one in cents: 20000 means 200.00 USC.
# Missing, invalid, or negative values fall back to the defaults.
DEPOSIT_THRESHOLD_USD=200
DEPOSIT_THRESHOLD_USC=20000
LINE_WHITELIST_ENABLED=true
LINE_WHITELIST_UIDS=
# Group chat access. The bot answers Wallet ID and Trading Account lookups
# from any member of a group it has been invited to.
# Empty list = every group is allowed (same rule as LINE_WHITELIST_UIDS).
# Fill it with comma separated group or room IDs to lock the bot down; read
# the IDs from GET /internal/line-groups?key=<INTERNAL_API_KEY>.
LINE_GROUP_WHITELIST_ENABLED=true
LINE_GROUP_WHITELIST_IDS=
LINE_NOTIFY_UIDS=Uabc123,Udef456
# Max ms the LINE reply path waits for the HFM /api/clients/ last-trade map
# before rendering the card without it. Default 8000.
LAST_TRADE_DEADLINE_MS=

# Trading Account Summary Flex card version.
# flex-v1 (default): current card, unchanged.
# flex-v2: replaces cumulative Volume with This Month status + Monthly Lots x / 2,
# and adds a Rank row. Any other value falls back to flex-v1 with a warning.
# maow runs flex-v1, simple-trade runs flex-v2.
FLEX_SUMMARY_VERSION=flex-v1

# When to show the Volume (lots) metric on the trading summary Flex card
# (flex-v1). "always" (default): every Wallet ID / Trading Account lookup
# shows Volume. "lot_prefix_only": only a "lot"-prefixed input such as
# "lot 98241376" shows Volume. Any other value falls back to "always".
LOT_DISPLAY_MODE=always

LOG_LEVEL=info
```

`PORT` is gone, because there is no listening process any more.
`TENANT` is new.
The comment block at the top is the part that matters: it tells the next engineer where a production value actually lives.

- [ ] **Step 30: Update `apps/api/AGENTS.md`**

The file currently opens with "Default to using Bun instead of Node.js" and a `Bun.serve()` section.
That guidance is still right for tests and scripts, and wrong for the deployed service.

Insert this section directly after the first heading block, before the `## APIs` section:

```markdown
## Runtime

This app is deployed as a Cloudflare Worker, one Worker per tenant.
There is no Bun server, no Docker image and no long-lived process.

- Entry point: `src/worker.ts` exporting `fetch`, `scheduled` and `queue`.
- Tenants: `maow` and `simple-trade`, one complete config file each, deployed with `-c`.
- Deploy: `bun run deploy:maow`, `bun run deploy:simple-trade`, or `bun run deploy:all`.
- Local run: `bun run dev:maow` (wrangler dev, `--test-scheduled` enabled).
- Live logs: `bun run tail:maow`.
- Secrets: `bunx wrangler secret put <KEY> -c wrangler.<tenant>.jsonc`. Never a wrangler var.
- Schema: `bun run migrate:<tenant>`. The old boot-time DDL is gone.
- Required gate before any deploy: `bun run check:bundle:maow` and
  `bun run check:bundle:simple-trade`, which are `wrangler deploy --dry-run`.
- `bun test` and `bun run typecheck` still run on Bun and still use a real
  PostgreSQL from `docker compose up -d postgres-test`.

The `Bun.serve()` guidance below applies to tests and to the operator scripts in
`scripts/` only. Never reintroduce it into `src/`.
```

Then append this section at the end of the same file.

```markdown
## Adding a tenant

1. Copy `wrangler.maow.jsonc` to `wrangler.<tenant>.jsonc`.
2. Change `name` to `hfm-bot-<tenant>`, the route `pattern` to the new hostname, and `TENANT` to `<tenant>`.
3. Set `TARGET_WALLET`, `FLEX_SUMMARY_VERSION`, `LOT_DISPLAY_MODE` and the whitelist vars to the new tenant's values.
   Leave every other `vars` key present, even when the value matches maow.
4. `bunx wrangler kv namespace create hfm-cache-<tenant>` and paste the id into `kv_namespaces`.
5. `bunx wrangler queues create hfm-events-<tenant>` and `bunx wrangler queues create hfm-events-<tenant>-dlq`, then set both queue names in `queues.producers` and `queues.consumers`.
6. `bunx wrangler hyperdrive create hfm-<tenant> --connection-string="$NEW_DATABASE_URL" --caching-disabled` and paste the id into `hyperdrive`.
7. Add `deploy:<tenant>`, `dev:<tenant>`, `tail:<tenant>`, `secrets:<tenant>`, `migrate:<tenant>` and `check:bundle:<tenant>` to `package.json`, and extend `deploy:all`.
8. Create `.dev.vars.<tenant>` and `.env.<tenant>.admin`; both are already git-ignored.
9. `bunx wrangler secret put` the 4 secrets with `-c wrangler.<tenant>.jsonc`.
10. `bun run migrate:<tenant>` to create the schema in the new database.
11. `bun test tests/tenant-config.test.ts tests/deploy-scripts.test.ts` - both guards must pass.
12. `bunx wrangler deploy --dry-run --outdir bundled/<tenant> -c wrangler.<tenant>.jsonc`.
13. Add the Custom Domain hostname in the Cloudflare zone, deploy, then point the new LINE channel's webhook URL at `https://<hostname>/webhook`.
```

- [ ] **Step 31: Update the repo root `AGENTS.md`**

At `AGENTS.md:17`, the layout table row for `apps/api` currently reads:

```markdown
| `apps/api` | Production LINE bot + Hono server: webhook routes, cron jobs, HFM/LINE services, Drizzle repositories. Tests in `apps/api/tests`. |
```

Replace it with:

```markdown
| `apps/api` | Production LINE bot on Cloudflare Workers, one Worker per tenant (`maow`, `simple-trade`): webhook producer, queue consumer, Cron Triggers, HFM/LINE services, Drizzle repositories over Hyperdrive. Tests in `apps/api/tests`. |
```

At `AGENTS.md:28-36`, the Commands block currently reads:

```bash
bun install                      # install deps (run inside each app)
bun run dev                      # dev server with watch
bun run start                    # production-style server
bun test                         # full test suite
bun test tests/webhook.test.ts   # one test file
bun test -t "wallet"             # tests whose name matches
bun run typecheck                # tsc --noEmit
```

Replace it with:

```bash
bun install                      # install deps (run inside each app)
bun run dev:maow                 # wrangler dev for one tenant, port 8787
bun test                         # full test suite
bun test tests/webhook.test.ts   # one test file
bun test -t "wallet"             # tests whose name matches
bun run typecheck                # tsc --noEmit
bun run check:bundle:maow        # wrangler deploy --dry-run, required before deploy
bun run deploy:maow              # deploy one tenant
bun run deploy:all               # deploy every tenant
bun run tail:maow                # live logs for one tenant
bun run migrate:maow             # apply drizzle/ migrations to that tenant database
```

In the Architecture Rules section, replace the cron line:

```markdown
- Cron jobs live in `src/jobs/` and are registered in `src/jobs/index.ts`; schedules are ICT (UTC+7).
```

with:

```markdown
- Cron jobs live in `src/jobs/` and are dispatched by `dispatchCron(cron)` in `src/jobs/index.ts`. Only the 5 minute health check is scheduled; the daily report is manual (`bun run trigger:daily-client-report`). Cloudflare Cron Triggers are **UTC only**, so any new schedule must be converted from ICT (UTC+7), and any "today" inside a job must be computed with `timeZone: "Asia/Bangkok"`.
```

- [ ] **Step 32: Find every reference to the files about to be deleted**

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.agents \
  -e 'Dockerfile' -e 'nginx.conf' -e 'dockerignore' -e 'src/index.ts' \
  . | grep -v '^./docs/plans/' | grep -v '^./docs/research/'
```

This was run while writing this plan.
Expected findings, and what to do with each:

| Reference | Verdict |
| --- | --- |
| `docker-compose.yml:2-30` service `bot`, `build: .` | **Must change.** Delete the `bot` service. Note it is already broken: `build: .` points at the repo root, and there is no Dockerfile at the repo root. |
| `docker-compose.yml:32-44` service `postgres-test` | **Keep.** `bun test` needs it, and both AGENTS.md files document `docker compose up -d postgres-test`. |
| `apps/api/package.json:7-8` `dev` and `start` running `src/index.ts` | Already deleted in Task 9 Step 4. |
| `apps/api/Dockerfile:22` `CMD ["bun", "run", "src/index.ts"]` | Deleted with the file itself. |
| `apps/hfm-report/Dockerfile`, `apps/hfm-report/docker-compose.yml` | **Leave alone.** Different app, still deployed with Docker. |
| `PRPs/line-hfm-bot.md:133-135,463,489-494` | **Leave alone.** Historical spec of the original build. |
| `INITIAL.md:283` | **Leave alone.** Historical spec. |
| `docs/plans/*.md`, `docs/research/*.md` | **Leave alone.** Dated records. |
| `.github/workflows` | Does not exist. There is no CI to update. |
| `apps/api/tests/**` | No test imports `src/index.ts`, so deleting it breaks no test. |

- [ ] **Step 33: Delete the `bot` service from `docker-compose.yml`**

Delete lines 2 to 30, the whole `bot:` service, and keep `postgres-test`.
The file becomes exactly:

```yaml
services:
  postgres-test:
    image: postgres:16-alpine
    container_name: hfm-postgres-test
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: hfm_test
    ports:
      - "127.0.0.1:5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
```

- [ ] **Step 34: Verify the test database still starts**

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
docker compose up -d postgres-test
docker compose ps
```

Expected: `hfm-postgres-test` is `running` and no `bot` service is listed.

- [ ] **Step 35: Delete the dead deployment files**

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
git rm apps/api/Dockerfile apps/api/nginx.conf apps/api/.dockerignore apps/api/src/index.ts
```

Expected: four `rm` lines.

Do this only after sign-off in Step 27.
Until then the VPS image must remain reproducible from this repository.

- [ ] **Step 36: Prove nothing still imports the deleted entry point**

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation/apps/api
grep -rn --exclude-dir=node_modules 'src/index' src tests scripts package.json
```

Expected: no output.

- [ ] **Step 37: Full suite and typecheck after the deletions**

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
docker compose up -d postgres-test
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
cd apps/api
bun test
bun run typecheck
bun run check:bundle:maow
bun run check:bundle:simple-trade
```

Expected: the suite passes, the typecheck is silent, both dry runs exit 0.

- [ ] **Step 38: Commit the cleanup**

```bash
cd /Users/jametirakarn/Desktop/Theerakarnm/HFM-Automation
git add -A apps/api/AGENTS.md AGENTS.md apps/api/.env.example docker-compose.yml apps/api/staging
git add -u
git commit -m "chore: remove docker deploy, document workers"
```

### Definition of done

- [ ] `apps/api/wrangler.maow.jsonc` and `apps/api/wrangler.simple-trade.jsonc` exist, each complete, each with all 14 `vars`, `hyperdrive`, `kv_namespaces`, `queues.producers`, `queues.consumers`, `triggers.crons`, `observability`, `limits`, `workers_dev: false` and one Custom Domain route.
- [ ] No secret value appears in any file in the repository. `bunx wrangler secret list -c wrangler.<tenant>.jsonc` shows exactly 4 names per tenant.
- [ ] `bun test tests/tenant-config.test.ts` passes: identical `vars` key sets, every contract key present and non-empty, unique `name` and route, identical binding names, `FLEX_SUMMARY_VERSION` in {flex-v1, flex-v2}, `workers_dev: false`, no unresolved placeholder in any `vars` value.
- [ ] `bun test tests/deploy-scripts.test.ts` passes: every tenant has `deploy:`, `dev:`, `tail:`, `secrets:`, `migrate:` and `check:bundle:`, each pointing at its own `-c` file, and `deploy:all` covers every tenant.
- [ ] `bun run deploy:maow` and `bun run deploy:simple-trade` both work and are the documented deploy commands.
- [ ] `bun run check:bundle:maow` and `bun run check:bundle:simple-trade` exit 0 with no `Unexpected fields` warning.
- [ ] `bun test` and `bun run typecheck` are green on a clean checkout.
- [ ] `maow` and `simple-trade` render different flex cards from the same build, proving the per-tenant `vars` reach `process.env`.
- [ ] Measured: worst webhook ACK latency under 1.000s, recorded in `docs/plans/<today>-workers-cutover-measurements.md`.
- [ ] Measured: every `*/5 * * * *` cron invocation under 15,000 ms CPU, recorded in the same file.
- [ ] Both LINE channels point at their tenant's Custom Domain, and the previous VPS URLs are written down as the rollback values.
- [ ] The VPS `bot` container is stopped, not deleted, until sign-off.
- [ ] `Dockerfile`, `nginx.conf`, `.dockerignore` and `src/index.ts` are deleted, the `bot` service is out of `docker-compose.yml`, and `docker compose up -d postgres-test` still works.
- [ ] `apps/api/AGENTS.md`, the root `AGENTS.md` and `apps/api/.env.example` describe Workers, the per-tenant deploy commands and the tenant checklist, with no stale Bun-server or Docker instructions.

---

## Appendix A: Reconciled decisions

Three sections of this plan were drafted in parallel. Where they disagreed, the decision is
recorded here and the task bodies have been brought in line with it.

### A.1 Database migrations use `generate` plus a migrate script, never `push`

An early draft of Task 9 proposed `bun --env-file=.env.maow.admin x drizzle-kit push`.
That is wrong for this repo for two reasons.

1. The repo rule in `AGENTS.md` is that migration SQL in `apps/api/drizzle/` is generated
   by `bunx drizzle-kit generate` and never hand-edited. `drizzle-kit push` skips the
   migration files entirely and diffs the schema straight against the live database.
2. With two tenant databases, `push` gives no record of what was applied where. A
   generated migration file is the only artifact that makes two tenants provably
   identical.

Tasks 4 and 9 both define the scripts the same way:

```json
"db:generate": "bunx drizzle-kit generate",
"migrate:maow": "bun --env-file=.env.maow.admin run scripts/migrate-tenant.ts maow",
"migrate:simple-trade": "bun --env-file=.env.simple-trade.admin run scripts/migrate-tenant.ts simple-trade"
```

`scripts/migrate-tenant.ts` is specified in Task 4. It reads only `DATABASE_URL_MAOW` or
`DATABASE_URL_SIMPLE_TRADE` (from the git-ignored `.env.<tenant>.admin` file, Task 9 Step 10)
and connects **directly** to the tenant Postgres, never through Hyperdrive, because Hyperdrive
caches reads for 60s and does not invalidate on write. `tests/deploy-scripts.test.ts` checks
that each `migrate:<tenant>` script targets its own tenant.

`db:push` is removed from `package.json`.

### A.2 `tail:<tenant>` is defined once

Task 3 and Task 9 both add `tail:maow` and `tail:simple-trade`. Task 9 owns the final
`scripts` block. When doing Task 3, add the two entries; when doing Task 9, keep the
Task 9 form (`--format pretty`) and do not duplicate them.

### A.3 Feature flags stay in `process.env`

Each flag keeps its one existing getter (`getFlexSummaryVersion()`, `getLotDisplayMode()`,
`getDepositThreshold()`, `isChatAllowed()` and the others) and that getter keeps reading
`process.env`. Cloudflare fills `process.env` from the tenant file's `vars` and secrets, and
each tenant is its own Worker. Do not add a second parser for a flag; Task 8 Step 24 checks it.

### A.4 The `drizzle/` directory must be un-ignored first

`apps/api/.gitignore:18-19` currently ignores `drizzle/`, and the directory does not
exist. Generated migrations would never be committed and would never reach a deploy.
Un-ignoring it is the first step of Task 4 and blocks every later migration step.

### A.5 Ordering constraint inside Task 4

Eight test files import `initDb` from `src/db/connection.ts`. The move of that DDL into
`tests/db-helpers.ts` as `applyTestSchema(db)` must land **before** the `connection.ts`
rewrite, or the suite goes red in the middle of the task.

---

## Appendix B: Risk register

| # | Risk | Likelihood | Blast radius | Mitigation | Owner task |
| --- | --- | --- | --- | --- | --- |
| 1 | Replies lost because work runs after the response | Certain without the fix | Every customer lookup | Cloudflare Queues; the route only enqueues | Task 2 |
| 2 | LINE records `request_timeout` because the ACK exceeds 2s | Medium | All events for that tenant | Measure ACK latency in the smoke checklist; the producer does no I/O except one `sendBatch` | Task 2, Task 10 |
| 3 | A tenant deploys with a missing `vars` key and the binding is `undefined` at runtime | High without a guard | Silent wrong behaviour, for example the wrong flex card | `tests/tenant-config.test.ts` asserts key parity across tenants; `secrets.required` fails the deploy | Task 8 |
| 4 | Hyperdrive serves a stale read after a write | Medium | Whitelist and state checks | Create every Hyperdrive config with `--caching-disabled` | Task 4 |
| 5 | Duplicate "HFM API down" alerts every 5 minutes | Certain without the fix | Operator trust | Move `lastHealthy` from module scope to the `job_state` table | Task 5 |
| 6 | Generated migrations never reach production | Certain without the fix | Missing tables | Un-ignore `drizzle/` | Task 4 |
| 7 | The 5 minute cron exceeds its 30s CPU limit | Low | Health alerts stop | Measure CPU time in Workers Logs during the smoke pass | Task 10 |
| 8 | Two tenants pointed at one database during the parallel run | Low | Data corruption | Stated rule in the cutover runbook: a tenant Worker and the VPS never share a database | Task 10 |
| 9 | Wrangler deploy drops a tenant's cron triggers | Low | Jobs stop silently | `triggers.crons` is declared in every tenant file; verify in the dashboard after deploy | Task 8, Task 10 |
| 10 | A reply token expires while its event waits behind a slow lookup in the same queue batch | Certain with batches > 1 | Late or missing answers, silence in groups | `max_batch_size: 1`, no `max_concurrency` cap; `tests/tenant-config.test.ts` enforces it | Task 8 |
| 11 | Queue redelivery sends a customer the same answer twice | Low | Duplicate messages, billed per member in a group | Claim each `webhookEventId` in `job_state` before replying; `max_retries: 0` | Task 5d, Task 8 |
| 12 | Work started without `await` in the consumer is cancelled after it returns | Certain without the fix | Group labels never stored | Every call in the dispatcher is awaited | Task 2 Step 3 |
| 13 | `process.env` stops being filled (compatibility flag changed) | Low | Open whitelist, empty LINE token | `assertProcessEnvPopulated()` fails every request loudly | Task 1, Task 6 |
| 14 | The removed daily report cron comes back | Low | Daily push to every recipient | Only `*/5 * * * *` in `CRON_JOBS` and every tenant file; both are tested | Task 6, Task 8 |

---

## Appendix C: Definition of done

- [ ] `bun test` passes with zero skipped tests.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run check:bundle:maow` and `bun run check:bundle:simple-trade` both succeed.
- [ ] `tests/worker-env.test.ts` passes, and each deployed Worker answers `/internal/health` (proof that `process.env` is filled).
- [ ] Each tenant Worker shows exactly one schedule, `*/5 * * * *`, and no daily report is pushed.
- [ ] Every queue consumer has `max_batch_size: 1`, `max_batch_timeout: 0`, `max_retries: 0` and a dead letter queue.
- [ ] `tests/tenant-config.test.ts` passes for every `wrangler.*.jsonc`.
- [ ] `src/index.ts`, `Dockerfile`, `nginx.conf`, `.dockerignore` are deleted, and the
      `bot` service is removed from the root `docker-compose.yml`.
- [ ] `bun run deploy:maow` and `bun run deploy:simple-trade` both succeed.
- [ ] Each tenant answers a real Wallet ID lookup in a one-on-one chat and in a group chat.
- [ ] `maow` renders the flex-v1 card and `simple-trade` renders the flex-v2 card.
- [ ] `wrangler tail` shows structured JSON log lines carrying the right `tenant` field.
- [ ] Measured webhook ACK latency is under 2 seconds.
- [ ] Measured cron CPU time is under 30 seconds for the 5 minute schedule.
- [ ] The 5 minute cron has fired and written the last-trade map to KV.
- [ ] After a bot joins a group, `/internal/line-groups` shows the group's name.
- [ ] `bun test` passes twice in a row (no event claim leaks between runs).
- [ ] A forced HFM failure alerts once and does not repeat on the next tick.
- [ ] `AGENTS.md` (root and `apps/api`) and `.env.example` describe Workers, not Docker.
- [ ] The VPS deployment is stopped only after a full business day of clean tenant logs.

---

## Appendix D: Revision 2 - changes from the plan review

The first draft was reviewed end to end against the real code. Each change below is already
applied in the task bodies.

| # | Problem found | Evidence | Change |
| --- | --- | --- | --- |
| 1 | The plan brought back a daily report cron that was removed on purpose | Commit `96e6a0e` "drop 5am cron job" | Only `*/5 * * * *` is scheduled (Task 6, Task 8); tests assert it |
| 2 | Queue batches of 10 run one by one, so a reply token can expire while it waits | `handleQueueBatch` loops sequentially; lookups take seconds; tokens last 60s | `max_batch_size: 1`, `max_batch_timeout: 0`, no `max_concurrency` (Task 8) |
| 3 | The "pure move" kept fire-and-forget calls, which a queue consumer can lose | `webhook.ts:285-291`, `:370`, `:503`, `:660` | All awaited (Task 2 Step 3); label check added to the smoke list (Task 10 Step 11) |
| 4 | Queue redelivery could send duplicate answers; the retry comment was wrong | Queues are at-least-once; a spent reply token makes `replyOrPush` push | Event claim in `job_state` (Task 5d); `max_retries: 0` |
| 5 | The suite was not green after Task 1 | Workers types were installed only in Task 6; the flex "warns once" test broke | Types installed in Task 1; the flex warning is untouched |
| 6 | Task 2 described a test helper that did not exist | 35 separate `app.fetch(` calls in 3 files | Wrap the one app factory per file with `withInlineQueue` |
| 7 | New upstream load was not stated, and one failing cron step skipped the next | `/api/clients/` now runs every 5 minutes per tenant | Load stated in `dispatchCron`; each step has its own `try` |
| 8 | Task 1 rewrote 39 `process.env` reads on a false premise | Cloudflare fills `process.env` per Worker (compatibility date >= 2025-04-01) | Reads stay; `assertProcessEnvPopulated()` guards the assumption |
| 9 | The consumer log field `queueLagMs` would break an exact-match log test | `tests/webhook-logging.test.ts` pins the field set with `toEqual` | Field moved to the consumer's own log line |
| 10 | Migration scripts disagreed between sections | `drizzle-kit push` vs a generated-migration script | One definition in Tasks 4 and 9, guarded by `tests/deploy-scripts.test.ts` |
