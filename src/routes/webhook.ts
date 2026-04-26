import { Hono } from "hono";
import { verifyLineSignature } from "../utils/signature";
import { fetchPerformance, checkConditions } from "../services/hfm.service";
import { pushText, pushFlex } from "../services/line.service";
import { buildTradingCard } from "../builders/flex-message.builder";
import { isTextMessageEvent } from "../types/line.types";
import type { WebhookBody, TextMessageEvent } from "../types/line.types";

const webhook = new Hono();

webhook.post("/", async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header("x-line-signature") ?? "";

  if (
    !verifyLineSignature(
      rawBody,
      sig,
      process.env.LINE_CHANNEL_SECRET ?? ""
    )
  ) {
    return c.text("Unauthorized", 400);
  }

  const body = JSON.parse(rawBody) as WebhookBody;

  for (const event of body.events ?? []) {
    if (isTextMessageEvent(event)) {
      processTextEvent(event).catch(console.error);
    }
  }

  return c.text("OK", 200);
});

async function processTextEvent(event: TextMessageEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  const walletId = event.message.text.trim();
  const result = await fetchPerformance(walletId);

  if (result.ok) {
    const conditions = checkConditions(result.data, walletId);
    const bubble = buildTradingCard(result.data, walletId, conditions);
    await pushFlex(userId, `Trading Summary — ${walletId}`, bubble);
    return;
  }

  const errMsg =
    result.reason === "not_found"
      ? `\u274C \u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25 Wallet ID ${walletId} \u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A Wallet ID \u0E41\u0E25\u0E30\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07`
      : result.reason === "timeout"
        ? "\u26A0\uFE0F \u0E01\u0E32\u0E23\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E15\u0E48\u0E2D\u0E2B\u0E21\u0E14\u0E40\u0E27\u0E25\u0E32\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
        : "\u26A0\uFE0F \u0E23\u0E30\u0E1A\u0E1A HFM API \u0E02\u0E31\u0E14\u0E02\u0E49\u0E2D\u0E07\u0E0A\u0E31\u0E48\u0E27\u0E04\u0E23\u0E32\u0E27\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E43\u0E19\u0E2D\u0E35\u0E01\u0E2A\u0E31\u0E01\u0E04\u0E23\u0E39\u0E48 \u0E2B\u0E23\u0E37\u0E2D\u0E15\u0E34\u0E14\u0E15\u0E48\u0E2D Support";

  await pushText(userId, errMsg);
}

export default webhook;
