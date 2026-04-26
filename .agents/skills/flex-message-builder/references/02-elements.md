# 02 — Flex Message elements

Source: https://developers.line.biz/en/docs/messaging-api/flex-message-elements/

This file is the component dictionary. Every container, block, and component the API accepts is listed here with its full property table, enum values, and constraints. Property tables are cross-checked with the official `@line/bot-sdk` TypeScript types.

## Quick element index

**Containers** (top-level): `bubble`, `carousel`
**Blocks** (slots inside a bubble): `header`, `hero`, `body`, `footer`
**Components** (the leaves and the layout boxes): `box`, `text`, `image`, `video`, `button`, `icon`, `separator`, `filler`, `span`

---

## Hierarchy at a glance

```
FlexMessage
└── contents: FlexContainer
    ├── bubble
    │   ├── header?: box
    │   ├── hero?:   image | video | box
    │   ├── body?:   box
    │   └── footer?: box
    └── carousel
        └── contents: bubble[1..12]
```

A `box` contains other components in its `contents` array. Anything else is a leaf.

---

## Containers

### `bubble`

The single-card container.

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"bubble"` | yes | — | Literal. |
| `size` | enum | no | `mega` | One of `nano`, `micro`, `deca`, `hecto`, `kilo`, `mega`, `giga`. Sets the bubble width. Video bubbles **must** be `mega`. |
| `direction` | enum | no | `ltr` | `ltr` or `rtl`. Layout direction (RTL flips horizontal axes for Arabic/Hebrew). |
| `header` | box | no | — | Header block. Always a `box`. |
| `hero` | image \| video \| box | no | — | Hero block. Most common: a full-width `image`. Use `video` for video bubbles. |
| `body` | box | no | — | Body block. Always a `box`. |
| `footer` | box | no | — | Footer block. Always a `box`. |
| `styles` | FlexBubbleStyles | no | — | Per-block style overrides (background, separator). |
| `action` | Action | no | — | Tap-anywhere-on-bubble action. |

**FlexBubbleStyles** has optional `header`, `hero`, `body`, `footer`, each a `FlexBlockStyle`:

```jsonc
{
  "backgroundColor": "#RRGGBB[AA]",
  "separator": true,           // draw a separator line under this block
  "separatorColor": "#RRGGBB"  // color of that separator
}
```

### `carousel`

A swipeable horizontal collection of bubbles.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"carousel"` | yes | Literal. |
| `contents` | `FlexBubble[]` | yes | 1 to **12** bubbles. All bubbles render best at the same `size`. |

The carousel itself has no `header`/`hero`/`body`/`footer` — those live on each bubble.

---

## Blocks

A bubble has up to four blocks. Three of them (`header`, `body`, `footer`) are always a `box`. `hero` is special.

| Block | Allowed types |
|---|---|
| `header` | `box` |
| `hero` | `image`, `video`, `box` |
| `body` | `box` |
| `footer` | `box` |

You can omit any block. A bubble with only a `body` is valid.

---

## Components

Properties marked **layout** are documented in detail in `03-layout.md`.

### `box`

Container component. Holds other components and decides how they're arranged.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"box"` | yes | |
| `layout` | enum | yes | `horizontal` · `vertical` · `baseline`. |
| `contents` | `FlexComponent[]` | yes | The children. Can be empty `[]` but the key must exist. |
| `flex` | number | no | (layout) Share of main-axis space relative to siblings. |
| `spacing` | string | no | (layout) Space between children (token: `none`, `xs`–`xxl`, etc.). |
| `margin` | string | no | (layout) Space before this box. |
| `paddingAll` | string | no | (layout) All-sides padding. |
| `paddingTop` `paddingBottom` `paddingStart` `paddingEnd` | string | no | (layout) Per-side padding. |
| `width` `maxWidth` `height` `maxHeight` | string | no | (layout) Px or %. |
| `position` | enum | no | (layout) `relative` (default) or `absolute`. |
| `offsetTop` `offsetBottom` `offsetStart` `offsetEnd` | string | no | (layout) Used with `position`. |
| `backgroundColor` | string | no | Hex `#RRGGBB[AA]`. |
| `borderColor` | string | no | Hex. |
| `borderWidth` | string | no | `none`, `light`, `normal`, `medium`, `semi-bold`, `bold` or pixels (e.g. `"2px"`). |
| `cornerRadius` | string | no | Token (`none`, `xs`–`xxl`) or pixels. |
| `justifyContent` | enum | no | (layout) Main-axis distribution: `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly`. Requires all children's `flex: 0`. |
| `alignItems` | enum | no | (layout) Cross-axis alignment: `flex-start`, `center`, `flex-end`. |
| `background` | object | no | Linear gradient — see below. |
| `action` | Action | no | Tap action for the whole box. |

**`background` (linear gradient):**

