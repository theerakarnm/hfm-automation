import { Hono } from "hono";
import { verifyLineSignature } from "../utils/signature";
import { fetchPerformance, checkConditions } from "../services/hfm.service";
import { pushText, pushFlex, showLoading } from "../services/line.service";
import { buildTradingCard } from "../builders/flex-message.builder";
import { isTextMessageEvent } from "../types/line.types";
import { isWhitelisted } from "../utils/whitelist";
import { logError } from "../utils/logger";
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
      processTextEvent(event).catch((err) => logError("webhook", err));
    }
  }

  return c.text("OK", 200);
});

async function processTextEvent(event: TextMessageEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  if (!isWhitelisted(userId)) {
    await pushText(
      userId,
      "❌ ขออภัย คุณไม่มีสิทธิ์ใช้งานบอทนี้ หากต้องการใช้งาน กรุณาติดต่อ Support"
    );
    return;
  }

  const walletId = event.message.text.trim();
  showLoading(userId).catch((err) => {
    logError("line-loading", err);
  });

  const result = await fetchPerformance(walletId);

  if (result.ok) {
    const conditions = checkConditions(result.data, walletId);
    const bubble = buildTradingCard(result.data, walletId, conditions);
    await pushFlex(userId, `Trading Summary — ${walletId}`, bubble);
    return;
  }

  const errMsg =
    result.reason === "not_found"
      ? `❌ ไม่พบข้อมูล Wallet ID ${walletId} ในระบบ\nกรุณาตรวจสอบ Wallet ID และลองใหม่อีกครั้ง`
      : result.reason === "timeout"
        ? "⚠️ การเชื่อมต่อหมดเวลา\nกรุณาลองใหม่อีกครั้ง"
        : "⚠️ ระบบ HFM API ขัดข้องชั่วคราว\nกรุณาลองใหม่ในอีกสักครู่ หรือติดต่อ Support";
  await pushText(userId, errMsg);
}

export default webhook;
