import { logError } from "../utils/logger";
import type { ChatContext } from "../utils/chat-context";

const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_API = "https://api.line.me/v2/bot/message/reply";
const LINE_LOADING_API = "https://api.line.me/v2/bot/chat/loading/start";
const LINE_GROUP_SUMMARY_API = "https://api.line.me/v2/bot/group";
const LINE_TIMEOUT_MS = 10_000;

async function pushMessage(
  to: string,
  message: object
): Promise<void> {
  const res = await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
    signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE push failed ${res.status}: ${errText}`);
    logError("line-service", err);
    throw err;
  }
}

async function replyMessages(
  replyToken: string,
  messages: object[],
): Promise<void> {
  const res = await fetch(LINE_REPLY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
    signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE reply failed ${res.status}: ${errText}`);
    logError("line-service", err);
    throw err;
  }
}

async function replyMessage(
  replyToken: string,
  message: object
): Promise<void> {
  const res = await fetch(LINE_REPLY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
    signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE reply failed ${res.status}: ${errText}`);
    logError("line-service", err);
    throw err;
  }
}

export async function showLoading(
  chatId: string,
  loadingSeconds = 20
): Promise<void> {
  const res = await fetch(LINE_LOADING_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ chatId, loadingSeconds }),
    signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE loading indicator failed ${res.status}: ${errText}`);
    logError("line-service", err);
    throw err;
  }
}

export const pushText = (to: string, text: string) =>
  pushMessage(to, { type: "text", text });

export const pushFlex = (
  to: string,
  altText: string,
  contents: object
) => pushMessage(to, { type: "flex", altText, contents });

export const replyText = (replyToken: string, text: string) =>
  replyMessage(replyToken, { type: "text", text });

export const replyTexts = (replyToken: string, texts: string[]) =>
  replyMessages(
    replyToken,
    texts.map((text) => ({ type: "text", text })),
  );

// Replies with the reply token, falling back to a push when the reply is
// rejected (expired token, LINE 4xx) so the customer is never left with
// silence. Throws only when the push fails too.
// `to` is the chat, not the sender: in a group the fallback push goes to the
// groupId, and LINE bills one message per group member, so this stays a
// fallback and never the normal path.
async function replyOrPush(
  replyToken: string,
  to: string,
  message: object
): Promise<void> {
  try {
    await replyMessage(replyToken, message);
    return;
  } catch {
    // replyMessage already logged the failure.
  }
  await pushMessage(to, message);
}

export const replyOrPushText = (
  replyToken: string,
  to: string,
  text: string
) => replyOrPush(replyToken, to, { type: "text", text });

export const replyOrPushFlex = (
  replyToken: string,
  to: string,
  altText: string,
  contents: object
) => replyOrPush(replyToken, to, { type: "flex", altText, contents });

export async function pushToAll(uids: string[], text: string): Promise<void> {
  for (let i = 0; i < uids.length; i++) {
    await pushText(uids[i]!, text);
    if (i < uids.length - 1) {
      await Bun.sleep(200);
    }
  }
}

// The loading animation exists only in one-on-one chats. Sending a groupId or
// roomId as chatId returns 400 "Only user id is acceptable", so the rule lives
// here and no caller can get it wrong.
export async function showLoadingForChat(ctx: ChatContext): Promise<void> {
  if (ctx.chatType !== "user") return;
  await showLoading(ctx.chatId);
}

// Group display name for the operator-facing group list. Telemetry only:
// every failure degrades to null, and there is no room equivalent of this
// endpoint.
export async function fetchGroupSummary(groupId: string): Promise<string | null> {
  try {
    const res = await fetch(`${LINE_GROUP_SUMMARY_API}/${groupId}/summary`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { groupName?: string };
    return data.groupName ?? null;
  } catch (err) {
    logError("line-service", err);
    return null;
  }
}