```json
{
  "type": "linearGradient",
  "angle": "0deg",                     // 0–360
  "startColor": "#FF6B6B",
  "endColor": "#FFE66D",
  "centerColor": "#FFD166",            // optional
  "centerPosition": "50%"              // optional, where centerColor sits
}
```

**`baseline` layout** is special: children are aligned to a shared text baseline (use it for icon-then-text rows). Inside a baseline box, you cannot use `gravity` or `offsetBottom` on children. See `03-layout.md`.

---

### `text`

Renders a string. Most-used component.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"text"` | yes | |
| `text` | string | conditional | The string to display. Required unless you provide `contents` (an array of `span`s). |
| `contents` | `FlexSpan[]` | conditional | Use to mix styles within one text. If set, `text` is ignored. |
| `flex` | number | no | (layout) |
| `size` | string | no | Token (`xxs`–`5xl`) or pixels (e.g. `"24px"`). |
| `align` | enum | no | `start` · `end` · `center`. Horizontal alignment within the text's box. |
| `gravity` | enum | no | `top` · `center` · `bottom`. Vertical alignment within the text's box. |
| `color` | string | no | Hex. Default theme color if omitted. |
| `weight` | enum | no | `regular` · `bold`. |
| `style` | enum | no | `normal` · `italic`. |
| `decoration` | enum | no | `none` · `underline` · `line-through`. |
| `wrap` | bool | no | `true` to wrap long text. Default `false` (text gets ellipsized). |
| `lineSpacing` | string | no | Spacing between wrapped lines (px). |
| `maxLines` | int | no | Max lines when `wrap: true`. `0` = unlimited. |
| `adjustMode` | `"shrink-to-fit"` | no | Auto-shrink font to fit the box. LINE 11.13+. |
| `scaling` | bool | no | Honors user's font-size accessibility setting. LINE 12.10+. |
| `margin` | string | no | (layout) |
| `position` `offsetTop` `offsetBottom` `offsetStart` `offsetEnd` | | no | (layout) |
| `action` | Action | no | Tap action on the text. |

`size` keyword scale (smallest to largest): `xxs`, `xs`, `sm`, `md` (default), `lg`, `xl`, `xxl`, `3xl`, `4xl`, `5xl`.

---

### `span`

Used only inside `text.contents`. Lets you mix styles within one paragraph.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"span"` | yes | |
| `text` | string | yes | The substring. |
| `size` | string | no | Token or px. |
| `color` | string | no | Hex. |
| `weight` | enum | no | `regular` · `bold`. |
| `style` | enum | no | `normal` · `italic`. |
| `decoration` | enum | no | `none` · `underline` · `line-through`. |

Spans cannot be styled with `align`, `gravity`, or have actions — those live on the parent `text`.

Example:

```json
{
  "type": "text",
  "contents": [
    { "type": "span", "text": "Sale ", "weight": "bold" },
    { "type": "span", "text": "ends Sunday", "color": "#FF0000" }
  ]
}
```

---

### `image`

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"image"` | yes | |
| `url` | string | yes | HTTPS, ≤ 2000 chars, JPEG/PNG, ≤ 1024×1024 px, ≤ 10 MB (≤ 300 KB if `animated`). |
| `flex` | number | no | (layout) |
| `margin` | string | no | (layout) |
| `align` | enum | no | `start` · `end` · `center`. |
| `gravity` | enum | no | `top` · `center` · `bottom`. |
| `size` | string | no | Token (`xxs`–`5xl`, `full`) or px or %. Default `md`. |
| `aspectRatio` | string | no | `"{width}:{height}"` with each value 1–100000. Default `"1:1"`. Height ≤ 3 × width. |
| `aspectMode` | enum | no | `cover` (crop to fit) · `fit` (letterbox). Default `fit`. |
| `backgroundColor` | string | no | Color shown when `aspectMode: "fit"` letterboxes. |
| `animated` | bool | no | Set `true` to play APNG. Up to 10 per message. Default `false`. |
| `position` `offsetTop/Bottom/Start/End` | | no | (layout) |
| `action` | Action | no | Tap action. |

---

### `video`

Goes only in the `hero` block of a bubble. The bubble must be `size: "mega"`.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"video"` | yes | |
| `url` | string | yes | HTTPS mp4. |
| `previewUrl` | string | yes | HTTPS image shown before user taps play. JPEG/PNG. |
| `altContent` | FlexComponent | yes | Fallback shown on clients that don't support inline video. Typically an `image` of the same `aspectRatio`. |
| `aspectRatio` | string | no | `"{w}:{h}"`. Should match both the actual video and the `previewUrl`. |
| `action` | Action | no | Tap action on the video region (when not playing). |

See `04-video-bubble.md` for the full pattern.

---

