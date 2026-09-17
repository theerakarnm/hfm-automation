export interface WebhookBody {
  destination: string;
  events: WebhookEvent[];
}

// One entry of message.mention.mentionees. `isSelf` is present only when
// `type` is "user", and it is the documented way to know the bot itself was
// mentioned.
export interface Mentionee {
  index: number;
  length: number;
  type: "user" | "all";
  userId?: string;
  isSelf?: boolean;
}

export interface WebhookEvent {
  type: string;
  mode: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  replyToken?: string;
  message?: {
    type: string;
    id: string;
    text?: string;
    mention?: { mentionees: Mentionee[] };
  };
  postback?: {
    data: string;
    params?: Record<string, string>;
  };
}

// Source is deliberately NOT narrowed to a user chat: the same handler serves
// one-on-one, group and multi-person chats. Use getChatContext() to learn
// where the event came from.
export interface TextMessageEvent extends WebhookEvent {
  type: "message";
  replyToken: string;
  message: {
    type: "text";
    id: string;
    text: string;
    mention?: { mentionees: Mentionee[] };
  };
}

export function isTextMessageEvent(
  event: WebhookEvent
): event is TextMessageEvent {
  return (
    event.type === "message" &&
    event.message != null &&
    event.message.type === "text" &&
    typeof event.message.text === "string" &&
    typeof event.replyToken === "string"
  );
}

export interface PostbackEvent extends WebhookEvent {
  type: "postback";
  replyToken: string;
  postback: {
    data: string;
    params?: Record<string, string>;
  };
}

export function isPostbackEvent(
  event: WebhookEvent
): event is PostbackEvent {
  return (
    event.type === "postback" &&
    event.postback != null &&
    typeof event.postback.data === "string" &&
    typeof event.replyToken === "string"
  );
}

// Fired when the bot is invited into a group or multi-person chat. Unlike
// `leave`, it carries a reply token.
export interface JoinEvent extends WebhookEvent {
  type: "join";
  replyToken: string;
}

export function isJoinEvent(event: WebhookEvent): event is JoinEvent {
  return event.type === "join" && typeof event.replyToken === "string";
}

// Fired when the bot is removed. No reply token, so nothing can be sent back.
export interface LeaveEvent extends WebhookEvent {
  type: "leave";
}

export function isLeaveEvent(event: WebhookEvent): event is LeaveEvent {
  return event.type === "leave";
}
