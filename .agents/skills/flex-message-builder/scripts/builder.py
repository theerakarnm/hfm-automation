#!/usr/bin/env python3
"""
Lightweight helper for assembling LINE Flex Messages from Python.

Not a full DSL — just thin constructors that produce dicts matching the spec, so
you can compose messages without typing the same boilerplate every time. The
output of any function here is JSON-ready and passes scripts/validate.py.

Example:
    from builder import (
        flex, bubble, carousel, box, text, image, button, separator,
        uri_action, postback_action,
    )

    msg = flex(
        alt_text="Order confirmed",
        contents=bubble(
            body=box("vertical", spacing="md", contents=[
                text("Order #1234", weight="bold", size="xl"),
                text("Thanks for your purchase!", color="#666666", wrap=True),
            ]),
            footer=box("vertical", contents=[
                button(uri_action("View receipt", "https://example.com/r/1234"),
                       style="primary", color="#1DB446"),
            ]),
        ),
    )
"""

from __future__ import annotations

from typing import Any, Iterable


def _strip_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


# ---------- Message envelope ---------------------------------------------------

def flex(*, alt_text: str, contents: dict, quick_reply: dict | None = None,
         sender: dict | None = None) -> dict:
    if len(alt_text) > 400:
        raise ValueError("altText must be ≤ 400 characters")
    msg = {"type": "flex", "altText": alt_text, "contents": contents}
    if quick_reply is not None:
        msg["quickReply"] = quick_reply
    if sender is not None:
        msg["sender"] = sender
    return msg


# ---------- Containers ---------------------------------------------------------

def bubble(*, header: dict | None = None, hero: dict | None = None,
           body: dict | None = None, footer: dict | None = None,
           size: str | None = None, direction: str | None = None,
           styles: dict | None = None, action: dict | None = None) -> dict:
    return _strip_none({
        "type": "bubble",
        "size": size,
        "direction": direction,
        "header": header,
        "hero": hero,
        "body": body,
        "footer": footer,
        "styles": styles,
        "action": action,
    })


def carousel(bubbles: Iterable[dict]) -> dict:
    bs = list(bubbles)
    if not 1 <= len(bs) <= 12:
        raise ValueError("carousel must have 1..12 bubbles")
    return {"type": "carousel", "contents": bs}


# ---------- Components ---------------------------------------------------------

def box(layout: str, *, contents: list[dict] | None = None,
        flex_: int | None = None, spacing: str | None = None,
        margin: str | None = None, padding_all: str | None = None,
        padding_top: str | None = None, padding_bottom: str | None = None,
        padding_start: str | None = None, padding_end: str | None = None,
        background_color: str | None = None, border_color: str | None = None,
        border_width: str | None = None, corner_radius: str | None = None,
        width: str | None = None, max_width: str | None = None,
        height: str | None = None, max_height: str | None = None,
        position: str | None = None,
        offset_top: str | None = None, offset_bottom: str | None = None,
        offset_start: str | None = None, offset_end: str | None = None,
        justify_content: str | None = None, align_items: str | None = None,
        background: dict | None = None, action: dict | None = None) -> dict:
    if layout not in ("horizontal", "vertical", "baseline"):
        raise ValueError("layout must be horizontal/vertical/baseline")
    return _strip_none({
        "type": "box",
        "layout": layout,
        "contents": contents if contents is not None else [],
        "flex": flex_,
        "spacing": spacing,
        "margin": margin,
        "paddingAll": padding_all,
        "paddingTop": padding_top,
        "paddingBottom": padding_bottom,
        "paddingStart": padding_start,
        "paddingEnd": padding_end,
        "backgroundColor": background_color,
        "borderColor": border_color,
        "borderWidth": border_width,
        "cornerRadius": corner_radius,
        "width": width,
        "maxWidth": max_width,
        "height": height,
        "maxHeight": max_height,
        "position": position,
        "offsetTop": offset_top,
        "offsetBottom": offset_bottom,
        "offsetStart": offset_start,
        "offsetEnd": offset_end,
        "justifyContent": justify_content,
        "alignItems": align_items,
        "background": background,
        "action": action,
    })


def text(value: str | None = None, *, contents: list[dict] | None = None,
         size: str | None = None, color: str | None = None,
         weight: str | None = None, style: str | None = None,
         decoration: str | None = None, wrap: bool | None = None,
         line_spacing: str | None = None, max_lines: int | None = None,
         align: str | None = None, gravity: str | None = None,
         flex_: int | None = None, margin: str | None = None,
         action: dict | None = None) -> dict:
    if value is None and contents is None:
        raise ValueError("text requires either `value` or `contents` (spans)")
    return _strip_none({
        "type": "text",
        "text": value,
        "contents": contents,
        "size": size,
        "color": color,
        "weight": weight,
        "style": style,
        "decoration": decoration,
        "wrap": wrap,
        "lineSpacing": line_spacing,
        "maxLines": max_lines,
        "align": align,
        "gravity": gravity,
        "flex": flex_,
        "margin": margin,
        "action": action,
    })


