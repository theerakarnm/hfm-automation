import type { WebhookEvent } from "../types/line.types";

// One queue message carries one LINE event. LINE batches up to 20 events into
// a single webhook call, and each one needs its own reply token and its own
// retry behaviour, so the batch is fanned out here rather than in the consumer.
export interface LineEventMessage {
  kind: "line-event";
  tenant: string;
  webhookEventId: string;
  // Epoch ms of the webhook arrival. The LINE reply token expires 60s after
  // the event, so the consumer checks this before spending it.
  receivedAt: number;
  destination?: string;
  event: WebhookEvent;
}

export type QueueMessage = LineEventMessage;
