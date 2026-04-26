#!/usr/bin/env python3
"""
LINE Flex Message validator.

Usage:
    python3 validate.py path/to/flex.json
    cat flex.json | python3 validate.py -

Exits 0 if the message is valid, 1 if it has errors. Warnings don't fail.

Checks the spec from:
- https://developers.line.biz/en/docs/messaging-api/using-flex-messages/
- https://developers.line.biz/en/docs/messaging-api/flex-message-elements/
- https://developers.line.biz/en/docs/messaging-api/flex-message-layout/
- https://developers.line.biz/en/docs/messaging-api/create-flex-message-including-video/

Cross-checked against @line/bot-sdk TypeScript types.
"""

from __future__ import annotations

import json
import sys
from typing import Any


# ---------- enums and tokens ----------------------------------------------------

BUBBLE_SIZES = {"nano", "micro", "deca", "hecto", "kilo", "mega", "giga"}
BUBBLE_DIRECTIONS = {"ltr", "rtl"}
BOX_LAYOUTS = {"horizontal", "vertical", "baseline"}
POSITIONS = {"relative", "absolute"}
JUSTIFY_CONTENTS = {
    "flex-start", "center", "flex-end",
    "space-between", "space-around", "space-evenly",
}
ALIGN_ITEMS = {"flex-start", "center", "flex-end"}
TEXT_ALIGNS = {"start", "end", "center"}
GRAVITIES = {"top", "center", "bottom"}
TEXT_WEIGHTS = {"regular", "bold"}
TEXT_STYLES = {"normal", "italic"}
DECORATIONS = {"none", "underline", "line-through"}
ASPECT_MODES = {"fit", "cover"}
BUTTON_STYLES = {"primary", "secondary", "link"}
BUTTON_HEIGHTS = {"sm", "md"}
ADJUST_MODES = {"shrink-to-fit"}
SIZE_TOKENS = {"none", "xxs", "xs", "sm", "md", "lg", "xl", "xxl",
               "3xl", "4xl", "5xl", "full"}
ACTION_TYPES = {"postback", "message", "uri", "datetimepicker",
                "clipboard", "richmenuswitch", "camera", "cameraRoll", "location"}

LEAF_COMPONENTS = {"text", "image", "button", "icon", "separator", "filler", "span", "video"}
ALL_COMPONENTS = LEAF_COMPONENTS | {"box"}


# ---------- error/warning collection -------------------------------------------

class Result:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, path: str, msg: str) -> None:
        self.errors.append(f"  ERROR  at {path}: {msg}")

    def warn(self, path: str, msg: str) -> None:
        self.warnings.append(f"  WARN   at {path}: {msg}")

    @property
    def ok(self) -> bool:
        return not self.errors


# ---------- validators ---------------------------------------------------------

def is_token_or_size(value: Any) -> bool:
    """Allow named tokens, "Npx", or "N%"."""
    if not isinstance(value, str):
        return False
    if value in SIZE_TOKENS:
        return True
    if value.endswith("px") and value[:-2].replace(".", "", 1).isdigit():
        return True
    if value.endswith("%"):
        rest = value[:-1]
        try:
            float(rest)
            return True
        except ValueError:
            return False
    return False


