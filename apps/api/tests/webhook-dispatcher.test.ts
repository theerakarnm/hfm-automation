import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type postgres from "postgres";
import { createTestDb, closeTestDb, TEST_DATABASE_URL } from "./db-helpers";
import { closeDb, resetDbForTests } from "../src/db/connection";
import { dispatchWebhookEvent } from "../src/services/webhook-dispatcher";
import type { LineEventMessage } from "../src/queue/types";

const ORIGINAL_FETCH = globalThis.fetch;
let client: postgres.Sql;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test_token";
  resetDbForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

afterAll(async () => {
  await closeDb();
  await closeTestDb(client);
  delete process.env.DATABASE_URL;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

function joinMessage(webhookEventId: string): LineEventMessage {
  return {
    kind: "line-event",
    tenant: "test",
    webhookEventId,
    receivedAt: Date.now(),
    event: {
      type: "join",
      mode: "active",
      timestamp: Date.now(),
      replyToken: "rt-join",
      webhookEventId,
      deliveryContext: { isRedelivery: false },
      source: { type: "group", groupId: "Cdup" },
    } as never,
  };
}

function countReplies(): string[] {
  const replies: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/message/reply")) replies.push(url);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return replies;
}

test("a redelivered event is answered once", async () => {
  const replies = countReplies();
  const message = joinMessage("evt-dup-1");
  await dispatchWebhookEvent(message);
  await dispatchWebhookEvent(message);
  expect(replies).toHaveLength(1);
});

test("a different event is still answered", async () => {
  const replies = countReplies();
  await dispatchWebhookEvent(joinMessage("evt-dup-2"));
  expect(replies).toHaveLength(1);
});
