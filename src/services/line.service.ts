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
    const err = await res.text();
    throw new Error(`LINE push failed ${res.status}: ${err}`);
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
    const err = await res.text();
    throw new Error(`LINE loading indicator failed ${res.status}: ${err}`);
  }
}

export const pushText = (userId: string, text: string) =>
  pushMessage(userId, { type: "text", text });

export const pushFlex = (
  userId: string,
  altText: string,
  contents: object
) => pushMessage(userId, { type: "flex", altText, contents });
