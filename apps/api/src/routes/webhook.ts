import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { verifyLineSignature } from "../utils/signature";
import { fetchPerformance, resolveLinkedAccounts, checkConditions, parsePerformanceLookup, fetchMonthlyVolumeMap } from "../services/hfm.service";
import {
  replyText,
  replyTexts,
  showLoadingForChat,
  replyOrPushText,
  replyOrPushFlex,
} from "../services/line.service";
import { getLastTradeMapWithin } from "../services/last-trade.service";
import { buildTradingCard, buildPaginationCard, getFlexSummaryVersion } from "../builders/flex-message.builder";
import { generateReportForUser, type ReportPeriod } from "../jobs/daily-client-report";
import { isTextMessageEvent, isPostbackEvent } from "../types/line.types";
import { getChatContext, type ChatContext } from "../utils/chat-context";
import { isBotMentioned, stripBotMention } from "../utils/mention";
import { isChatAllowed } from "../utils/whitelist";
import { logError } from "../utils/logger";
import { getDb, type DrizzleDb } from "../db/connection";
import { recordLineUserRequest } from "../repositories/line-user.repository";
import { recordLineGroupEvent } from "../repositories/line-group.repository";
import type { WebhookBody, TextMessageEvent, PostbackEvent } from "../types/line.types";
import type { PerformanceLookup, MonthlyActivity } from "../types/hfm.types";

const MAX_WEBHOOK_EVENTS = 20;

// The HFM /api/clients/ endpoint needs ~7.4s when healthy and up to 48s
// through its retry ladder. LINE reply tokens expire after 60s, so the
// reply must never wait on it - past this deadline the card renders with
// whatever cache exists and the refresh continues in the background.
// Read per call: Bun caches the module, so a module-load read cannot be
// overridden by tests that re-import this route.
const lastTradeDeadlineMs = (): number =>
  Number(process.env.LAST_TRADE_DEADLINE_MS) || 8_000;

// Last-resort notice. Anything that reaches the dispatcher's catch has
// already failed to reply, so the customer must at least be told to retry
// rather than be left staring at silence.
const RETRY_MESSAGE =
  "\u26A0\uFE0F \u0E23\u0E30\u0E1A\u0E1A\u0E02\u0E31\u0E14\u0E02\u0E49\u0E2D\u0E07\u0E0A\u0E31\u0E48\u0E27\u0E04\u0E23\u0E32\u0E27\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07";

// Sent when the chat is not allowed to use the bot. Shared by the text,
// postback and join paths.
const NOT_ALLOWED_MESSAGE =
  "\u274C \u0E02\u0E2D\u0E2D\u0E20\u0E31\u0E22 \u0E04\u0E38\u0E13\u0E44\u0E21\u0E48\u0E21\u0E35\u0E2A\u0E34\u0E17\u0E18\u0E34\u0E4C\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19\u0E1A\u0E2D\u0E17\u0E19\u0E35\u0E49 \u0E2B\u0E32\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E01\u0E32\u0E23\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E15\u0E34\u0E14\u0E15\u0E48\u0E2D Support";

// Sent when the text is neither a Wallet ID nor a Trading Account. In a group
// this only goes out when somebody mentioned the bot.
const USAGE_MESSAGE =
  "\u274C \u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2B\u0E23\u0E37\u0E2D Trading Account \u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 T\n\u0E40\u0E0A\u0E48\u0E19 98241376, WL-98241376, T1928491038\n\u0E1E\u0E34\u0E21\u0E1E\u0E4C lot \u0E19\u0E33\u0E2B\u0E19\u0E49\u0E32 \u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E41\u0E2A\u0E14\u0E07 Volume \u0E40\u0E0A\u0E48\u0E19 lot 98241376";

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
    const db = getDb();

    const eventsToProcess = events.slice(0, MAX_WEBHOOK_EVENTS);
    for (const event of eventsToProcess) {
      // Every later decision (permission, reply target, loading animation)
      // comes from this triple, never from event.source directly.
      const ctx = getChatContext(event);
      if (!ctx) continue;

      if (ctx.userId) {
        // Telemetry only - a database hiccup must never stop the customer's reply.
        recordLineUserRequest(db, ctx.userId, event.type).catch((err) =>
          logError("line-user", err),
        );
      }

      if (isTextMessageEvent(event)) {
        recordGroupTraffic(db, ctx, event.type);
        const { replyToken } = event;
        processTextEvent(event, ctx).catch((err) => {
          logError("webhook", err);
          void notifyRetry(replyToken, ctx);
        });
      } else if (isPostbackEvent(event)) {
        recordGroupTraffic(db, ctx, event.type);
        const { replyToken } = event;
        processPostbackEvent(event, ctx).catch((err) => {
          logError("webhook", err);
          void notifyRetry(replyToken, ctx);
        });
      }
    }

    return c.text("OK", 200);
  }
);

