import { logError } from "../utils/logger";

const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_LOADING_API = "https://api.line.me/v2/bot/chat/loading/start";

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
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE push failed ${res.status}: ${errText}`);
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

export async function pushToAll(uids: string[], text: string): Promise<void> {
  for (let i = 0; i < uids.length; i++) {
    await pushText(uids[i]!, text);
    if (i < uids.length - 1) {
      await Bun.sleep(200);
    }
  }
}
