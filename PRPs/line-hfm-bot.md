# PRP: LINE OA Bot — HFM Trading Account Lookup

## Goal

Build a production-ready LINE Official Account webhook bot using **Bun + Hono** that accepts a Wallet ID in a 1:1 chat, queries the HFAffiliates Performance API, and replies with a styled Flex Message card showing 9 trading account metrics. Deploy via Docker + Nginx on DigitalOcean.

## Why

- Customer support automation: users can self-serve account performance data 24/7
- Reduces manual inquiry load on HFM support team
- LINE is the primary support channel in Thailand (target market)

## What

**User-visible behavior:**
1. User sends `WL-98241376` (or any wallet ID) in LINE 1:1 chat
2. Bot immediately returns HTTP 200 to LINE (required or LINE retries)
3. Bot calls HFAffiliates API in the background
4. Bot pushes a green Flex Message card with 9 fields, or a Thai-language error message if the query fails

**Success Criteria:**
- [ ] `POST /webhook` validates `x-line-signature` and rejects invalid requests with 400
- [ ] Non-message events (follow, unfollow, postback) silently return 200
- [ ] Valid wallet ID → Flex Message card with all 9 fields pushed to user's LINE
- [ ] Invalid/not-found wallet ID → Thai error message pushed
- [ ] HFM API 5xx → Thai error message pushed
- [ ] HFM API timeout (>10s) → Thai error message pushed
- [ ] `bun test` passes all tests
- [ ] TypeScript compiles with no errors (`bunx tsc --noEmit`)
- [ ] Docker container starts and responds to requests

---

## All Needed Context

### Documentation & References

```yaml
- url: https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
  why: >
    HMAC-SHA256 signature verification procedure. Critical: use raw body bytes,
    never modify the string before hashing. UTF-8 encoding required. Compare against
    x-line-signature header (base64-encoded digest).

- url: https://developers.line.biz/en/reference/messaging-api/#send-push-message
  why: >
    Push message endpoint: POST https://api.line.me/v2/bot/message/push
    Headers: Authorization: Bearer {token}, Content-Type: application/json
    Body: { "to": "{userId}", "messages": [{ message object }] }

- url: https://developers.line.biz/en/docs/messaging-api/flex-message-elements/
  why: >
    Flex Message component types: bubble container, box (horizontal/vertical),
    text, separator. Bubble has header/body/footer blocks. "size": "kilo" for bubble.

- url: https://developers.line.biz/en/docs/messaging-api/flex-message-layout/
  why: >
    Box layout properties: padding, spacing, cornerRadius, backgroundColor.
    Child alignment: align (start/end/center), gravity (top/center/bottom).
    flex property for proportional sizing within horizontal boxes.

- url: https://developers.line.biz/en/docs/messaging-api/receiving-messages/
  why: >
    Webhook event object structure. events[].type === "message",
    events[].message.type === "text", events[].source.userId for push target.
    Recommend async processing — return 200 immediately.

- url: https://hono.dev/docs/getting-started/bun
  why: >
    Hono on Bun: export default { port, fetch: app.fetch }.
    Use app.route() for modular routers. c.req.text() for raw body.

- url: https://api.hfaffiliates.com/docs
  why: >
    ⚠️ MUST CHECK BEFORE CODING. Confirm exact query param name for wallet ID,
    exact response JSON field names, and whether "not found" returns 404 or
    200+empty. All field names in hfm.types.ts are ASSUMED and may be wrong.
```

### ⚠️ Pre-Implementation Gate: Verify HFM API Fields

**Before writing `hfm.service.ts` or `hfm.types.ts`, open the live Swagger:**
`https://api.hfaffiliates.com/docs#/performance%20reports%20(new)/get_overall_performance_api_performance_overall_performance_get`

Confirm and record:
1. Query parameter name (assumed: `wallet_id` — may differ)
2. Exact response field names for all 9 fields
3. Whether "wallet not found" returns `404` or `200` with empty/null data
4. Data types (number vs string for balance, equity, volume, trades)

Update `hfm.types.ts` to match confirmed fields before any other service code.