// Group registry telemetry. join and leave are deliberately not recorded
// here: their own handlers own the `active` flag, and a fire-and-forget
// upsert racing with them could resurrect a group the bot has just left.
function recordGroupTraffic(
  db: DrizzleDb,
  ctx: ChatContext,
  eventType: string,
): void {
  if (ctx.chatType === "user") return;
  recordLineGroupEvent(db, {
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    eventType,
  }).catch((err) => logError("line-group", err));
}

async function notifyRetry(replyToken: string, ctx: ChatContext): Promise<void> {
  // The catch-all also fires for chats that are not allowed and whose
  // rejection notice failed to send; they must not get a retry prompt.
  if (!isChatAllowed(ctx)) return;
  try {
    await replyOrPushText(replyToken, ctx.chatId, RETRY_MESSAGE);
  } catch (err) {
    logError("webhook-notify", err);
  }
}

async function processTextEvent(
  event: TextMessageEvent,
  ctx: ChatContext,
): Promise<void> {
  const replyToken = event.replyToken;

  if (!isChatAllowed(ctx)) {
    // An unregistered group is full of people who never asked the bot for
    // anything, so it gets silence instead of a rejection notice.
    if (ctx.chatType !== "user") return;
    await replyText(replyToken, NOT_ALLOWED_MESSAGE);
    return;
  }

  // "@hfm_bot 98241376" has to behave like "98241376". Without a mention this
  // is just the trimmed text.
  const inputText = stripBotMention(event);

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
    // Reports aggregate every client under the affiliate account. That is
    // internal data, and a group can hold customers, so reports stay in
    // one-on-one chats.
    if (ctx.chatType !== "user") return;
    showLoadingForChat(ctx).catch((err) => {
      logError("line-loading", err);
    });
    try {
      const reportMessages = await generateReportForUser({ reportPeriod });
      if (reportMessages.length === 1) {
        await replyText(replyToken, reportMessages[0]!);
      } else {
        await replyTexts(replyToken, reportMessages);
      }
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
    // In a group every ordinary human sentence lands here. Answer only when
    // the bot was actually mentioned, otherwise stay quiet.
    if (ctx.chatType !== "user" && !isBotMentioned(event)) return;
    await replyText(replyToken, USAGE_MESSAGE);
    return;
  }

  await handleLookupAndReply(replyToken, ctx, lookup, 1);
}

function parseQueryString(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairs = query.split("&");
  for (const pair of pairs) {
    const [key, value] = pair.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
    }
  }
  return params;
}

async function processPostbackEvent(
  event: PostbackEvent,
  ctx: ChatContext,
): Promise<void> {
  const replyToken = event.replyToken;

  if (!isChatAllowed(ctx)) {
    if (ctx.chatType !== "user") return;
    await replyText(replyToken, NOT_ALLOWED_MESSAGE);
    return;
  }

  const queryParams = parseQueryString(event.postback.data);
  if (queryParams.action === "page") {
    const kind = queryParams.kind as "wallet" | "account";
    const id = Number(queryParams.id);
    const page = Number(queryParams.page ?? 1);

    if (kind && !Number.isNaN(id)) {
      const lookup: PerformanceLookup = {
        kind,
        id,
        label: kind === "wallet" ? `WL-${id}` : String(id),
        // Preserve the "lot" opt-in across page navigation.
        showVolume: queryParams.vol === "1",
      };
      await handleLookupAndReply(replyToken, ctx, lookup, page);
    }
  }
}

