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
}

export interface TextMessageEvent extends WebhookEvent {
  type: "message";
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
