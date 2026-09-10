import { logError } from "../utils/logger";
import type { TenantConfig } from "../types/tenant.types";

const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_API = "https://api.line.me/v2/bot/message/reply";
const LINE_LOADING_API = "https://api.line.me/v2/bot/chat/loading/start";
const LINE_TIMEOUT_MS = 10_000;

async function pushMessage(
  ctx: TenantConfig,
  userId: string,
  message: object
): Promise<void> {
  const res = await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.lineChannelAccessToken}`,
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
  ctx: TenantConfig,
  replyToken: string,
  messages: object[],
): Promise<void> {
  const res = await fetch(LINE_REPLY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.lineChannelAccessToken}`,
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
  ctx: TenantConfig,
  replyToken: string,
  message: object
): Promise<void> {
  const res = await fetch(LINE_REPLY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.lineChannelAccessToken}`,
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
  ctx: TenantConfig,
  chatId: string,
  loadingSeconds = 20
): Promise<void> {
  const res = await fetch(LINE_LOADING_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.lineChannelAccessToken}`,
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

export const pushText = (ctx: TenantConfig, userId: string, text: string) =>
  pushMessage(ctx, userId, { type: "text", text });

export const pushFlex = (
  ctx: TenantConfig,
  userId: string,
  altText: string,
  contents: object
) => pushMessage(ctx, userId, { type: "flex", altText, contents });

export const replyText = (ctx: TenantConfig, replyToken: string, text: string) =>
  replyMessage(ctx, replyToken, { type: "text", text });

export const replyTexts = (ctx: TenantConfig, replyToken: string, texts: string[]) =>
  replyMessages(
    ctx,
    replyToken,
    texts.map((text) => ({ type: "text", text })),
  );

// Replies with the reply token, falling back to a push when the reply is
// rejected (expired token, LINE 4xx) so the customer is never left with
// silence. Throws only when the push fails too.
async function replyOrPush(
  ctx: TenantConfig,
  replyToken: string,
  userId: string,
  message: object
): Promise<void> {
  try {
    await replyMessage(ctx, replyToken, message);
    return;
  } catch {
    // replyMessage already logged the failure.
  }
  await pushMessage(ctx, userId, message);
}

export const replyOrPushText = (
  ctx: TenantConfig,
  replyToken: string,
  userId: string,
  text: string
) => replyOrPush(ctx, replyToken, userId, { type: "text", text });

export const replyOrPushFlex = (
  ctx: TenantConfig,
  replyToken: string,
  userId: string,
  altText: string,
  contents: object
) => replyOrPush(ctx, replyToken, userId, { type: "flex", altText, contents });

export async function pushToAll(
  ctx: TenantConfig,
  uids: string[],
  text: string
): Promise<void> {
  for (let i = 0; i < uids.length; i++) {
    await pushText(ctx, uids[i]!, text);
    if (i < uids.length - 1) {
      await Bun.sleep(200);
    }
  }
}

// Resolves the bot identity behind an access token. Used by the admin UI to
// verify a pasted token and to store the bot user id that webhook
// `destination` values are cross-checked against. Returns null on any
// non-2xx so callers can show "token invalid" instead of guessing.
export async function fetchBotInfo(
  accessToken: string,
): Promise<{ userId: string; basicId: string | null; displayName: string | null } | null> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      userId?: string; basicId?: string; displayName?: string;
    };
    if (!body.userId) return null;
    return {
      userId: body.userId,
      basicId: body.basicId ?? null,
      displayName: body.displayName ?? null,
    };
  } catch {
    return null;
  }
}