async function handleLookupAndReply(
  replyToken: string,
  ctx: ChatContext,
  lookup: PerformanceLookup,
  page: number = 1
): Promise<void> {
  // No-op in a group chat: LINE only has the loading animation in
  // one-on-one chats.
  showLoadingForChat(ctx).catch((err) => {
    logError("line-loading", err);
  });

  const result = lookup.kind === "wallet"
    ? await fetchPerformance(lookup)
    : await resolveLinkedAccounts(lookup.id);

  if (result.ok) {
    const totalItems = result.data.length;
    const itemsPerPage = 5;
    const totalPages = Math.ceil(totalItems / itemsPerPage);

    let activePage = page;
    if (activePage < 1) activePage = 1;
    if (activePage > totalPages) activePage = totalPages;

    const startIdx = (activePage - 1) * itemsPerPage;
    const endIdx = activePage * itemsPerPage;
    const clientsToShow = result.data.slice(startIdx, endIdx);

    const lastTradeByAccountId =
      (await getLastTradeMapWithin(lastTradeDeadlineMs())) ??
      new Map<number, string | null>();

    // flex-v2 needs current-month lots, which the unranged lookup does not
    // carry. One extra ranged call per reply, only when v2 is on; a null
    // result renders "N/A" instead of holding up the reply token.
    const monthlyByAccountId: Map<number, MonthlyActivity> | null =
      getFlexSummaryVersion() === "flex-v2"
        ? await fetchMonthlyVolumeMap(result.data[0]!.client_id)
        : null;

    const bubbles = clientsToShow.map((clientData) => {
      const conditions = checkConditions(clientData);
      const enrichedClientData = {
        ...clientData,
        last_trade: lastTradeByAccountId.get(clientData.account_id) ?? null,
      };
      return buildTradingCard(enrichedClientData, conditions, {
        showVolume: lookup.showVolume,
        monthly: monthlyByAccountId?.get(clientData.account_id),
      });
    });

    if (totalPages > 1) {
      const pagCard = buildPaginationCard(lookup, activePage, totalPages, totalItems);
      bubbles.push(pagCard);
    }

    const walletId = result.data[0]!.client_id;
    const altLabel = `Wallet ${walletId}`;
    if (bubbles.length === 1) {
      await replyOrPushFlex(
        replyToken,
        ctx.chatId,
        `Trading Summary \u2014 ${altLabel}`,
        bubbles[0]!
      );
    } else {
      await replyOrPushFlex(
        replyToken,
        ctx.chatId,
        `Trading Summary \u2014 ${altLabel}`,
        {
          type: "carousel",
          contents: bubbles,
        }
      );
    }
    return;
  }

  const idLabel = lookup.kind === "wallet" ? `Wallet ID ${lookup.label}` : `Account ID ${lookup.label}`;
  const errMsg =
    result.reason === "all_archived"
      ? `\u0E2D\u0E22\u0E39\u0E48\u0E43\u0E15\u0E49 Partner ${result.subaffiliate} \u0E41\u0E15\u0E48\u0E44\u0E21\u0E48\u0E21\u0E35 Trading Account`
      : result.reason === "not_found"
      ? `\u274C \u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25 ${idLabel} \u0E43\u0E19\u0E23\u0E30\u0E1A\u0E1A\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E41\u0E25\u0E30\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07`
      : result.reason === "no_wallet"
        ? `\u274C Account ID ${lookup.label} \u0E44\u0E21\u0E48\u0E21\u0E35 Wallet \u0E17\u0E35\u0E48\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E42\u0E22\u0E07`
        : result.reason === "timeout"
          ? "\u26A0\uFE0F \u0E01\u0E32\u0E23\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E15\u0E48\u0E2D\u0E2B\u0E21\u0E14\u0E40\u0E27\u0E25\u0E32\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
          : "\u26A0\uFE0F \u0E23\u0E30\u0E1A\u0E1A HFM API \u0E02\u0E31\u0E14\u0E02\u0E49\u0E2D\u0E07\u0E0A\u0E31\u0E48\u0E27\u0E04\u0E23\u0E32\u0E27\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E43\u0E19\u0E2D\u0E35\u0E01\u0E2A\u0E31\u0E01\u0E04\u0E23\u0E39\u0E48 \u0E2B\u0E23\u0E37\u0E2D\u0E15\u0E34\u0E14\u0E15\u0E48\u0E2D Support";
  await replyOrPushText(replyToken, ctx.chatId, errMsg);
}

export default webhook;
