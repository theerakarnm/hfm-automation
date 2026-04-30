import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { verifyLineSignature } from "../utils/signature";
import { fetchPerformance, resolveLinkedAccounts, checkConditions, parsePerformanceLookup } from "../services/hfm.service";
import { replyText, replyFlex, showLoading } from "../services/line.service";
import { buildTradingCard } from "../builders/flex-message.builder";
import { generateReportForUser, type ReportPeriod } from "../jobs/daily-client-report";
import { isTextMessageEvent } from "../types/line.types";
import { isWhitelisted } from "../utils/whitelist";
import { logError } from "../utils/logger";
import { getDatabase } from "../services/sqlite.service";
import { recordLineUserRequest } from "../repositories/line-user.repository";
import type { WebhookBody, TextMessageEvent } from "../types/line.types";

const MAX_WEBHOOK_EVENTS = 20;

const webhook = new Hono();

webhook.post(
  "/",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.text("Payload Too Large", 413),
  }),
  async (c) => {
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

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody) as WebhookBody;
    } catch {
      return c.text("Bad Request", 400);
    }

    const events = body.events ?? [];
    const db = getDatabase();

    const eventsToProcess = events.slice(0, MAX_WEBHOOK_EVENTS);

    for (const event of eventsToProcess) {
      const uid = event.source?.userId;
      if (uid) {
        recordLineUserRequest(db, uid, event.type);
      }
      if (isTextMessageEvent(event)) {
        processTextEvent(event).catch((err) => logError("webhook", err));
      }
    }

    return c.text("OK", 200);
  }
);

async function processTextEvent(event: TextMessageEvent): Promise<void> {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  if (!userId) return;

  if (!isWhitelisted(userId)) {
    await replyText(
      replyToken,
      "\u274C \u0E02\u0E2D\u0E2D\u0E20\u0E31\u0E22 \u0E04\u0E38\u0E13\u0E44\u0E21\u0E48\u0E21\u0E35\u0E2A\u0E34\u0E17\u0E18\u0E34\u0E4C\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19\u0E1A\u0E2D\u0E17\u0E19\u0E35\u0E49 \u0E2B\u0E32\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E01\u0E32\u0E23\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E15\u0E34\u0E14\u0E15\u0E48\u0E2D Support"
    );
    return;
  }

  const inputText = event.message.text.trim();

  const lower = inputText.toLowerCase();

  let reportPeriod: ReportPeriod | undefined;
  if (lower === "report" || lower === "reportday") {
    reportPeriod = "day";
  } else if (lower === "reportweek") {
    reportPeriod = "week";
  } else if (lower === "reportmonth") {
    reportPeriod = "month";
  }

  if (reportPeriod) {
    showLoading(userId).catch((err) => {
      logError("line-loading", err);
    });
    try {
      const reportText = await generateReportForUser({ reportPeriod });
      await replyText(replyToken, reportText);
    } catch (err) {
      logError("webhook-report", err);
      await replyText(
        replyToken,
        "\u26A0\uFE0F \u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E2A\u0E23\u0E49\u0E32\u0E07\u0E23\u0E32\u0E22\u0E07\u0E32\u0E19\u0E44\u0E14\u0E49 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
      );
    }
    return;
  }

  const lookup = parsePerformanceLookup(inputText);

  if (!lookup) {
    await replyText(
      replyToken,
      "\u274C \u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2B\u0E23\u0E37\u0E2D Trading Account \u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 T\n\u0E40\u0E0A\u0E48\u0E19 98241376, WL-98241376, T1928491038"
    );
    return;
  }

  showLoading(userId).catch((err) => {
    logError("line-loading", err);
  });

  const result = lookup.kind === "wallet"
    ? await fetchPerformance(lookup)
    : await resolveLinkedAccounts(lookup.id);

  if (result.ok) {
    const clientsToShow = result.data.slice(0, 10);
    const bubbles = clientsToShow.map((clientData) => {
      const conditions = checkConditions(clientData);
      return buildTradingCard(clientData, conditions);
    });

    const walletId = result.data[0]!.client_id;
    const altLabel = `Wallet ${walletId}`;
    if (bubbles.length === 1) {
      await replyFlex(replyToken, `Trading Summary \u2014 ${altLabel}`, bubbles[0]!);
    } else {
      await replyFlex(replyToken, `Trading Summary \u2014 ${altLabel}`, {
        type: "carousel",
        contents: bubbles.slice(0, 10),
      });
    }
    return;
  }

  const idLabel = lookup.kind === "wallet" ? `Wallet ID ${lookup.label}` : `Account ID ${lookup.label}`;
  const errMsg =
    result.reason === "not_found"
      ? `\u274C \u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25 ${idLabel} \u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E41\u0E25\u0E30\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07`
      : result.reason === "no_wallet"
        ? `\u274C Account ID ${lookup.label} \u0E44\u0E21\u0E48\u0E21\u0E35 Wallet \u0E17\u0E35\u0E48\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E42\u0E22\u0E07`
        : result.reason === "timeout"
          ? "\u26A0\uFE0F \u0E01\u0E32\u0E23\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E15\u0E48\u0E2D\u0E2B\u0E21\u0E14\u0E40\u0E27\u0E25\u0E32\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
          : "\u26A0\uFE0F \u0E23\u0E30\u0E1A\u0E1A HFM API \u0E02\u0E31\u0E14\u0E02\u0E49\u0E2D\u0E07\u0E0A\u0E31\u0E48\u0E27\u0E04\u0E23\u0E32\u0E27\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E43\u0E19\u0E2D\u0E35\u0E01\u0E2A\u0E31\u0E01\u0E04\u0E23\u0E39\u0E48 \u0E2B\u0E23\u0E37\u0E2D\u0E15\u0E34\u0E14\u0E15\u0E48\u0E2D Support";
  await replyText(replyToken, errMsg);
}

export default webhook;