### Current Codebase Tree

```
HFM-Automation/
├── CLAUDE.md
├── INITIAL.md
├── package.json          # { "name": "hfm-automation", "module": "index.ts" }
├── bun.lock
└── node_modules/
    ├── @types/bun/       # bun types installed
    └── @types/node/      # node types installed
```

### Desired Codebase Tree

```
HFM-Automation/
├── src/
│   ├── index.ts                        # Hono app entry + Bun server export
│   ├── routes/
│   │   └── webhook.ts                  # POST / handler (mounts at /webhook)
│   ├── services/
│   │   ├── hfm.service.ts              # HFAffiliates API client (fetch + AbortController)
│   │   └── line.service.ts             # LINE Push Message API client
│   ├── builders/
│   │   └── flex-message.builder.ts     # Builds typed FlexMessage JSON from HFMPerformanceData
│   ├── types/
│   │   ├── hfm.types.ts                # HFM API response types (VERIFY against Swagger)
│   │   └── line.types.ts               # LINE webhook payload types
│   └── utils/
│       └── signature.ts                # verifyLineSignature() using node:crypto HMAC-SHA256
├── tests/
│   ├── signature.test.ts
│   ├── flex-message.builder.test.ts
│   ├── hfm.service.test.ts
│   └── webhook.test.ts
├── examples/
│   ├── flex-message.json               # Complete sample Flex Message bubble
│   ├── webhook-payload.json            # Sample LINE webhook POST body
│   └── hfm-response.json              # Sample HFAffiliates API response
├── Dockerfile
├── docker-compose.yml
├── nginx.conf
├── .env.example
├── tsconfig.json
└── package.json
```

### Known Gotchas

```typescript
// CRITICAL: Body stream in Hono — read raw text ONCE, then JSON.parse manually
// c.req.json() consumes the stream; calling c.req.text() after it returns empty string
// Pattern to follow in webhook.ts:
const rawBody = await c.req.text();          // ✅ read once
const sig = c.req.header("x-line-signature") ?? "";
if (!verifyLineSignature(rawBody, sig, secret)) return c.text("Unauthorized", 400);
const body = JSON.parse(rawBody) as WebhookBody; // ✅ parse manually

// CRITICAL: timingSafeEqual in node:crypto throws if buffer lengths differ
// Wrap in try/catch — mismatched lengths mean invalid signature anyway
try {
  return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
} catch {
  return false;
}

// CRITICAL: Flex Message sent via Push must wrap the bubble in a flex envelope
// type: "flex", altText: required, contents: the bubble object
// WRONG: pushing the raw bubble object as the message
// RIGHT:
const flexMsg = {
  type: "flex",
  altText: `Trading Summary — ${walletId}`,
  contents: buildBubble(data),   // the bubble
};

// CRITICAL: Return HTTP 200 BEFORE awaiting the HFM API call
// LINE's webhook will retry if response takes >5s — fire and forget
app.post("/webhook", async (c) => {
  // ... validate signature, parse body ...
  for (const event of events) {
    if (isTextMessage(event)) {
      processEvent(event).catch(console.error); // fire-and-forget
    }
  }
  return c.text("OK", 200); // immediate 200
});

// CRITICAL: HFM API "not found" behavior is unconfirmed
// May be 404 OR 200 + empty array/object — handle BOTH patterns
// Treat empty data.wallet_id as "not found"

// CRITICAL: Bun exports for server entry
// export default app won't bind to PORT env var
// Must use explicit object export:
export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};

// CRITICAL: bun.lock exists — use --frozen-lockfile in Docker build
// RUN bun install --frozen-lockfile

// GOTCHA: Flex Message "size": "kilo" on bubble
// "mega" is too wide on mobile, omitting size defaults too narrow
// Always set { "type": "bubble", "size": "kilo", ... }
```

---

## Implementation Blueprint

### Data Models

