# 01 — Sending Flex Messages with the Messaging API

Source: https://developers.line.biz/en/docs/messaging-api/using-flex-messages/

This file is the envelope and shipping reference. It tells you exactly what JSON the Messaging API expects and what you can/can't put in it.

---

## What is a Flex Message?

A Flex Message is one of the message types in the LINE Messaging API. Unlike text/sticker/image messages, a Flex Message is a JSON-described layout — a tree of containers, blocks, and components — that LINE clients render natively into a bubble or a horizontally-scrollable carousel of bubbles.

Use Flex Messages when you need:
- Rich product cards, receipts, news previews, restaurant menus, profiles, or video promos.
- Multiple call-to-action buttons in one message.
- Tabular data (e.g. order line items).
- Brand-styled visual content with controlled layout.

## Envelope — what you send to the Messaging API

A single Flex Message object (the thing you put inside the `messages` array of a push/reply/multicast request) looks like this:

```json
{
  "type": "flex",
  "altText": "This is a Flex Message",
  "contents": {
    "type": "bubble",
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": "Hello, world" }
      ]
    }
  }
}
```

### Required keys

| Key | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | Must be the literal string `"flex"`. |
| `altText` | string | yes | Fallback text. Shown in notifications, chat list previews, and on clients that don't support Flex. Max **400 characters**. Plain text — newlines OK, no formatting. |
| `contents` | object | yes | A `bubble` or `carousel` container (see `02-elements.md`). |
| `quickReply` | object | no | Optional quick-reply buttons attached to the message. |
| `sender` | object | no | Optional override of the sender name/icon for this single message. |

### `altText` best practices

- Summarize the bubble's main message in one sentence. Example: "Your order #1234 is confirmed".
- Avoid clickbait — this is a notification, not a tweet.
- Don't put the call-to-action here ("Tap to open!") because the user can't tap notification text.

## How you send it — three endpoints

You wrap the Flex Message object in a `messages` array (max 5 messages per request) and POST to one of:

- **Reply** — `POST https://api.line.me/v2/bot/message/reply` (for webhook responses; uses a one-time `replyToken`).
- **Push** — `POST https://api.line.me/v2/bot/message/push` (server-initiated to a specific user; counts against monthly quota).
- **Multicast** — `POST https://api.line.me/v2/bot/message/multicast` (to a list of up to 500 user IDs).
- **Broadcast** — `POST https://api.line.me/v2/bot/message/broadcast` (to all friends of the bot).
- **Narrowcast** — `POST https://api.line.me/v2/bot/message/narrowcast` (to a filtered audience segment).

All of them take `Authorization: Bearer {channel access token}` and `Content-Type: application/json`.

### Reply request body

```json
{
  "replyToken": "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
  "messages": [
    {
      "type": "flex",
      "altText": "Hello",
      "contents": { "type": "bubble", "body": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "text": "hi" }] } }
    }
  ]
}
```

### Push request body

```json
{
  "to": "U4af4980629...",
  "messages": [
    {
      "type": "flex",
      "altText": "Hello",
      "contents": { ... }
    }
  ]
}
```

## Hard limits

| Limit | Value | Why it matters |
|---|---|---|
| Max Flex Messages per request | 5 | Same as any message type. |
| Max bubbles in a carousel | 12 | Beyond 12, the API rejects the message. |
| Max altText length | 400 characters | Truncated server-side if exceeded. |
| Max serialized JSON size of one Flex Message | **50 KB** | The whole `{ "type": "flex", ... }` object including altText. |
| Image URL length | 2000 characters | URL itself, not file size. |
| Image file format | JPEG or PNG | Animated PNG (APNG) allowed when `animated: true`. |
| Image dimensions | ≤ 1024×1024 px | Larger images are rejected or down-scaled. |
| Image file size | ≤ 10 MB (≤ 300 KB if animated) | Animated images > 300 KB do not animate. |
| Video URL protocol | HTTPS, TLS 1.2+ | HTTP is rejected. |
| Video file format | mp4 | Other formats not guaranteed. |
| Video file size | ≤ 200 MB | Per official guidance. |

## LINE client compatibility

Flex Messages render on LINE for iOS / Android / macOS / Windows version **8.11.0 or later**. Older clients show only the `altText`. Some advanced features have higher minimum versions:

- `bubble.size` values `nano`, `deca`, `hecto`, `kilo`: LINE 9.x+
- `text.adjustMode: "shrink-to-fit"`: LINE 11.13+
- `text.scaling`, `button.scaling`, `icon.scaling`: LINE 12.10+
- Video component in hero: LINE 12.6+
- Animated images (`image.animated`): LINE 11.4+

When in doubt, design for the lowest version you care about and rely on `altText` for everyone else.

## Sending from SDKs (sanity-check examples)

### Node.js (`@line/bot-sdk`)

```js
import { messagingApi } from '@line/bot-sdk';
const client = new messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });

await client.pushMessage({
  to: userId,
  messages: [{
    type: 'flex',
    altText: 'Order confirmed',
    contents: bubble,        // a JS object matching the spec
  }],
});
```

### Python (`line-bot-sdk`)

```python
from linebot.v3.messaging import MessagingApi, FlexMessage, FlexBubble, ApiClient, Configuration
config = Configuration(access_token=TOKEN)
with ApiClient(config) as api_client:
    api = MessagingApi(api_client)
    api.push_message_with_http_info(
        push_message_request={
            "to": user_id,
            "messages": [{
                "type": "flex",
                "altText": "Order confirmed",
                "contents": bubble,
            }],
        },
    )
```

### curl (raw HTTP)

```bash
curl -X POST https://api.line.me/v2/bot/message/push \
  -H "Authorization: Bearer $LINE_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json
```

Where `payload.json` is:

```json
{ "to": "U...", "messages": [ { "type": "flex", "altText": "...", "contents": { ... } } ] }
```

## Errors you'll hit and what they mean

| HTTP / message | Cause | Fix |
|---|---|---|
| `400 Invalid contents` | Required property missing or wrong type. | Run `scripts/validate.py` against your JSON. |
| `400 Image URL must use https` | `image.url` is `http://`. | Switch to HTTPS, ensure TLS 1.2+. |
| `400 The size of the message exceeds the maximum` | Serialized JSON > 50 KB. | Reduce nested boxes, drop unused styling, paginate via carousel. |
| `400 carousel must have at least one bubble` | Empty `contents` on carousel. | Provide 1–12 bubbles. |
| `400 invalid altText length` | altText > 400 chars or empty. | Truncate / set a value. |
| `429 Rate limit exceeded` | Too many requests. | Back off; check quota in console. |

## Tooling

- **Flex Message Simulator** — official drag-and-drop GUI at `developers.line.biz/flex-simulator/`. Build visually, then "View as JSON" to copy.
- **Showcase** — preset templates inside the simulator (receipt, restaurant, news, etc.). Good starting points; mirrored under `examples/` in this skill.
- **Validator scripts** — `scripts/validate.py` in this skill checks all the above limits and shape rules locally before you hit the API.
