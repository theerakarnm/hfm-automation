## FEATURE:

Build a LINE Official Account (OA) bot using **Bun + Hono** that allows users to query their HFM trading account performance by sending their Wallet ID as a plain text message in a 1:1 chat.

**Core flow:**
1. User sends a Wallet ID (e.g. `WL-98241376`) as a free-text message in LINE 1:1 chat
2. Webhook server receives the LINE event, immediately returns HTTP 200 to LINE
3. Server calls the HFAffiliates Performance API (`GET /api/performance/overall_performance?wallet_id={id}`) with `Authorization: Bearer {API_KEY}` header
4. On success → build and send a LINE Flex Message card (see design below) via Push Message API using the user's LINE `userId`
5. On failure → send a plain text error message via Push Message API

**Flex Message card fields (9 total):**
- Wallet ID
- Trading Account ID
- Trading Account Registration (show as "✓ Verified" green badge or "Pending" grey badge)
- Trades (number)
- Volume (number + "lots" suffix)
- Type (account type string)
- Balance (formatted as `$12,450.80`)
- Acc. Currency (e.g. USD)
- Equity (formatted as `$12,998.35`)

**Flex Message visual layout (top → bottom):**
```
[HEADER]   📊 "Trading Account Summary" / "Forex Customer Support"
[ROW 1]    🪪 Wallet ID (left) | 📋 Trading Account ID (right)
[ROW 2]    🛡 Trading Account Registration  |  ✓ Verified badge
[ROW 3]    3-column grid: Trades | Volume | Type
[ROW 4]    2-card row: Balance (left) | Equity (right)
[ROW 5]    💵 Acc. Currency
[FOOTER]   🎧 "For assistance, please contact support."
```

Color theme: HFM green (`#1DB954`), light green bg cards (`#E8F5E9`), white bubble, dark text.

**Error messages (sent via Push, in Thai):**
- Wallet not found (404 / empty): `"❌ ไม่พบข้อมูล Wallet ID {input} ในระบบ\nกรุณาตรวจสอบ Wallet ID และลองใหม่อีกครั้ง"`
- HFM API 5xx: `"⚠️ ระบบ HFM API ขัดข้องชั่วคราว\nกรุณาลองใหม่ในอีกสักครู่ หรือติดต่อ Support"`
- Timeout: `"⚠️ การเชื่อมต่อหมดเวลา\nกรุณาลองใหม่อีกครั้ง"`

**Project structure:**
```
src/
├── index.ts                        # Hono entry point
├── routes/webhook.ts               # POST /webhook
├── services/
│   ├── hfm.service.ts              # HFAffiliates API client
│   └── line.service.ts             # LINE Push/Reply client
├── builders/flex-message.builder.ts
├── types/
│   ├── hfm.types.ts
│   └── line.types.ts
└── utils/signature.ts              # LINE webhook HMAC-SHA256 validator
```

**Environment variables required:**
```env
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
HFM_API_KEY=
HFM_API_BASE_URL=https://api.hfaffiliates.com
PORT=3000
```

---

## EXAMPLES:

No `examples/` folder exists yet. The following should be created as reference files:

