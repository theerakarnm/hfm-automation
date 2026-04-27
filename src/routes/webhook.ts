import { Hono } from "hono";
import { verifyLineSignature } from "../utils/signature";
import { fetchPerformance, checkConditions } from "../services/hfm.service";
import { pushText, pushFlex, showLoading } from "../services/line.service";
import { buildTradingCard } from "../builders/flex-message.builder";
import { isTextMessageEvent } from "../types/line.types";
import { isWhitelisted } from "../utils/whitelist";
import { logError } from "../utils/logger";
import { getDatabase, initSqlite } from "../services/sqlite.service";
import { recordLineUserRequest } from "../repositories/line-user.repository";
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

  const db = getDatabase();
  initSqlite(db);

  for (const event of body.events ?? []) {
    const uid = event.source?.userId;
    if (uid) {
      recordLineUserRequest(db, uid, event.type);
    }
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
    const bubbles = result.data.map((clientData) => {
      const conditions = checkConditions(clientData);
      return buildTradingCard(clientData, walletId, conditions);
    });

    if (bubbles.length === 1) {
      await pushFlex(userId, `Trading Summary — ${walletId}`, bubbles[0]!);
    } else {
      await pushFlex(userId, `Trading Summary — ${walletId}`, {
        type: "carousel",
        contents: bubbles,
      });
    }
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
