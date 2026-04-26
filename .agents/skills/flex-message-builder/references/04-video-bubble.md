# 04 — Flex Message including a video

Source: https://developers.line.biz/en/docs/messaging-api/create-flex-message-including-video/

This file covers the special rules for putting a **video** in the hero block of a bubble. Video bubbles look like a single bubble with a tappable video preview at the top and a normal body/footer beneath — perfect for promo clips, demos, or trailers.

## When to use a video bubble

- You want users to watch a clip inline in the chat (without leaving LINE).
- The video is short (≤ 200 MB, mp4) and lives at a public HTTPS URL.
- A still preview frame is available (HTTPS image).

For longer videos or YouTube/Vimeo links, use a normal bubble with an `image` hero and a `uri` action button instead.

## Hard requirements (the API will reject otherwise)

A video bubble must satisfy **all** of these:

1. The bubble must be a **single bubble** — not a carousel of bubbles.
   - You *can* put a video bubble alongside non-video bubbles in a carousel, but only one bubble in the carousel can have a video, and it must be the first bubble. (Conservative advice: just send a single bubble.)
2. `bubble.size` must be `"mega"` (it's the default; just don't override it to `kilo`/`giga`/etc).
3. `bubble.hero` must be a component with `type: "video"`.
4. Body/footer/header are normal — but `hero` cannot be `image` or `box` if you want a video.
5. The video component requires:
   - `url` — HTTPS mp4 URL.
   - `previewUrl` — HTTPS image URL (JPEG/PNG) shown until user taps play.
   - `altContent` — a fallback `image` component for clients that can't play inline video. **Required.**
   - `aspectRatio` — strongly recommended for predictable sizing.
6. **Aspect ratios must match** across three places:
   - The actual aspect ratio of the video file at `url`.
   - The image at `previewUrl`.
   - The `aspectRatio` property on the video component.
   - The `aspectRatio` of the `altContent` image.
   If they mismatch, LINE letterboxes or stretches and it looks broken.

## Recommended aspect ratios

LINE renders cleanly at:

- `"20:13"` ≈ 16:10.4 — common for landscape promo videos.
- `"1:1"` — square.
- `"9:16"` — portrait / vertical.

Pick one and stick with it across the three URLs.

## Reference template

```json
{
  "type": "flex",
  "altText": "Watch our spring promo",
  "contents": {
    "type": "bubble",
    "size": "mega",
    "hero": {
      "type": "video",
      "url": "https://example.com/promo.mp4",
      "previewUrl": "https://example.com/promo-preview.jpg",
      "altContent": {
        "type": "image",
        "url": "https://example.com/promo-preview.jpg",
        "size": "full",
        "aspectRatio": "20:13",
        "aspectMode": "cover"
      },
      "aspectRatio": "20:13",
      "action": {
        "type": "uri",
        "label": "Watch on web",
        "uri": "https://example.com/promo"
      }
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "spacing": "md",
      "contents": [
        { "type": "text", "text": "Spring Sale", "weight": "bold", "size": "xl" },
        { "type": "text", "text": "Watch the 20-second highlight reel.", "wrap": true, "color": "#666666" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
      "spacing": "sm",
      "contents": [
        {
          "type": "button",
          "style": "primary",
          "color": "#1DB446",
          "action": {
            "type": "uri",
            "label": "Shop now",
            "uri": "https://example.com/sale"
          }
        }
      ]
    }
  }
}
```

## Why each property exists

- **`url`** — the actual video LINE will stream when the user taps play. Must be public HTTPS mp4. No auth headers possible.
- **`previewUrl`** — the still image shown before play. Without it, LINE shows a placeholder. With it, your bubble looks polished. JPEG/PNG only.
- **`altContent`** — the fallback. Older LINE clients (pre-12.6.0) and clients on low-bandwidth modes don't render inline video; they render `altContent` instead. Almost always you set this to an `image` of the `previewUrl` so the bubble still shows the same hero visually. The user can then tap a button in the body/footer to open the video externally.
- **`aspectRatio`** — locks the hero's aspect so the bubble's height is predictable; matches the video so there's no black-bar letterboxing.
- **`action`** — optional tap-action when the video isn't playing yet. Useful as a "open in browser" fallback if the inline player fails.

## Carousel with one video bubble

If you really want video + non-video bubbles in one swipe, the video bubble must come **first**:

```json
{
  "type": "flex",
  "altText": "New arrivals",
  "contents": {
    "type": "carousel",
    "contents": [
      { "type": "bubble", "size": "mega", "hero": { "type": "video", ... }, "body": { ... } },
      { "type": "bubble", "size": "mega", "hero": { "type": "image", ... }, "body": { ... } },
      { "type": "bubble", "size": "mega", "hero": { "type": "image", ... }, "body": { ... } }
    ]
  }
}
```

All bubbles in the carousel should be `size: "mega"` to match the video bubble's height.

## LINE client compatibility

- Inline video plays on LINE **12.6.0+** (iOS/Android/desktop).
- Older clients see `altContent` instead of the video.
- Always include `altContent` — it's required, and it ensures graceful degradation.

## Common mistakes — auto-correct these

1. **Bubble is not `mega`** → set `bubble.size` to `"mega"` (or remove the override since `mega` is default).
2. **`altContent` missing** → API rejects. Add an `image` fallback of the same aspect ratio.
3. **`previewUrl` is HTTP, not HTTPS** → switch to HTTPS, ensure TLS 1.2+.
4. **`aspectRatio` not set** → bubble may render at unexpected height. Always set it.
5. **Aspect ratio mismatch** → video, preview, and `aspectRatio` value must agree, or you'll see black bars / cropping.
6. **Putting a `button` as the only `altContent`** → `altContent` should visually substitute for the video; an image is the correct choice.
7. **Trying to put video in `body` or `footer`** → video only works in `hero`.

## When NOT to use a video bubble

- Long-form content (> 1–2 minutes) → users won't watch in chat. Use an image hero + "Watch full video" button.
- Live streams → not supported. Link out to a LIFF or web URL.
- Multiple videos in one bubble → not supported. Use a carousel where each bubble has its own video.
- DRM-protected video → no, the URL must be a plain HTTPS mp4.