def span(value: str, *, size: str | None = None, color: str | None = None,
         weight: str | None = None, style: str | None = None,
         decoration: str | None = None) -> dict:
    return _strip_none({
        "type": "span",
        "text": value,
        "size": size,
        "color": color,
        "weight": weight,
        "style": style,
        "decoration": decoration,
    })


def image(url: str, *, size: str | None = None,
          aspect_ratio: str | None = None, aspect_mode: str | None = None,
          background_color: str | None = None, animated: bool | None = None,
          align: str | None = None, gravity: str | None = None,
          flex_: int | None = None, margin: str | None = None,
          action: dict | None = None) -> dict:
    if not url.startswith("https://"):
        raise ValueError("image url must be HTTPS")
    return _strip_none({
        "type": "image",
        "url": url,
        "size": size,
        "aspectRatio": aspect_ratio,
        "aspectMode": aspect_mode,
        "backgroundColor": background_color,
        "animated": animated,
        "align": align,
        "gravity": gravity,
        "flex": flex_,
        "margin": margin,
        "action": action,
    })


def video(url: str, *, preview_url: str, alt_content: dict,
          aspect_ratio: str | None = None, action: dict | None = None) -> dict:
    if not url.startswith("https://") or not preview_url.startswith("https://"):
        raise ValueError("video url and previewUrl must be HTTPS")
    return _strip_none({
        "type": "video",
        "url": url,
        "previewUrl": preview_url,
        "altContent": alt_content,
        "aspectRatio": aspect_ratio,
        "action": action,
    })


def button(action: dict, *, style: str | None = None, color: str | None = None,
           height: str | None = None, gravity: str | None = None,
           flex_: int | None = None, margin: str | None = None) -> dict:
    return _strip_none({
        "type": "button",
        "action": action,
        "style": style,
        "color": color,
        "height": height,
        "gravity": gravity,
        "flex": flex_,
        "margin": margin,
    })


def icon(url: str, *, size: str | None = None, aspect_ratio: str | None = None,
         margin: str | None = None) -> dict:
    if not url.startswith("https://"):
        raise ValueError("icon url must be HTTPS")
    return _strip_none({
        "type": "icon",
        "url": url,
        "size": size,
        "aspectRatio": aspect_ratio,
        "margin": margin,
    })


def separator(*, color: str | None = None, margin: str | None = None) -> dict:
    return _strip_none({"type": "separator", "color": color, "margin": margin})


def filler(*, flex_: int | None = None) -> dict:
    return _strip_none({"type": "filler", "flex": flex_})


# ---------- Actions ------------------------------------------------------------

def uri_action(label: str, uri: str, *, alt_uri_desktop: str | None = None) -> dict:
    a = {"type": "uri", "label": label, "uri": uri}
    if alt_uri_desktop:
        a["altUri"] = {"desktop": alt_uri_desktop}
    return a


def postback_action(label: str, data: str, *, display_text: str | None = None) -> dict:
    if len(data) > 300:
        raise ValueError("postback data must be ≤ 300 chars")
    a = {"type": "postback", "label": label, "data": data}
    if display_text:
        a["displayText"] = display_text
    return a


def message_action(label: str, text_: str) -> dict:
    return {"type": "message", "label": label, "text": text_}


def datetime_action(label: str, data: str, *, mode: str = "datetime",
                    initial: str | None = None,
                    min_: str | None = None, max_: str | None = None) -> dict:
    if mode not in ("date", "time", "datetime"):
        raise ValueError("mode must be date/time/datetime")
    a = {"type": "datetimepicker", "label": label, "data": data, "mode": mode}
    if initial: a["initial"] = initial
    if min_: a["min"] = min_
    if max_: a["max"] = max_
    return a


# ---------- Demo / smoke test --------------------------------------------------

if __name__ == "__main__":
    import json

    msg = flex(
        alt_text="Demo",
        contents=bubble(
            hero=image("https://example.com/hero.jpg",
                       size="full", aspect_ratio="20:13", aspect_mode="cover"),
            body=box("vertical", spacing="md", contents=[
                text("Hello", weight="bold", size="xl"),
                text("Built with builder.py", color="#666666", wrap=True),
                separator(margin="md"),
                box("baseline", spacing="sm", contents=[
                    icon("https://example.com/icon.png", size="sm"),
                    text("Inline icon + text", size="sm", color="#555555", flex_=0),
                ]),
            ]),
            footer=box("vertical", contents=[
                button(uri_action("Open", "https://example.com"),
                       style="primary", color="#1DB446"),
            ]),
        ),
    )
    print(json.dumps(msg, indent=2, ensure_ascii=False))