```typescript
// src/types/hfm.types.ts  — FIELD NAMES ARE ASSUMED, VERIFY AGAINST SWAGGER
export interface HFMPerformanceData {
  wallet_id: string;
  trading_account_id: string;
  registration_status: "verified" | "pending" | string;
  trades: number;
  volume: number;
  account_type: string;
  balance: number;
  account_currency: string;
  equity: number;
}

export type HFMApiResult =
  | { ok: true; data: HFMPerformanceData }
  | { ok: false; reason: "not_found" | "server_error" | "timeout" };
```

```typescript
// src/types/line.types.ts
export interface WebhookBody {
  destination: string;
  events: WebhookEvent[];
}

export interface WebhookEvent {
  type: string;
  mode: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  replyToken?: string;
  message?: {
    type: string;
    id: string;
    text?: string;
  };
}

export interface TextMessageEvent extends WebhookEvent {
  type: "message";
  message: { type: "text"; id: string; text: string };
  source: { type: "user"; userId: string };
}
```

### Number Formatting Utility

```typescript
// Inside flex-message.builder.ts
const fmtCurrency = (n: number, currency: string): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
// → "$12,450.80"

const fmtVolume = (n: number): string => `${n.toFixed(2)} lots`;
// → "3.42 lots"
```

### Flex Message Bubble JSON Structure

The `buildTradingCard(data: HFMPerformanceData)` function returns this shape:

```json
{
  "type": "bubble",
  "size": "kilo",
  "styles": {
    "header": { "backgroundColor": "#1DB954" },
    "footer": { "backgroundColor": "#F5F5F5" }
  },
  "header": {
    "type": "box",
    "layout": "vertical",
    "contents": [
      { "type": "text", "text": "📊 Trading Account Summary", "color": "#FFFFFF", "weight": "bold", "size": "md" },
      { "type": "text", "text": "Forex Customer Support", "color": "#E8F5E9", "size": "sm" }
    ]
  },
  "body": {
    "type": "box",
    "layout": "vertical",
    "spacing": "md",
    "paddingAll": "16px",
    "contents": [
      /* ROW 1: wallet ID | trading account ID */
      {
        "type": "box", "layout": "horizontal", "spacing": "sm",
        "contents": [
          { "type": "box", "layout": "vertical", "flex": 1, "contents": [
            { "type": "text", "text": "🪪 Wallet ID", "size": "xs", "color": "#9E9E9E" },
            { "type": "text", "text": "{{wallet_id}}", "size": "sm", "weight": "bold", "color": "#1A1A1A" }
          ]},
          { "type": "box", "layout": "vertical", "flex": 1, "contents": [
            { "type": "text", "text": "📋 Account ID", "size": "xs", "color": "#9E9E9E" },
            { "type": "text", "text": "{{trading_account_id}}", "size": "sm", "weight": "bold", "color": "#1A1A1A" }
          ]}
        ]
      },
      /* ROW 2: registration status badge */
      {
        "type": "box", "layout": "horizontal", "alignItems": "center",
        "contents": [
          { "type": "text", "text": "🛡 Registration", "size": "sm", "color": "#9E9E9E", "flex": 3 },
          { "type": "text", "text": "✓ Verified", "size": "sm", "color": "#1DB954", "weight": "bold",
            "align": "end", "flex": 2 }
          /* OR for pending: { "type": "text", "text": "Pending", "color": "#9E9E9E", ... } */
        ]
      },
      { "type": "separator" },
      /* ROW 3: trades | volume | type — 3-column grid with light green bg */
      {
        "type": "box", "layout": "horizontal", "spacing": "sm",
        "contents": [
          { "type": "box", "layout": "vertical", "flex": 1, "backgroundColor": "#E8F5E9",
            "cornerRadius": "8px", "paddingAll": "10px",
            "contents": [
              { "type": "text", "text": "Trades", "size": "xs", "color": "#9E9E9E", "align": "center" },
              { "type": "text", "text": "{{trades}}", "size": "md", "weight": "bold", "color": "#1A1A1A", "align": "center" }
            ]},
          { "type": "box", "layout": "vertical", "flex": 1, "backgroundColor": "#E8F5E9",
            "cornerRadius": "8px", "paddingAll": "10px",
            "contents": [
              { "type": "text", "text": "Volume", "size": "xs", "color": "#9E9E9E", "align": "center" },
              { "type": "text", "text": "{{volume}}", "size": "md", "weight": "bold", "color": "#1A1A1A", "align": "center" }
            ]},
          { "type": "box", "layout": "vertical", "flex": 1, "backgroundColor": "#E8F5E9",
            "cornerRadius": "8px", "paddingAll": "10px",
            "contents": [
              { "type": "text", "text": "Type", "size": "xs", "color": "#9E9E9E", "align": "center" },
              { "type": "text", "text": "{{account_type}}", "size": "md", "weight": "bold", "color": "#1A1A1A", "align": "center" }
            ]}
        ]
      },
      /* ROW 4: balance | equity — 2-card row */
      {
        "type": "box", "layout": "horizontal", "spacing": "sm",
        "contents": [
          { "type": "box", "layout": "vertical", "flex": 1, "backgroundColor": "#E8F5E9",
            "cornerRadius": "8px", "paddingAll": "10px",
            "contents": [
              { "type": "text", "text": "Balance", "size": "xs", "color": "#9E9E9E" },
              { "type": "text", "text": "{{balance}}", "size": "md", "weight": "bold", "color": "#1A1A1A" }
            ]},
          { "type": "box", "layout": "vertical", "flex": 1, "backgroundColor": "#E8F5E9",
            "cornerRadius": "8px", "paddingAll": "10px",
            "contents": [
              { "type": "text", "text": "Equity", "size": "xs", "color": "#9E9E9E" },
              { "type": "text", "text": "{{equity}}", "size": "md", "weight": "bold", "color": "#1A1A1A" }
            ]}
        ]
      },
      /* ROW 5: account currency */
      {
        "type": "box", "layout": "horizontal", "alignItems": "center",
        "contents": [
          { "type": "text", "text": "💵 Acc. Currency", "size": "sm", "color": "#9E9E9E", "flex": 3 },
          { "type": "text", "text": "{{account_currency}}", "size": "sm", "weight": "bold",
            "color": "#1A1A1A", "align": "end", "flex": 2 }
        ]
      }
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "paddingAll": "12px",
    "contents": [
      { "type": "text", "text": "🎧 For assistance, please contact support.",
        "size": "xs", "color": "#9E9E9E", "align": "center", "wrap": true }
    ]
  }
}
```