**`examples/flex-message.json`**
A complete, valid LINE Flex Message JSON for the trading card. Use the LINE Flex Message Simulator (https://developers.line.biz/flex-simulator/) to author and validate it. The JSON must use `"type": "bubble"` with `"size": "kilo"` and contain all 9 data fields as placeholder strings (e.g. `"{{wallet_id}}"`).

**`examples/webhook-payload.json`**
A sample LINE webhook POST body for a text message event:
```json
{
  "destination": "Uxxxxxxxx",
  "events": [
    {
      "type": "message",
      "message": { "type": "text", "id": "123", "text": "WL-98241376" },
      "source": { "type": "user", "userId": "Uabc123" },
      "replyToken": "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
      "timestamp": 1716000000000,
      "mode": "active"
    }
  ]
}
```

**`examples/hfm-response.json`**
A mock successful HFAffiliates API response:
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
> ⚠️ Confirm all field names against the live Swagger at https://api.hfaffiliates.com/docs before coding. These are assumed names.

---

## DOCUMENTATION:

- **LINE Messaging API — Webhook events:** https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- **LINE Messaging API — Push Message:** https://developers.line.biz/en/docs/messaging-api/sending-messages/#sending-push-messages
- **LINE Flex Message reference:** https://developers.line.biz/en/docs/messaging-api/flex-message-elements/
- **LINE Flex Message Simulator:** https://developers.line.biz/flex-simulator/
- **LINE signature validation:** https://developers.line.biz/en/docs/messaging-api/receiving-messages/#verifying-signatures
- **HFAffiliates API — Overall Performance endpoint:** https://api.hfaffiliates.com/docs#/performance%20reports%20(new)/get_overall_performance_api_performance_overall_performance_get
- **Hono docs (Bun runtime):** https://hono.dev/docs/getting-started/bun
- **Hono middleware — HMAC/crypto:** https://hono.dev/docs/helpers/crypto (or use Bun's built-in `crypto`)

---

## OTHER CONSIDERATIONS:

**1. Reply Token vs Push Message — use Push**
Do NOT use LINE's `replyToken` to send the Flex Message. The reply token expires in 30 seconds and is single-use. Because the HFM API call is async and can take up to 10 seconds, the safe pattern is:
- Return `HTTP 200` to LINE immediately (required, or LINE will retry the webhook)
- Call HFM API in the background
- Send the result via **Push Message API** using `event.source.userId`

**2. LINE Signature Validation is mandatory**
Every incoming POST to `/webhook` must validate the `x-line-signature` header using HMAC-SHA256 with the Channel Secret. Reject with `400` if invalid. Without this, anyone can POST fake events to your endpoint.
```typescript
const hash = createHmac("SHA256", LINE_CHANNEL_SECRET)
  .update(rawBody) // must be the raw string body, NOT parsed JSON
  .digest("base64");
if (hash !== req.header("x-line-signature")) return c.text("Unauthorized", 400);
```
Hono's `c.req.text()` must be called before `c.req.json()` — reading the body twice causes issues. Read raw text once, then `JSON.parse()` manually.

**3. Ignore non-message events silently**
LINE sends many event types: `follow`, `unfollow`, `join`, `postback`, etc. Always check `event.type === "message"` and `event.message.type === "text"` before processing. Return `HTTP 200` for all other event types without doing anything.

**4. HFM API field names are unconfirmed**
The field names in `hfm.types.ts` (e.g. `wallet_id`, `trading_account_id`, `registration_status`) are assumed. Before writing the service layer, open the live Swagger at `https://api.hfaffiliates.com/docs` and confirm:
- Exact query parameter name for wallet ID
- Exact response JSON field names
- Whether "not found" returns `404` status or `200` with an empty array/object

**5. Number formatting**
Balance and Equity must be formatted with:
- Currency symbol prefix (`$`)
- Thousand separators (`,`)
- Exactly 2 decimal places
Use `Intl.NumberFormat`:
```typescript
const fmt = (n: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
// → "$12,450.80"
```
Volume should display with " lots" suffix: `"3.42 lots"`.

**6. Flex Message `altText` is required**
The `altText` field is shown in the LINE chat list preview and on devices that don't support Flex Messages. Set it to something meaningful:
```json
{ "altText": "Trading Summary — WL-98241376" }
```
If omitted, LINE will reject the Push request with a validation error.

**7. Bubble size**
Use `"size": "kilo"` for the bubble to match the full-width card design in the mockup. Do not use `"mega"` (too wide for some devices) or omit size (defaults too narrow).

**8. HFM API timeout handling**
Set an explicit `AbortController` timeout on the fetch call (do not rely on Bun's default). 10 seconds is the max budget:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
try {
  const res = await fetch(url, { signal: controller.signal, ... });
} catch (e) {
  if (e.name === "AbortError") { /* send timeout error message */ }
} finally {
  clearTimeout(timeout);
}
```

**9. Docker deployment**
The service will be deployed on DigitalOcean with Docker + Nginx. Ensure:
- `PORT` env var is respected (don't hardcode 3000)
- Nginx proxies to the container and terminates SSL
- `restart: always` in `docker-compose.yml` so the bot survives Droplet reboots
- The `/webhook` endpoint must be publicly accessible over HTTPS — LINE will not deliver to `http://` or self-signed certs