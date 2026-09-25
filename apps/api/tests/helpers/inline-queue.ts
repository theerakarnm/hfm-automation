import type { Hono } from "hono";
import { handleQueueBatch } from "../../src/queue/consumer";
import type { QueueMessage } from "../../src/queue/types";

export interface InlineQueue {
  send(body: QueueMessage): Promise<void>;
  sendBatch(items: { body: QueueMessage }[]): Promise<void>;
  sent: QueueMessage[];
}

/**
 * Runs the real consumer inline instead of going through Cloudflare Queues, so
 * a test can post a webhook body and assert on the LINE reply it produces.
 * Production is asynchronous; this helper only collapses the transport.
 */
export function createInlineQueue(): InlineQueue {
  const sent: QueueMessage[] = [];
  const run = async (bodies: QueueMessage[]): Promise<void> => {
    sent.push(...bodies);
    await handleQueueBatch({
      messages: bodies.map((body) => ({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body,
        ack: () => {},
        retry: () => {},
      })),
      queue: "test",
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<QueueMessage>);
  };
  return {
    sent,
    send: (body) => run([body]),
    sendBatch: (items) => run(items.map((i) => i.body)),
  };
}

/**
 * Makes app.fetch(req) inject a fresh inline queue, so the existing tests that
 * call app.fetch with one argument keep working unchanged.
 */
export function withInlineQueue<T extends Hono<any>>(app: T): T {
  const original = app.fetch.bind(app);
  app.fetch = ((request: Request, env?: object, ctx?: ExecutionContext) =>
    original(
      request,
      { ...(env ?? {}), EVENT_QUEUE: createInlineQueue() },
      ctx,
    )) as T["fetch"];
  return app;
}