---

## Task List (Ordered)

```yaml
Task 0 — PRE-IMPLEMENTATION GATE:
  ACTION: Open https://api.hfaffiliates.com/docs in browser
  CONFIRM:
    - Query parameter name (likely "wallet_id" but verify)
    - Response field names for all 9 fields
    - "not found" behavior: 404 status OR 200+empty
  NOTE: Do NOT proceed to Task 2 until field names are confirmed.

Task 1 — Project Setup:
  RUN: bun add hono
  CREATE: tsconfig.json
    - target: "ESNext", module: "ESNext", moduleResolution: "bundler"
    - strict: true
  CREATE: .env.example with 5 vars
  CREATE: examples/webhook-payload.json
  CREATE: examples/hfm-response.json (update with confirmed fields from Task 0)

Task 2 — Types (update after Task 0 field confirmation):
  CREATE: src/types/hfm.types.ts
    - HFMPerformanceData interface (confirmed field names)
    - HFMApiResult discriminated union
  CREATE: src/types/line.types.ts
    - WebhookBody, WebhookEvent, TextMessageEvent interfaces
    - isTextMessageEvent(e: WebhookEvent): e is TextMessageEvent type guard

Task 3 — Signature Utility:
  CREATE: src/utils/signature.ts
    - import { createHmac, timingSafeEqual } from "node:crypto"
    - verifyLineSignature(rawBody: string, signature: string, secret: string): boolean
    - HMAC-SHA256 → base64 digest → timingSafeEqual (try/catch on length mismatch)

Task 4 — HFM Service:
  CREATE: src/services/hfm.service.ts
    - fetchPerformance(walletId: string): Promise<HFMApiResult>
    - AbortController with 10_000ms timeout (clearTimeout in finally)
    - Authorization: Bearer header from HFM_API_KEY env var
    - Handle: 404 → not_found, 5xx → server_error, AbortError → timeout
    - Handle 200+empty case (if API returns empty for not-found)

Task 5 — LINE Service:
  CREATE: src/services/line.service.ts
    - pushMessage(userId: string, message: object): Promise<void>
    - POST https://api.line.me/v2/bot/message/push
    - Authorization: Bearer LINE_CHANNEL_ACCESS_TOKEN
    - pushText(userId: string, text: string): Promise<void>
    - pushFlex(userId: string, altText: string, contents: object): Promise<void>

Task 6 — Flex Message Builder:
  CREATE: src/builders/flex-message.builder.ts
    - buildTradingCard(data: HFMPerformanceData): object
    - Use Intl.NumberFormat for balance + equity (fmtCurrency helper)
    - Use fmtVolume for volume (number + " lots")
    - Registration badge: "verified" → { text: "✓ Verified", color: "#1DB954" }
                          else    → { text: "Pending",    color: "#9E9E9E" }
    - Return complete bubble object (NOT the flex envelope — line.service wraps it)
  CREATE: examples/flex-message.json
    - Call buildTradingCard with mock data, JSON.stringify the result

Task 7 — Webhook Route:
  CREATE: src/routes/webhook.ts
    - new Hono(), webhook.post("/", handler)
    - Pattern: read raw text → verify sig → 200 → fire-and-forget processEvent()
    - processEvent(event): resolve walletId from event.message.text.trim()
      → fetchPerformance(walletId)
      → on success: pushFlex with buildTradingCard result
      → on not_found: pushText with Thai error (404 message)
      → on server_error: pushText with Thai error (5xx message)
      → on timeout: pushText with Thai error (timeout message)
    - Guard: if event.source.userId undefined, log and return (can't push)

Task 8 — Entry Point:
  CREATE: src/index.ts
    - import hono, mount webhook router at /webhook
    - export default { port: Number(process.env.PORT) || 3000, fetch: app.fetch }

Task 9 — Tests:
  CREATE: tests/signature.test.ts
    - test valid HMAC matches
    - test invalid signature returns false
    - test length-mismatch returns false (not throws)
  CREATE: tests/flex-message.builder.test.ts
    - test all 9 fields populated in output JSON
    - test "verified" status shows green color
    - test "pending" status shows grey color
    - test currency formatting ($12,450.80)
    - test volume formatting (3.42 lots)
  CREATE: tests/hfm.service.test.ts
    - test successful response returns { ok: true, data }
    - test 404 response returns { ok: false, reason: "not_found" }
    - test 500 response returns { ok: false, reason: "server_error" }
    - mock fetch using globalThis.fetch override in test scope
  CREATE: tests/webhook.test.ts
    - test invalid signature returns 400
    - test non-message event returns 200 with no push
    - test valid text message event returns 200 immediately

Task 10 — Docker + Deployment:
  CREATE: Dockerfile
    - FROM oven/bun:1
    - WORKDIR /app, COPY, RUN bun install --frozen-lockfile
    - EXPOSE ${PORT:-3000}
    - CMD ["bun", "run", "src/index.ts"]
  CREATE: docker-compose.yml
    - services.bot: build: ., restart: always, env_file: .env
    - ports: "3000:3000"
  CREATE: nginx.conf
    - proxy_pass http://localhost:3000
    - SSL termination (Let's Encrypt certs path)
    - proxy_set_header X-Real-IP, Host, Upgrade
```

