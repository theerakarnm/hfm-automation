---
name: flex-message-builder
description: Build, validate, and ship LINE Messaging API Flex Messages. Use when the user asks to "create a flex message", "build a LINE bubble/carousel", "design a LINE rich card", "send a LINE flex JSON", "make a LINE menu/receipt/news card", "embed a video in a LINE message", or "validate a flex message JSON". Produces a Messaging-API-ready `{"type":"flex","altText":...,"contents":...}` payload following the official spec for containers (bubble, carousel), blocks (header, hero, body, footer), components (box, text, image, video, button, icon, separator, filler, span), and layout properties (flex, spacing, margin, padding, justifyContent, alignItems, offset, position).
license: MIT
---

# Flex Message Builder

Build production-ready **LINE Flex Messages** — the JSON payload format for rich, layout-driven cards sent through the LINE Messaging API. This skill encodes the official spec so output is guaranteed to be schema-correct, sendable, and renderable on LINE iOS/Android/desktop.

## When to use this skill

Trigger this skill whenever the user wants to:

- **Compose** a Flex Message from a description ("a restaurant card with a hero image, name, rating, and two buttons").
- **Convert** a design or wireframe into Flex JSON.
- **Validate / debug** an existing Flex JSON the user pastes in.
- **Add a video** hero block to a bubble.
- **Build a carousel** of bubbles for product lists, news feeds, menus, etc.
- **Wrap** the bubble/carousel into a sendable Messaging API push/reply payload.

