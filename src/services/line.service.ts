import { logError } from "../utils/logger";

const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_API = "https://api.line.me/v2/bot/message/reply";
const LINE_LOADING_API = "https://api.line.me/v2/bot/chat/loading/start";
const LINE_TIMEOUT_MS = 10_000;

async function pushMessage(
  userId: string,
  message: object
): Promise<void> {
  const res = await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [message] }),
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

export const pushText = (userId: string, text: string) =>
  pushMessage(userId, { type: "text", text });

export const pushFlex = (
  userId: string,
  altText: string,
  contents: object
) => pushMessage(userId, { type: "flex", altText, contents });

export const replyText = (replyToken: string, text: string) =>
  replyMessage(replyToken, { type: "text", text });

export const replyTexts = (replyToken: string, texts: string[]) =>
  replyMessages(
    replyToken,
    texts.map((text) => ({ type: "text", text })),
  );

export const replyFlex = (
  replyToken: string,
  altText: string,
  contents: object
) => replyMessage(replyToken, { type: "flex", altText, contents });

export async function pushToAll(uids: string[], text: string): Promise<void> {
  for (let i = 0; i < uids.length; i++) {
    await pushText(uids[i]!, text);
    if (i < uids.length - 1) {
      await Bun.sleep(200);
    }
  }
}