---

## Per-Task Pseudocode

### Task 3 — Signature Utility

```typescript
// src/utils/signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string
): boolean {
  const digest = createHmac("sha256", channelSecret)
    .update(rawBody)          // raw UTF-8 string — never modify before this
    .digest("base64");
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;             // catches length mismatch (different buffer sizes)
  }
}
```

### Task 4 — HFM Service

```typescript
// src/services/hfm.service.ts
export async function fetchPerformance(walletId: string): Promise<HFMApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = `${process.env.HFM_API_BASE_URL}/api/performance/overall_performance?wallet_id=${encodeURIComponent(walletId)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.HFM_API_KEY}` },
    });

    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status >= 500)  return { ok: false, reason: "server_error" };

    const data = await res.json() as HFMPerformanceData;
    // Handle 200+empty: if wallet_id field is falsy, treat as not_found
    if (!data?.wallet_id)   return { ok: false, reason: "not_found" };

    return { ok: true, data };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}
```

### Task 5 — LINE Service

```typescript
// src/services/line.service.ts
const LINE_API = "https://api.line.me/v2/bot/message/push";

async function pushMessage(userId: string, message: object): Promise<void> {
  const res = await fetch(LINE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [message] }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LINE push failed ${res.status}: ${err}`);
  }
}

