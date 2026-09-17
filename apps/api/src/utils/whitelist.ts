import type { ChatContext } from "./chat-context";

function isFlagOff(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  return ["false", "0", "off", "no"].includes(value);
}

function isWhitelistEnabled(): boolean {
  return !isFlagOff(process.env.LINE_WHITELIST_ENABLED);
}

function isGroupWhitelistEnabled(): boolean {
  return !isFlagOff(process.env.LINE_GROUP_WHITELIST_ENABLED);
}

function parseIdList(raw: string | undefined): string[] {
  return (raw?.trim() ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function isWhitelisted(userId: string): boolean {
  if (!isWhitelistEnabled()) return true;

  const allowed = parseIdList(process.env.LINE_WHITELIST_UIDS);
  // An empty list means "not configured yet", which stays allow-all so a
  // fresh deployment is usable.
  if (allowed.length === 0) return true;

  return allowed.includes(userId);
}

export function isGroupAllowed(chatId: string): boolean {
  if (!isGroupWhitelistEnabled()) return true;

  const allowed = parseIdList(process.env.LINE_GROUP_WHITELIST_IDS);
  if (allowed.length === 0) return true;

  return allowed.includes(chatId);
}

// In a group the group itself is the unit of trust: the request is that any
// member can look an ID up, and LINE does not even send a userId for members
// who have never used the iOS or Android app. So the per-UID whitelist is
// applied to one-on-one chats only.
export function isChatAllowed(ctx: ChatContext): boolean {
  return ctx.chatType === "user"
    ? isWhitelisted(ctx.chatId)
    : isGroupAllowed(ctx.chatId);
}
