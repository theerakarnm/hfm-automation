import type { Mentionee, TextMessageEvent } from "../types/line.types";

function selfMentions(event: TextMessageEvent): Mentionee[] {
  const mentionees = event.message.mention?.mentionees ?? [];
  // `isSelf` is only set for type "user"; an @all mention must not count as
  // talking to the bot, or the bot answers every @all in the group.
  return mentionees.filter((m) => m.type === "user" && m.isSelf === true);
}

export function isBotMentioned(event: TextMessageEvent): boolean {
  return selfMentions(event).length > 0;
}

// The mention is part of message.text as a display string such as
// "@hfm_bot", so it has to be cut out by offset before the text can be
// parsed as a Wallet ID. Cutting from the end backwards keeps every
// remaining index valid.
export function stripBotMention(event: TextMessageEvent): string {
  const ordered = selfMentions(event).sort((a, b) => b.index - a.index);
  let text = event.message.text;
  for (const mention of ordered) {
    // LINE does not document whether index/length count UTF-16 units or
    // code points, and one astral emoji before the mention shifts one
    // reading against the other. Only cut a span that really starts with
    // "@": a shifted offset then degrades to "text does not parse" instead
    // of eating the wrong characters. Thai text is BMP, so both readings
    // agree there and mentions always cut cleanly.
    const span = text.slice(mention.index, mention.index + mention.length);
    if (!span.startsWith("@")) continue;
    text = text.slice(0, mention.index) + text.slice(mention.index + mention.length);
  }
  return text.trim();
}