export const pushText = (userId: string, text: string) =>
  pushMessage(userId, { type: "text", text });

export const pushFlex = (userId: string, altText: string, contents: object) =>
  pushMessage(userId, { type: "flex", altText, contents });
```

### Task 7 — Webhook Route (critical flow)

```typescript
// src/routes/webhook.ts
import { Hono } from "hono";
import { verifyLineSignature } from "../utils/signature";
import { fetchPerformance } from "../services/hfm.service";
import { pushText, pushFlex } from "../services/line.service";
import { buildTradingCard } from "../builders/flex-message.builder";
import type { WebhookBody, WebhookEvent } from "../types/line.types";

const webhook = new Hono();

webhook.post("/", async (c) => {
  const rawBody = await c.req.text();          // read ONCE before any parsing
  const sig = c.req.header("x-line-signature") ?? "";

  if (!verifyLineSignature(rawBody, sig, process.env.LINE_CHANNEL_SECRET!)) {
    return c.text("Unauthorized", 400);
  }

  const body = JSON.parse(rawBody) as WebhookBody;

  for (const event of body.events ?? []) {
    if (isTextMessage(event)) {
      processTextEvent(event).catch(console.error); // fire-and-forget
    }
  }

  return c.text("OK", 200); // immediate response to LINE
});

async function processTextEvent(event: TextMessageEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return; // group/room events without userId can't be pushed

  const walletId = event.message.text.trim();
  const result = await fetchPerformance(walletId);

  if (result.ok) {
    const bubble = buildTradingCard(result.data);
    await pushFlex(userId, `Trading Summary — ${walletId}`, bubble);
    return;
  }

  const errMsg =
    result.reason === "not_found"
      ? `❌ ไม่พบข้อมูล Wallet ID ${walletId} ในระบบ\nกรุณาตรวจสอบ Wallet ID และลองใหม่อีกครั้ง`
      : result.reason === "timeout"
      ? "⚠️ การเชื่อมต่อหมดเวลา\nกรุณาลองใหม่อีกครั้ง"
      : "⚠️ ระบบ HFM API ขัดข้องชั่วคราว\nกรุณาลองใหม่ในอีกสักครู่ หรือติดต่อ Support";

  await pushText(userId, errMsg);
}

export default webhook;
```

### Task 8 — Entry Point

```typescript
// src/index.ts
import { Hono } from "hono";
import webhook from "./routes/webhook";

const app = new Hono();
app.route("/webhook", webhook);

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
```

---

## Integration Points

```yaml
ENV VARS (all required — bot crashes if any missing):
  LINE_CHANNEL_ACCESS_TOKEN: push API auth
  LINE_CHANNEL_SECRET: HMAC key for signature verification
  HFM_API_KEY: bearer token for HFAffiliates API
  HFM_API_BASE_URL: https://api.hfaffiliates.com (no trailing slash)
  PORT: 3000 (Docker respects this)

ROUTES:
  POST /webhook — main entry point registered by LINE Developers Console

DOCKER DEPLOYMENT:
  - Build: docker build -t hfm-bot .
  - Run:   docker-compose up -d
  - Nginx proxies HTTPS → http://localhost:3000
  - LINE Developers Console webhook URL: https://your-domain.com/webhook
  - Must be HTTPS — LINE rejects plain HTTP webhooks
