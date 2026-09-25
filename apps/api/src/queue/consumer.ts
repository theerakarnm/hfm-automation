import { dispatchWebhookEvent } from "../services/webhook-dispatcher";
import { logError, logInfo } from "../utils/logger";
import type { QueueMessage } from "./types";

/**
 * Every tenant config sets max_batch_size to 1, so each LINE event gets its own
 * consumer invocation. A slow lookup can then never make another customer's
 * reply token (60s) expire while it waits in the same batch.
 *
 * Failures are not retried: every tenant config sets max_retries to 0. A retry
 * could reuse a reply token that is already spent, and replyOrPush would then
 * fall back to a push - a duplicate answer for the customer, billed per member
 * in a group. message.retry() therefore sends the message straight to the dead
 * letter queue, where the operator can inspect it.
 */
export async function handleQueueBatch(
  batch: MessageBatch<QueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    const started = Date.now();
    try {
      await dispatchWebhookEvent(message.body);
      message.ack();
      logInfo(
        "queue",
        {
          webhookEventId: message.body.webhookEventId,
          attempts: message.attempts,
          // Time spent waiting in the queue. Kept off the "webhook event
          // received" line on purpose: tests/webhook-logging.test.ts pins that
          // line's exact field set.
          queueLagMs: started - message.body.receivedAt,
          durationMs: Date.now() - started,
        },
        "queue message handled",
      );
    } catch (err) {
      logError("queue", err);
      message.retry();
    }
  }
}
