import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import webhook from "../src/routes/webhook";
import type { QueueMessage } from "../src/queue/types";

const SECRET = "test_secret";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64");
}

function collectingQueue() {
  const sent: QueueMessage[] = [];
  return {
    sent,
    sendBatch: async (items: { body: QueueMessage }[]) => {
      sent.push(...items.map((i) => i.body));
    },
  };
}

function textEvent(id: string) {
  return {
    type: "message",
    webhookEventId: id,
    replyToken: "rt",
    source: { type: "user", userId: "Uabc123" },
    message: { type: "text", id: "1", text: "98241376" },
  };
}

describe("webhook producer", () => {
  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.LINE_CHANNEL_SECRET;
  });

  test("rejects a bad signature without enqueueing", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const body = JSON.stringify({ events: [textEvent("a")] });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": "wrong" },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(400);
    expect(queue.sent).toHaveLength(0);
  });

  test("enqueues one message per event and returns 200", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const body = JSON.stringify({
      destination: "Udest",
      events: [textEvent("a"), textEvent("b")],
    });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": sign(body) },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[0]!.webhookEventId).toBe("a");
    expect(queue.sent[0]!.kind).toBe("line-event");
    expect(queue.sent[0]!.destination).toBe("Udest");
    expect(typeof queue.sent[0]!.receivedAt).toBe("number");
  });

  test("truncates a batch larger than 20 events", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const events = Array.from({ length: 25 }, (_, i) => textEvent(`e${i}`));
    const body = JSON.stringify({ events });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": sign(body) },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toHaveLength(20);
  });

  test("answers an empty event list without touching the queue", async () => {
    const app = new Hono().route("/webhook", webhook);
    const queue = collectingQueue();
    const body = JSON.stringify({ events: [] });
    const res = await app.fetch(
      new Request("http://x/webhook", {
        method: "POST",
        headers: { "x-line-signature": sign(body) },
        body,
      }),
      { EVENT_QUEUE: queue } as never,
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toHaveLength(0);
  });
});