```

---

## Validation Loop

### Level 1: Type Check

```bash
# After all files created:
bunx tsc --noEmit

# Expected: 0 errors. Fix all type errors before proceeding.
```

### Level 2: Unit Tests

```bash
bun test

# Expected: all tests pass. Never skip a failing test — fix the code.
```

### Level 3: Signature Smoke Test

```bash
# Compute a valid signature for a test body
BODY='{"destination":"U123","events":[]}'
SECRET="your_test_channel_secret"
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | openssl base64)

# Start server
bun run src/index.ts &

# Test with valid signature → expect 200
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
# Expected: 200

# Test with invalid signature → expect 400
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: invalidsig" \
  -d "$BODY"
# Expected: 400
```

### Level 4: Docker Build Validation

```bash
docker build -t hfm-bot .
# Expected: build succeeds, no errors

docker run --rm -p 3000:3000 --env-file .env hfm-bot &
curl -s http://localhost:3000/webhook
# Expected: anything but a connection refused (404/405 is fine — route exists)
```

### Level 5: End-to-End (requires real credentials)

```bash
# Use LINE's webhook test tool in LINE Developers Console:
# Channel settings → Messaging API → Webhook URL → Verify
# Expected: "Success" — LINE confirms 200 response
```

---

## Final Validation Checklist

- [ ] `bunx tsc --noEmit` — zero errors
- [ ] `bun test` — all tests pass
- [ ] Signature rejects invalid requests with 400
- [ ] Non-message events return 200 (no push sent)
- [ ] HFM field names verified against live Swagger before coding
- [ ] `altText` set on every flex push (LINE rejects without it)
- [ ] Bubble `"size": "kilo"` set
- [ ] Balance/Equity use `Intl.NumberFormat` with currency symbol
- [ ] Volume shows `X.XX lots` suffix
- [ ] Thai error messages exact per spec (copy-paste from INITIAL.md)
- [ ] `AbortController` timeout 10s with `clearTimeout` in finally
- [ ] `docker build` succeeds, container starts
- [ ] `restart: always` in docker-compose.yml
- [ ] `.env.example` lists all 5 required variables
- [ ] LINE Developers Console webhook URL updated to HTTPS endpoint

---

## Example Files to Create

### examples/webhook-payload.json

```json
{
  "destination": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "events": [
    {
      "type": "message",
      "message": { "type": "text", "id": "123456789", "text": "WL-98241376" },
      "source": { "type": "user", "userId": "Uabc123def456ghi789" },
      "replyToken": "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
      "timestamp": 1716000000000,
      "mode": "active"
    }
  ]
}
```

### examples/hfm-response.json

```json
{
  "wallet_id": "WL-98241376",
  "trading_account_id": "TA-78451293",
  "registration_status": "verified",
  "trades": 24,
  "volume": 3.42,
  "account_type": "Standard",
  "balance": 12450.80,
  "account_currency": "USD",
  "equity": 12998.35
}
```

⚠️ Update field names above after confirming against live Swagger.

---

## Anti-Patterns to Avoid

- ❌ Never call `c.req.json()` — always `c.req.text()` + `JSON.parse()`
- ❌ Never `await processTextEvent()` inside the webhook handler — it must be fire-and-forget
- ❌ Never push the raw bubble object — always wrap in `{ type: "flex", altText, contents }`
- ❌ Never omit `altText` on flex messages — LINE API returns 400
- ❌ Never hardcode tokens in source code — always read from `process.env.*`
- ❌ Never assume HFM field names — verify against live Swagger first
- ❌ Never skip `timingSafeEqual` try/catch — it throws on different-length buffers
- ❌ Never use `express` or `node:http` — use Hono + Bun.serve via export default

---

## PRP Confidence Score: **9/10**

**Why 9:** All core patterns are fully specified with working pseudocode, critical gotchas documented with solutions, exact API endpoints/headers confirmed from live docs. The one point deducted is the unconfirmed HFM API field names — the implementer must verify these from the live Swagger before Task 2; if the names differ from assumptions, the types and service will need adjustment. Everything else should be implementable in one pass.
