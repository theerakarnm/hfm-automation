import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { verifyLineSignature } from "../utils/signature";
import { webhookEventIdOf } from "../services/webhook-dispatcher";
import { logInfo, logWarn } from "../utils/logger";
import type { WorkerEnv } from "../config/env";
import type { LineEventMessage } from "../queue/types";
import type { WebhookBody } from "../types/line.types";

const MAX_WEBHOOK_EVENTS = 20;

const webhook = new Hono<{ Bindings: WorkerEnv }>();

webhook.post(
  "/",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.text("Payload Too Large", 413),
  }),
  async (c) => {
    const rawBody = await c.req.text();
    const sig = c.req.header("x-line-signature") ?? "";

    if (
      !verifyLineSignature(rawBody, sig, process.env.LINE_CHANNEL_SECRET ?? "")
    ) {
      return c.text("Unauthorized", 400);
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody) as WebhookBody;
    } catch {
      return c.text("Bad Request", 400);
    }

    const events = body.events ?? [];

    // Batch boundary: when this line is absent, LINE never delivered and the
    // gap is upstream of the app. When it is present, follow the
    // webhookEventId to see why the bot stayed quiet.
    logInfo(
      "webhook",
      { destination: body.destination, eventCount: events.length },
      "webhook batch received",
    );

    const eventsToProcess = events.slice(0, MAX_WEBHOOK_EVENTS);
    if (events.length > MAX_WEBHOOK_EVENTS) {
      logWarn(
        "webhook",
        {
          destination: body.destination,
          received: events.length,
          kept: MAX_WEBHOOK_EVENTS,
          dropped: events.length - MAX_WEBHOOK_EVENTS,
        },
        "webhook batch truncated",
      );
    }

    // LINE gives this endpoint 2 seconds before it records a request_timeout,
    // and a Wallet ID lookup needs seconds of HFM calls. So nothing is done
    // here: each event becomes one queue message and the consumer replies.
    const tenant = process.env.TENANT ?? "unknown";
    const messages: LineEventMessage[] = eventsToProcess.map((event) => ({
      kind: "line-event" as const,
      tenant,
      webhookEventId: webhookEventIdOf(event),
      receivedAt: Date.now(),
      destination: body.destination,
      event,
    }));

    if (messages.length > 0) {
      await c.env.EVENT_QUEUE.sendBatch(
        messages.map((body) => ({ body })),
      );
    }

    return c.text("OK", 200);
  },
);

export default webhook;