### `button`

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"button"` | yes | |
| `action` | Action | yes | What happens on tap. Required — there's no decorative button. |
| `style` | enum | no | `link` (default, transparent) · `primary` (filled in `color`) · `secondary` (subtle gray). |
| `color` | string | no | Hex. For `link` it's the text color; for `primary`/`secondary` it's the fill. |
| `height` | enum | no | `sm` · `md` (default). |
| `flex` | number | no | (layout) |
| `gravity` | enum | no | (layout) `top` · `center` · `bottom`. |
| `margin` | string | no | (layout) |
| `position` `offsetTop/Bottom/Start/End` | | no | (layout) |
| `adjustMode` | `"shrink-to-fit"` | no | Shrink label to fit. |
| `scaling` | bool | no | Honor user font-size setting. |

**Action types** (the `action` object):

| Type | Required keys | Effect |
|---|---|---|
| `postback` | `data` | Sends a postback event to your webhook with `data`. Optional `displayText`/`text` shows the user's "message" in chat. |
| `message` | `text` | Sends a regular text message from the user. |
| `uri` | `uri` | Opens URL in in-app browser. `tel:` and `https:` supported. Optional `altUri.desktop` for desktop fallback. |
| `datetimepicker` | `data`, `mode` | Opens picker. `mode`: `date` · `time` · `datetime`. `initial`/`min`/`max` set bounds. |
| `clipboard` | `clipboardText` | Copies text to clipboard. |
| `richmenuswitch` | `richMenuAliasId`, `data` | Switch which rich menu is shown. |

Every action also accepts `label` (button label / accessibility text).

Example actions:

```json
{ "type": "postback", "label": "Buy", "data": "action=buy&id=123", "displayText": "Buy" }
{ "type": "message", "label": "Yes", "text": "Yes" }
{ "type": "uri", "label": "Open site", "uri": "https://example.com", "altUri": { "desktop": "https://example.com/desktop" } }
{ "type": "datetimepicker", "label": "Pick date", "data": "k=date", "mode": "date", "initial": "2026-01-01", "min": "2025-01-01", "max": "2027-12-31" }
```

---

### `icon`

A small inline image used only inside a `baseline` box (next to text). Behaves like a glyph.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"icon"` | yes | |
| `url` | string | yes | HTTPS image, same constraints as `image`. |
| `size` | string | no | Token or px. Default `md`. |
| `aspectRatio` | string | no | Default `"1:1"`. |
| `margin` | string | no | (layout) |
| `position` `offsetTop/Bottom/Start/End` | | no | (layout) |
| `scaling` | bool | no | Honors user font-size. |

Icon has no `flex`, no `align`/`gravity`, and no `action`. If you need those, use `image` in a regular box.

---

### `separator`

A horizontal (in vertical box) or vertical (in horizontal box) divider line.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"separator"` | yes | |
| `margin` | string | no | (layout) |
| `color` | string | no | Hex. Defaults to a subtle gray. |

The line direction depends on the parent box's `layout`: vertical box → horizontal line, horizontal box → vertical line.

---

### `filler` (deprecated but still works)

An empty stretchy gap. Modern alternative: use `box` `spacing`/`justifyContent` or set a sibling's `flex`.

| Property | Type | Required | Description |
|---|---|---|---|
| `type` | `"filler"` | yes | |
| `flex` | number | no | (layout) |

---

## Token sizes — used by `size`, `spacing`, `margin`, `padding`, `cornerRadius`

Smallest to largest:

```
none, xxs, xs, sm, md (default), lg, xl, xxl, 3xl, 4xl, 5xl
```

`full` (means 100%) is also accepted for `size` on `image` and for `width` on a few components. Pixels (`"4px"`) and percentages (`"50%"`) are accepted for `width`, `height`, `maxWidth`, `maxHeight`, `cornerRadius`, `paddingAll/Top/Bottom/Start/End`, `offsetTop/Bottom/Start/End`, and `borderWidth`.

---

## Worked example — putting it together

A horizontal row showing rating stars + text, made with a baseline box of icons and a text:

```json
{
  "type": "box",
  "layout": "baseline",
  "margin": "md",
  "contents": [
    { "type": "icon", "url": "https://cdn.example.com/star.png", "size": "sm" },
    { "type": "icon", "url": "https://cdn.example.com/star.png", "size": "sm" },
    { "type": "icon", "url": "https://cdn.example.com/star.png", "size": "sm" },
    { "type": "icon", "url": "https://cdn.example.com/star.png", "size": "sm" },
    { "type": "icon", "url": "https://cdn.example.com/star_gray.png", "size": "sm" },
    { "type": "text", "text": "4.0", "size": "sm", "color": "#999999", "margin": "md", "flex": 0 }
  ]
}
```

This works because `baseline` aligns the icon glyphs and text to the same baseline, like `<span>` content in HTML.