def is_color(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    if not value.startswith("#"):
        return False
    body = value[1:]
    if len(body) not in (6, 8):
        return False
    return all(c in "0123456789abcdefABCDEF" for c in body)


def is_https_url(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("https://")


def validate_action(action: Any, path: str, r: Result) -> None:
    if not isinstance(action, dict):
        r.err(path, "action must be an object")
        return
    t = action.get("type")
    if t not in ACTION_TYPES:
        r.err(path, f"action.type must be one of {sorted(ACTION_TYPES)}, got {t!r}")
        return
    # type-specific required fields
    if t == "uri" and not action.get("uri"):
        r.err(path, "uri action requires `uri`")
    if t == "message" and not action.get("text"):
        r.err(path, "message action requires `text`")
    if t == "postback" and not action.get("data"):
        r.err(path, "postback action requires `data`")
    if t == "datetimepicker":
        if not action.get("data"):
            r.err(path, "datetimepicker action requires `data`")
        if action.get("mode") not in {"date", "time", "datetime"}:
            r.err(path, "datetimepicker.mode must be 'date', 'time', or 'datetime'")
    # data length cap
    if "data" in action and isinstance(action["data"], str) and len(action["data"]) > 300:
        r.err(path, "action.data exceeds 300 characters")


def validate_box(box: dict, path: str, r: Result) -> None:
    layout = box.get("layout")
    if layout not in BOX_LAYOUTS:
        r.err(path, f"box.layout must be one of {sorted(BOX_LAYOUTS)}, got {layout!r}")
    contents = box.get("contents")
    if not isinstance(contents, list):
        r.err(path, "box.contents must be an array (may be empty, but key is required)")
    else:
        for i, child in enumerate(contents):
            validate_component(child, f"{path}.contents[{i}]", r)

    # justifyContent only effective if all children flex == 0
    if "justifyContent" in box:
        if box["justifyContent"] not in JUSTIFY_CONTENTS:
            r.err(path, f"box.justifyContent must be one of {sorted(JUSTIFY_CONTENTS)}")
        elif isinstance(contents, list):
            non_zero = [c for c in contents if isinstance(c, dict) and c.get("flex", None) not in (0, None)]
            if non_zero and any(c.get("flex", 0) != 0 for c in contents if isinstance(c, dict)):
                r.warn(path, "justifyContent has no visible effect unless all children have flex: 0")

    if "alignItems" in box and box["alignItems"] not in ALIGN_ITEMS:
        r.err(path, f"box.alignItems must be one of {sorted(ALIGN_ITEMS)}")

    if "position" in box and box["position"] not in POSITIONS:
        r.err(path, f"box.position must be one of {sorted(POSITIONS)}")

    for color_prop in ("backgroundColor", "borderColor"):
        if color_prop in box and not is_color(box[color_prop]):
            r.err(path, f"box.{color_prop} must be a hex color")

    if "background" in box:
        bg = box["background"]
        if not isinstance(bg, dict) or bg.get("type") != "linearGradient":
            r.err(path, "box.background.type must be 'linearGradient'")
        else:
            for c in ("startColor", "endColor", "centerColor"):
                if c in bg and not is_color(bg[c]):
                    r.err(path, f"box.background.{c} must be a hex color")

    if "action" in box:
        validate_action(box["action"], f"{path}.action", r)


def validate_text(text: dict, path: str, r: Result) -> None:
    if "text" not in text and "contents" not in text:
        r.err(path, "text component requires either `text` or `contents` (spans)")
    if "contents" in text:
        spans = text["contents"]
        if not isinstance(spans, list):
            r.err(path, "text.contents must be an array of spans")
        else:
            for i, s in enumerate(spans):
                if not isinstance(s, dict) or s.get("type") != "span":
                    r.err(f"{path}.contents[{i}]", "must be a span component")
                else:
                    validate_span(s, f"{path}.contents[{i}]", r)

    for prop, allowed in [
        ("align", TEXT_ALIGNS),
        ("gravity", GRAVITIES),
        ("weight", TEXT_WEIGHTS),
        ("style", TEXT_STYLES),
        ("decoration", DECORATIONS),
        ("position", POSITIONS),
        ("adjustMode", ADJUST_MODES),
    ]:
        if prop in text and text[prop] not in allowed:
            r.err(path, f"text.{prop} must be one of {sorted(allowed)}")

    if "color" in text and not is_color(text["color"]):
        r.err(path, "text.color must be a hex color")

    if "wrap" in text and not isinstance(text["wrap"], bool):
        r.err(path, "text.wrap must be a boolean")

    if "action" in text:
        validate_action(text["action"], f"{path}.action", r)


def validate_span(span: dict, path: str, r: Result) -> None:
    for prop, allowed in [
        ("weight", TEXT_WEIGHTS),
        ("style", TEXT_STYLES),
        ("decoration", DECORATIONS),
    ]:
        if prop in span and span[prop] not in allowed:
            r.err(path, f"span.{prop} must be one of {sorted(allowed)}")
    if "color" in span and not is_color(span["color"]):
        r.err(path, "span.color must be a hex color")


def validate_image(img: dict, path: str, r: Result) -> None:
    if not is_https_url(img.get("url", "")):
        r.err(path, "image.url is required and must be HTTPS")
    elif len(img["url"]) > 2000:
        r.err(path, "image.url exceeds 2000 characters")

    if "aspectMode" in img and img["aspectMode"] not in ASPECT_MODES:
        r.err(path, f"image.aspectMode must be one of {sorted(ASPECT_MODES)}")

    if "aspectRatio" in img:
        ar = img["aspectRatio"]
        if not isinstance(ar, str) or ":" not in ar:
            r.err(path, "image.aspectRatio must be 'W:H' format")
        else:
            try:
                w, h = ar.split(":")
                w_i, h_i = int(w), int(h)
                if not (1 <= w_i <= 100000 and 1 <= h_i <= 100000):
                    r.err(path, "image.aspectRatio width/height must be 1..100000")
                if h_i > 3 * w_i:
                    r.err(path, "image.aspectRatio: height cannot exceed 3 × width")
            except ValueError:
                r.err(path, "image.aspectRatio width/height must be integers")

    if "animated" in img and not isinstance(img["animated"], bool):
        r.err(path, "image.animated must be a boolean")

    for prop, allowed in [
        ("align", TEXT_ALIGNS),
        ("gravity", GRAVITIES),
        ("position", POSITIONS),
    ]:
        if prop in img and img[prop] not in allowed:
            r.err(path, f"image.{prop} must be one of {sorted(allowed)}")

    if "backgroundColor" in img and not is_color(img["backgroundColor"]):
        r.err(path, "image.backgroundColor must be a hex color")

    if "action" in img:
        validate_action(img["action"], f"{path}.action", r)


def validate_video(video: dict, path: str, r: Result, in_hero: bool, bubble_size: str | None) -> None:
    if not in_hero:
        r.err(path, "video component is only allowed in bubble.hero")
    if bubble_size not in (None, "mega"):
        r.err(path, f"bubble containing a video must have size 'mega' (got {bubble_size!r})")

    if not is_https_url(video.get("url", "")):
        r.err(path, "video.url is required and must be HTTPS")
    if not is_https_url(video.get("previewUrl", "")):
        r.err(path, "video.previewUrl is required and must be HTTPS")
    if "altContent" not in video:
        r.err(path, "video.altContent is required (typically an image fallback)")
    else:
        validate_component(video["altContent"], f"{path}.altContent", r)

    if "aspectRatio" in video:
        ar = video["aspectRatio"]
        if not isinstance(ar, str) or ":" not in ar:
            r.err(path, "video.aspectRatio must be 'W:H' format")
    else:
        r.warn(path, "video.aspectRatio not set — recommended for predictable layout")

    if "action" in video:
        validate_action(video["action"], f"{path}.action", r)


def validate_button(btn: dict, path: str, r: Result) -> None:
    if "action" not in btn:
        r.err(path, "button.action is required")
    else:
        validate_action(btn["action"], f"{path}.action", r)
    if "style" in btn and btn["style"] not in BUTTON_STYLES:
        r.err(path, f"button.style must be one of {sorted(BUTTON_STYLES)}")
    if "height" in btn and btn["height"] not in BUTTON_HEIGHTS:
        r.err(path, f"button.height must be one of {sorted(BUTTON_HEIGHTS)}")
    if "color" in btn and not is_color(btn["color"]):
        r.err(path, "button.color must be a hex color")
    if "gravity" in btn and btn["gravity"] not in GRAVITIES:
        r.err(path, f"button.gravity must be one of {sorted(GRAVITIES)}")
    if "position" in btn and btn["position"] not in POSITIONS:
        r.err(path, f"button.position must be one of {sorted(POSITIONS)}")


def validate_icon(icon: dict, path: str, r: Result) -> None:
    if not is_https_url(icon.get("url", "")):
        r.err(path, "icon.url is required and must be HTTPS")


def validate_separator(sep: dict, path: str, r: Result) -> None:
    if "color" in sep and not is_color(sep["color"]):
        r.err(path, "separator.color must be a hex color")


def validate_component(comp: Any, path: str, r: Result,
                       in_hero: bool = False, bubble_size: str | None = None) -> None:
    if not isinstance(comp, dict):
        r.err(path, "component must be an object")
        return
    t = comp.get("type")
    if t not in ALL_COMPONENTS:
        r.err(path, f"unknown component type {t!r}; expected one of {sorted(ALL_COMPONENTS)}")
        return
    if t == "box":
        validate_box(comp, path, r)
    elif t == "text":
        validate_text(comp, path, r)
    elif t == "image":
        validate_image(comp, path, r)
    elif t == "video":
        validate_video(comp, path, r, in_hero=in_hero, bubble_size=bubble_size)
    elif t == "button":
        validate_button(comp, path, r)
    elif t == "icon":
        validate_icon(comp, path, r)
    elif t == "separator":
        validate_separator(comp, path, r)
    elif t == "filler":
        pass  # only `flex` and that's covered by no-op
    elif t == "span":
        # spans are usually only valid inside text.contents; warn if seen at top of contents
        r.warn(path, "span outside text.contents is unusual; consider wrapping in a text component")


def validate_bubble(bubble: dict, path: str, r: Result) -> None:
    if bubble.get("type") != "bubble":
        r.err(path, f"expected type 'bubble', got {bubble.get('type')!r}")
        return
    size = bubble.get("size")
    if size is not None and size not in BUBBLE_SIZES:
        r.err(path, f"bubble.size must be one of {sorted(BUBBLE_SIZES)}")
    if "direction" in bubble and bubble["direction"] not in BUBBLE_DIRECTIONS:
        r.err(path, f"bubble.direction must be 'ltr' or 'rtl'")

    has_video_hero = False
    if "header" in bubble:
        if not isinstance(bubble["header"], dict) or bubble["header"].get("type") != "box":
            r.err(f"{path}.header", "header must be a box component")
        else:
            validate_component(bubble["header"], f"{path}.header", r)
    if "hero" in bubble:
        hero = bubble["hero"]
        if not isinstance(hero, dict):
            r.err(f"{path}.hero", "hero must be a component object")
        else:
            allowed_hero = {"image", "video", "box"}
            if hero.get("type") not in allowed_hero:
                r.err(f"{path}.hero", f"hero must be one of {sorted(allowed_hero)}, got {hero.get('type')!r}")
            else:
                if hero.get("type") == "video":
                    has_video_hero = True
                validate_component(hero, f"{path}.hero", r, in_hero=True, bubble_size=size)
    if "body" in bubble:
        if not isinstance(bubble["body"], dict) or bubble["body"].get("type") != "box":
            r.err(f"{path}.body", "body must be a box component")
        else:
            validate_component(bubble["body"], f"{path}.body", r)
    if "footer" in bubble:
        if not isinstance(bubble["footer"], dict) or bubble["footer"].get("type") != "box":
            r.err(f"{path}.footer", "footer must be a box component")
        else:
            validate_component(bubble["footer"], f"{path}.footer", r)

    if has_video_hero and size not in (None, "mega"):
        # double-check (validate_video already errors); kept for clarity
        pass

    if "styles" in bubble:
        styles = bubble["styles"]
        if not isinstance(styles, dict):
            r.err(f"{path}.styles", "styles must be an object")
        else:
            for block in ("header", "hero", "body", "footer"):
                if block in styles:
                    block_style = styles[block]
                    if not isinstance(block_style, dict):
                        r.err(f"{path}.styles.{block}", "must be an object")
                    else:
                        if "backgroundColor" in block_style and not is_color(block_style["backgroundColor"]):
                            r.err(f"{path}.styles.{block}.backgroundColor", "must be a hex color")
                        if "separatorColor" in block_style and not is_color(block_style["separatorColor"]):
                            r.err(f"{path}.styles.{block}.separatorColor", "must be a hex color")

    if "action" in bubble:
        validate_action(bubble["action"], f"{path}.action", r)


def validate_carousel(car: dict, path: str, r: Result) -> None:
    contents = car.get("contents")
    if not isinstance(contents, list):
        r.err(path, "carousel.contents must be an array of bubbles")
        return
    if len(contents) < 1:
        r.err(path, "carousel must have at least 1 bubble")
    if len(contents) > 12:
        r.err(path, f"carousel cannot have more than 12 bubbles (has {len(contents)})")
    sizes = set()
    for i, b in enumerate(contents):
        if not isinstance(b, dict) or b.get("type") != "bubble":
            r.err(f"{path}.contents[{i}]", "carousel children must be bubbles")
            continue
        validate_bubble(b, f"{path}.contents[{i}]", r)
        if b.get("size"):
            sizes.add(b["size"])
    if len(sizes) > 1:
        r.warn(path, f"carousel bubbles have mixed sizes {sorted(sizes)}; consider one size for cleaner rendering")


def validate_flex_message(msg: Any, r: Result) -> None:
    if not isinstance(msg, dict):
        r.err("$", "Flex Message must be a JSON object")
        return
    if msg.get("type") != "flex":
        r.err("$.type", f"expected 'flex', got {msg.get('type')!r}")
    alt = msg.get("altText")
    if not isinstance(alt, str) or not alt:
        r.err("$.altText", "altText is required and must be a non-empty string")
    elif len(alt) > 400:
        r.err("$.altText", f"altText is {len(alt)} chars; must be ≤ 400")

    contents = msg.get("contents")
    if not isinstance(contents, dict):
        r.err("$.contents", "contents must be a bubble or carousel object")
        return
    t = contents.get("type")
    if t == "bubble":
        validate_bubble(contents, "$.contents", r)
    elif t == "carousel":
        validate_carousel(contents, "$.contents", r)
    else:
        r.err("$.contents.type", f"must be 'bubble' or 'carousel', got {t!r}")

    # size cap
    serialized = json.dumps(msg, separators=(",", ":"))
    size_kb = len(serialized.encode("utf-8")) / 1024
    if size_kb > 50:
        r.err("$", f"serialized message is {size_kb:.1f} KB; max is 50 KB")
    elif size_kb > 40:
        r.warn("$", f"serialized message is {size_kb:.1f} KB; getting close to 50 KB cap")


# ---------- CLI ----------------------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: validate.py <flex.json | ->", file=sys.stderr)
        return 2
    path = argv[1]
    if path == "-":
        raw = sys.stdin.read()
    else:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"FAIL: not valid JSON — {e}")
        return 1

    r = Result()
    validate_flex_message(msg, r)

    if r.warnings:
        print("Warnings:")
        for w in r.warnings:
            print(w)
    if r.errors:
        print("Errors:")
        for e in r.errors:
            print(e)
        print(f"\nFAIL: {len(r.errors)} error(s).")
        return 1

    print(f"OK: Flex Message is valid ({len(r.warnings)} warning(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
