# 03 — Flex Message layout

Source: https://developers.line.biz/en/docs/messaging-api/flex-message-layout/

This file is the layout engine reference. Flex Message layout borrows directly from CSS flexbox: a parent box has a main axis (set by `layout`) and a cross axis perpendicular to it; children are arranged along the main axis and aligned along the cross axis.

## Mental model — main axis vs. cross axis

| Box `layout` | Main axis | Cross axis | What `justifyContent` does | What `alignItems` does |
|---|---|---|---|---|
| `horizontal` | left → right | top ↔ bottom | distributes children left-to-right | aligns children top/center/bottom |
| `vertical` | top → bottom | left ↔ right | distributes children top-to-bottom | aligns children start/center/end horizontally |
| `baseline` | left → right | (text baseline) | n/a (children sit on baseline) | n/a (use text baseline) |

`baseline` is "horizontal but children align to a shared text baseline" — used for icon-then-text rows where the icon's vertical center should match the text's baseline.

## Sizing children — the `flex` property

Every component (except `bubble`/`carousel`/`span`/`icon`/`separator`) accepts `flex`. It controls how the parent box distributes the **main-axis** space among children.

- `flex: 0` → the child takes only its intrinsic content size. Doesn't grow.
- `flex: N` (positive integer) → the child gets a share of the leftover main-axis space proportional to N relative to siblings.
- Default `flex` value:
  - **In a `horizontal` box**: components default to `flex: 1` (they grow to fill).
  - **In a `vertical` box**: components default to `flex: 0` (they take intrinsic size).
  - **In a `baseline` box**: same as horizontal-ish, but with baseline alignment.

Common patterns:

```json
// "label : value" row where label is fixed-width and value fills the rest
{
  "type": "box",
  "layout": "baseline",
  "contents": [
    { "type": "text", "text": "Total", "flex": 0, "color": "#888" },
    { "type": "text", "text": "$42.00", "flex": 0, "weight": "bold", "align": "end" }
  ]
}
```

```json
// 30/70 split: left column 3 units, right column 7 units
{
  "type": "box",
  "layout": "horizontal",
  "contents": [
    { "type": "box", "layout": "vertical", "flex": 3, "contents": [...] },
    { "type": "box", "layout": "vertical", "flex": 7, "contents": [...] }
  ]
}
```

## Spacing between children — `spacing`

`spacing` on a parent box adds uniform gap between adjacent children along the main axis.

```json
{
  "type": "box",
  "layout": "vertical",
  "spacing": "md",   // each child gets `md` of margin before it (except the first)
  "contents": [...]
}
```

Token values: `none`, `xs`, `sm`, `md`, `lg`, `xl`, `xxl`. Px also accepted (`"8px"`).

## Per-child gap — `margin`

`margin` on a child overrides the parent's `spacing` for that one slot.

> **Margin precedence:** A child's `margin` wins over the parent's `spacing`. If `margin` is set on the **first** child of a box, it adds space *before* that child (i.e. between the parent's edge and the child). For all other children, `margin` is the gap before that child along the main axis.

## Padding — inside the box's border

`paddingAll`, `paddingTop`, `paddingBottom`, `paddingStart`, `paddingEnd` add space inside the box's border, around its children.

`Start` / `End` are direction-aware: in `direction: ltr` they map to left/right; in `direction: rtl` they swap. Use them instead of "left/right" so RTL languages render correctly.

Accepted values: tokens (`none`, `xs`–`xxl`), pixels (`"12px"`), percentages of parent width (`"5%"`).

```json
{
  "type": "box",
  "layout": "vertical",
  "paddingAll": "lg",
  "paddingBottom": "xl",   // overrides paddingAll for the bottom only
  "contents": [...]
}
```

## Cross-axis alignment — `alignItems` (parent) and `gravity` (child)

`alignItems` on the parent box positions children along the cross axis:

- `flex-start` — top (in horizontal) / start (in vertical)
- `center` — middle / center
- `flex-end` — bottom / end

For more granular per-child control, `gravity` on a `text`, `image`, `button`, or `box` overrides where that one child sits on the cross axis. Values: `top`, `center`, `bottom`. (Not allowed in baseline boxes.)

## Main-axis distribution — `justifyContent`

`justifyContent` only takes effect when **all children's `flex` is 0** (otherwise children fill the space and there's nothing to distribute). Values:

- `flex-start` — children pack at the start (default).
- `center` — children pack in the middle.
- `flex-end` — children pack at the end.
- `space-between` — equal gap between children, none at edges.
- `space-around` — equal gap on both sides of each child (edge gap = half inner gap).
- `space-evenly` — equal gap including the edges.