Do NOT use this skill for: rich menus, LIFF apps, sticker messages, image carousels (that's the older `imagemap` / `template` message type — Flex is its own type).

## Mental model — the four-layer hierarchy

Every Flex Message obeys this nesting. Read it top-down:

1. **Message wrapper** — `{ "type": "flex", "altText": "...", "contents": <container> }`
2. **Container** — either a `bubble` (single card) or a `carousel` (up to 12 bubbles, swipe horizontally).
3. **Block** — a bubble has up to four blocks: `header`, `hero`, `body`, `footer`. Header/body/footer must be `box` components; hero may be `image`, `video`, or `box`.
4. **Component** — the leaves: `box`, `text`, `image`, `video`, `button`, `icon`, `separator`, `filler`, `span`. Boxes nest other components; everything else is a leaf.

A `box` is the only component that contains other components. Layout is decided by its `layout` property (`vertical`, `horizontal`, or `baseline`).

## Workflow

Follow these steps every time. Don't skip step 1 — getting the shape wrong is the #1 cause of "Invalid contents" errors from the API.

### Step 1 — Read the relevant reference files

Always load these BEFORE writing any JSON. They contain the exact property names, enum values, and constraints copied from the official LINE docs and the line-bot-sdk type definitions.

- **`references/01-sending-messages.md`** — Messaging API envelope, altText, push/reply/multicast endpoints, size & quota limits.
- **`references/02-elements.md`** — every component (`bubble`, `carousel`, `box`, `text`, `image`, `video`, `button`, `icon`, `separator`, `filler`, `span`) with full property table.
- **`references/03-layout.md`** — flex, spacing, margin, padding, position/offset, justifyContent, alignItems, baseline boxes, axis behavior.
- **`references/04-video-bubble.md`** — special rules for video hero blocks (bubble must be `size: "mega"`, hero must be `video` type, requires `altContent`, aspect-ratio matching).

For a quick request, glance at the table-of-contents at the top of each file and only read the relevant sections.

### Step 2 — Pick a starting template

The `examples/` directory has 8 vetted, copy-pasteable templates. Use the closest match as your skeleton instead of writing from a blank page:

| Use case | File |
|---|---|
| Plain text + button bubble | `examples/simple-bubble.json` |
| Multi-card horizontal swipe | `examples/carousel.json` |
| Itemized order / receipt | `examples/receipt.json` |
| Restaurant / cafe with hero | `examples/restaurant-menu.json` |
| News / blog article preview | `examples/news-article.json` |
| Product / shopping card with price | `examples/shopping-card.json` |
| Video bubble (hero video) | `examples/video-bubble.json` |
| Business card / contact | `examples/business-card.json` |

### Step 3 — Build

Modify the template. Key rules to keep in mind while editing:

- **Required keys never disappear.** `bubble` always has `"type": "bubble"`. A `box` always has `"type": "box"`, `"layout"`, and `"contents"`. A `video` always has `url`, `previewUrl`, and `altContent`. Don't drop these.
- **Sizes are tokens, not pixels for most things.** Use the keyword scale (`xxs`, `xs`, `sm`, `md`, `lg`, `xl`, `xxl`, `3xl`, `4xl`, `5xl`, `full`) for `size`, `spacing`, `margin`, `padding`. Pixels (`"10px"`) and percentages (`"50%"`) are accepted for some properties — see `03-layout.md`.
- **Colors are hex with alpha optional.** `"#RRGGBB"` or `"#RRGGBBAA"`.
- **Images are HTTPS only.** URL ≤ 2000 chars, JPEG/PNG, ≤ 1024×1024 px, ≤ 10 MB (≤ 300 KB if `animated: true`).
- **Box layouts.** `horizontal` lays children left-to-right; `vertical` top-to-bottom; `baseline` is horizontal but children align to a shared text baseline (use for icon+text rows). Only horizontal/baseline support `align`/`gravity` on text the way you'd expect.
- **Carousels max 12 bubbles.** All bubbles in a carousel should share `size` for clean rendering.
- **Total payload ≤ 50 KB** for one Flex message after JSON serialization.

### Step 4 — Validate

Before returning the JSON to the user, run `scripts/validate.py` against it:

```bash
python3 scripts/validate.py path/to/flex.json
```

The validator checks:

- Top-level shape (`type: "flex"`, `altText` present and ≤ 400 chars, `contents` is bubble/carousel).
- Required properties on every component (`box.layout`, `box.contents`, `image.url`, `video.url/previewUrl/altContent`, `button.action`, etc.).
- Enum values (`layout`, `weight`, `style`, `size` for bubbles, `aspectMode`, etc.).
- Carousel constraints (1–12 bubbles, all `type: "bubble"`).
- Video bubble constraints (bubble `size: "mega"`, hero is video, altContent present, aspect-ratio sanity).
- Action shape on buttons / images / boxes (every clickable thing has a valid `action`).
- Total serialized size ≤ 50 KB.

If validation fails, fix the JSON and re-run. Don't return invalid JSON to the user.

### Step 5 — Wrap and deliver

Wrap the container in the Messaging API envelope and offer the user a ready-to-send body. Two common envelopes:

**Push / reply / multicast** (what you hand to `client.replyMessage` / `pushMessage`):

```json
{
  "type": "flex",
  "altText": "Short fallback text shown in chat list and notifications",
  "contents": { /* bubble or carousel here */ }
}
```

**`/v2/bot/message/push` raw HTTP body**:

```json
{
  "to": "U4af4980629...",
  "messages": [
    {
      "type": "flex",
      "altText": "...",
      "contents": { /* ... */ }
    }
  ]
}
```

Always include `altText`. It is what shows in push notifications and in chat list previews — if a user has Flex disabled or is on an old client, this is the only thing they see.

## Quick reference cheat sheet

Token sizes (used by `size`, `spacing`, `margin`, `padding`, etc.):

```
none < xxs < xs < sm < md (default) < lg < xl < xxl < 3xl < 4xl < 5xl < full
```

Bubble sizes (`bubble.size`):

```
nano | micro | deca | hecto | kilo | mega (default) | giga
```

Note: `deca` and `hecto` are documented sizes that exist between `micro` and `kilo`; `mega` is the default and the only size allowed for video bubbles.

Box layouts (`box.layout`): `horizontal` · `vertical` · `baseline`.

Text weights: `regular` · `bold`. Text styles: `normal` · `italic`. Decorations: `none` · `underline` · `line-through`.

Button styles: `link` (default) · `primary` · `secondary`. Heights: `sm` · `md`.

Image `aspectMode`: `cover` (crop to fit) · `fit` (letterbox).

Action types: `postback`, `message`, `uri`, `datetimepicker`, `clipboard`, `richmenuswitch`, `camera`*, `cameraRoll`*, `location`* (* = quick-reply only, not in Flex).

## Common pitfalls — auto-correct these in the user's JSON

1. **`contents` missing on a box** → every box needs a `contents` array, even if empty (use a single `filler`).
2. **Top-level wrong** → user pastes just a bubble; wrap it in `{ "type": "flex", "altText": "...", "contents": ... }`.
3. **Image URL is HTTP** → must be HTTPS. Reject and ask user.
4. **Button without `action`** → buttons require `action`. Default to a `postback` with a clear `data` field.
5. **Video bubble missing constraints** → video bubble must have `size: "mega"`, hero must be `type: "video"` with `url`+`previewUrl`+`altContent`+`aspectRatio`. The `altContent` should be an `image` of the same aspect ratio as a fallback.
6. **Carousel size mismatch** → all bubbles in a carousel render best when they share `size`. Warn the user.
7. **`altText` too long** → max 400 chars. Truncate.

## Asking the user the right questions

When the user's request is vague ("make a LINE flex message for our promo"), ask once before building:

1. **Single card or carousel?** (one bubble vs. multiple swipeable bubbles)
2. **What blocks?** Hero image/video? Title + body? Footer with buttons?
3. **What should clicking do?** URL, postback to your bot, or just decorative?
4. **Brand colors / fonts / logo URL?** (or use neutral defaults)

Don't ask all at once — pick the 1–2 questions that block you.

## References (verbatim spec)

The four official LINE docs that ground this skill:

- Send Flex Messages: `references/01-sending-messages.md` (mirrors https://developers.line.biz/en/docs/messaging-api/using-flex-messages/)
- Flex Message elements: `references/02-elements.md` (mirrors https://developers.line.biz/en/docs/messaging-api/flex-message-elements/)
- Flex Message layout: `references/03-layout.md` (mirrors https://developers.line.biz/en/docs/messaging-api/flex-message-layout/)
- Flex Message with video: `references/04-video-bubble.md` (mirrors https://developers.line.biz/en/docs/messaging-api/create-flex-message-including-video/)

Schema is cross-checked against the official `@line/bot-sdk` TypeScript types so it stays accurate even when the docs lag behind a release.
