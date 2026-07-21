export interface WebhookBody {
  destination: string;
  events: WebhookEvent[];
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
  };
  postback?: {
    data: string;
    params?: Record<string, string>;
  };
}

export interface TextMessageEvent extends WebhookEvent {
  type: "message";
  replyToken: string;
  message: { type: "text"; id: string; text: string };
  source: { type: "user"; userId: string };
}

export function isTextMessageEvent(
  event: WebhookEvent
): event is TextMessageEvent {
  return (
    event.type === "message" &&
    event.message != null &&
    event.message.type === "text" &&
    typeof event.message.text === "string" &&
    event.source.type === "user" &&
    typeof event.source.userId === "string"
  );
}

export interface PostbackEvent extends WebhookEvent {
  type: "postback";
  replyToken: string;
  postback: {
    data: string;
    params?: Record<string, string>;
  };
  source: { type: "user"; userId: string };
}

export function isPostbackEvent(
  event: WebhookEvent
): event is PostbackEvent {
  return (
    event.type === "postback" &&
    event.postback != null &&
    typeof event.postback.data === "string" &&
    event.source.type === "user" &&
    typeof event.source.userId === "string"
  );
}