```json
{
  "type": "box",
  "layout": "horizontal",
  "justifyContent": "space-between",
  "contents": [
    { "type": "text", "text": "Left",  "flex": 0 },
    { "type": "text", "text": "Right", "flex": 0 }
  ]
}
```

## Width / height

- `width`, `maxWidth`, `height`, `maxHeight` accept px (`"100px"`) and percentages of parent (`"50%"`).
- For an `image`, prefer `aspectRatio` + `aspectMode` instead of fixing height — heights derived from aspect ratio are more responsive across bubble sizes.
- `image.size` accepts the keyword scale plus `full`.

## Position — `relative` (default) and `absolute`

By default every component is `position: relative` — laid out in flow.

Setting `position: absolute` removes the component from the normal layout flow and positions it via `offsetTop`, `offsetBottom`, `offsetStart`, `offsetEnd` relative to the **parent box's top-left** corner.

```json
{
  "type": "box",
  "layout": "vertical",
  "contents": [
    { "type": "image", "url": "...", "aspectMode": "cover", "aspectRatio": "20:13", "size": "full" },
    {
      "type": "box",
      "layout": "vertical",
      "position": "absolute",
      "offsetBottom": "20px",
      "offsetStart": "20px",
      "contents": [
        { "type": "text", "text": "Sale!", "color": "#FFFFFF", "weight": "bold", "size": "xxl" }
      ]
    }
  ]
}
```

This is how you overlay text on a hero image.

## Offset on relative components

Even with `position: relative`, you can nudge a component by `offsetTop` / `offsetBottom` / `offsetStart` / `offsetEnd`. The component still occupies its layout slot but visually shifts. Useful for fine-tuning baseline issues. Accepts px or %.

## Backgrounds & corners

Set on a `box`:

- `backgroundColor: "#RRGGBB[AA]"` — solid color.
- `background: { type: "linearGradient", angle: "180deg", startColor: "#RRGGBB", endColor: "#RRGGBB", centerColor?: "#RRGGBB", centerPosition?: "50%" }` — linear gradient.
- `cornerRadius: "md"` — rounded corners (token or px).
- `borderColor` + `borderWidth` — border (use `borderWidth` value tokens or px).

Background applies to the box's content area; corner radius clips it.

## Block-level styles — `bubble.styles`

Per-block overrides on a bubble:

```json
{
  "type": "bubble",
  "styles": {
    "header": { "backgroundColor": "#1B6EFF" },
    "hero":   { "backgroundColor": "#000000" },
    "body":   { "backgroundColor": "#FFFFFF", "separator": true, "separatorColor": "#EEEEEE" },
    "footer": { "backgroundColor": "#FAFAFA", "separator": true }
  },
  "header": { ... },
  "hero":   { ... },
  "body":   { ... },
  "footer": { ... }
}
```

`separator: true` on a block draws a line between it and the previous block.

## Rules of thumb (what experienced builders do)

1. **Use `vertical` for stacks, `horizontal` for rows, `baseline` only for icon+text.**
2. **Inline values stay literal-token where possible** (`"md"`, `"sm"`) — they scale across bubble sizes better than pixels.
3. **For two-column "label / value" rows**, set both children to `flex: 0` and use `align: "end"` on the right one.
4. **For overlay text on hero images**, wrap a hero `box` containing the `image` and a `position: absolute` text/box at known offsets.
5. **For consistent gutters**, set `spacing` once on the parent box rather than `margin` on each child.
6. **Avoid pixel sizes inside vertical boxes** unless you've tested across `nano`–`giga`. Tokens are responsive.
7. **`flex: 0` is your friend** when you want intrinsic sizing; `flex: 1+` when you want stretching.
8. **Don't nest boxes more than ~6 deep.** Past that, render perf drops on older devices and the 50 KB cap creeps up.

## Layout debugging checklist

If a Flex Message renders wrong:

- [ ] Parent box has the right `layout` (vertical vs horizontal vs baseline)?
- [ ] All children have explicit `flex: 0` if you used `justifyContent`?
- [ ] `align` (text-internal) vs `alignItems` (parent on cross axis) — using the right one?
- [ ] No mix of `margin` on first child and parent `spacing` (the margin wins)?
- [ ] `aspectRatio` set on hero images so height is predictable?
- [ ] `wrap: true` on long text — otherwise it ellipsizes silently?
- [ ] `direction: rtl` only when you actually need RTL? (start/end semantics flip.)
- [ ] Hero uses `aspectMode: "cover"` for fill-and-crop, `"fit"` for letterbox?
