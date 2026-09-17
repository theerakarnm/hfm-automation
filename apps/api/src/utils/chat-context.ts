import type { WebhookEvent } from "../types/line.types";

export type ChatType = "user" | "group" | "room";

export interface ChatContext {
  // Where the conversation happens. Drives the permission check and whether
  // a loading animation is legal.
  chatType: ChatType;
  // Push target. LINE accepts a userId, groupId or roomId in `to`.
  chatId: string;
  // Who typed. LINE omits this for group members who have never used the
  // iOS or Android app, so nothing on the reply path may depend on it.
  userId: string | null;
}

export function getChatContext(event: WebhookEvent): ChatContext | null {
  const source = event.source;
  if (!source) return null;

  const userId = typeof source.userId === "string" ? source.userId : null;

  if (source.type === "group") {
    return source.groupId
      ? { chatType: "group", chatId: source.groupId, userId }
      : null;
  }

  if (source.type === "room") {
    return source.roomId
      ? { chatType: "room", chatId: source.roomId, userId }
      : null;
  }

  return userId ? { chatType: "user", chatId: userId, userId } : null;
}
