import {
  fetchPerformance,
  resolveLinkedAccounts,
  checkConditions,
  parsePerformanceLookup,
  getLotDisplayMode,
  fetchMonthlyVolumeMap,
} from "../services/hfm.service";
import {
  replyText,
  replyTexts,
  showLoadingForChat,
  replyOrPushText,
  replyOrPushFlex,
  fetchGroupSummary,
} from "../services/line.service";
import { getLastTradeMapWithin } from "../services/last-trade.service";
import {
  buildTradingCard,
  buildPaginationCard,
  getFlexSummaryVersion,
} from "../builders/flex-message.builder";
import { generateReportForUser, type ReportPeriod } from "../jobs/daily-client-report";
import {
  isTextMessageEvent,
  isPostbackEvent,
  isJoinEvent,
  isLeaveEvent,
} from "../types/line.types";
import { getChatContext, type ChatContext } from "../utils/chat-context";
import { isBotMentioned, stripBotMention } from "../utils/mention";
import { isChatAllowed } from "../utils/whitelist";
import { logError, logInfo, logWarn } from "../utils/logger";
import { getDb, type DrizzleDb } from "../db/connection";
import { claimLineEvent } from "../db/state.repository";
import { recordLineUserRequest } from "../repositories/line-user.repository";
import {
  recordLineGroupEvent,
  updateLineGroupLabel,
} from "../repositories/line-group.repository";
import type {
  WebhookEvent,
  TextMessageEvent,
  PostbackEvent,
  JoinEvent,
} from "../types/line.types";
import type { PerformanceLookup, MonthlyActivity } from "../types/hfm.types";
import type { LineEventMessage } from "../queue/types";

// The HFM /api/clients/ endpoint needs ~7.4s when healthy and up to 48s
// through its retry ladder. LINE reply tokens expire after 60s, so the
// reply must never wait on it - past this deadline the card renders with
// whatever cache exists and the refresh continues in the background.
// Read per call: Bun caches the module, so a module-load read cannot be
// overridden by tests that re-import this route.
const lastTradeDeadlineMs = (): number =>
  Number(process.env.LAST_TRADE_DEADLINE_MS) || 8_000;

// LINE assigns each event a webhookEventId. It is the natural trace id: it
// ties the received event, every decision and the reply outcome into one
// grep-able chain, and LINE support can match it on their side. Payloads
// without it get a short random id so correlation never breaks.
export function webhookEventIdOf(event: WebhookEvent): string {
  if (typeof event.webhookEventId === "string" && event.webhookEventId !== "") {
    return event.webhookEventId;
  }
  return `evt-${crypto.randomUUID().slice(0, 8)}`;
}
// One log line per send. replyType names the flow (reply API, push fallback,
// flex card), outcome says whether the customer actually received anything,
// and a failed LINE response carries the HTTP status plus x-line-request-id
// (what LINE support asks for when opening a case). Rethrows so the
// dispatcher's catch-all behaviour stays unchanged.
type ReplyType = "reply" | "push" | "flex";

async function sendReply(
  webhookEventId: string,
  replyType: ReplyType,
  send: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await send();
    logInfo(
      "webhook",
      {
        webhookEventId,
        replyType,
        outcome: "sent",
        durationMs: Date.now() - startedAt,
      },
      "reply sent",
    );
  } catch (err) {
    logWarn(
      "webhook",
      {
        webhookEventId,
        replyType,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        ...lineErrorFields(err),
      },
      "reply failed",
    );
    throw err;
  }
}

function lineErrorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return {};
  const e = err as Error & { httpStatus?: unknown; lineRequestId?: unknown };
  const fields: Record<string, unknown> = {};
  if (e.httpStatus !== undefined) fields.httpStatus = e.httpStatus;
  if (e.lineRequestId !== undefined) fields.lineRequestId = e.lineRequestId;
  return fields;
}

// Upstream latency against the reply-token budget. Anything that used up
// the whole deadline (the >= also absorbs millisecond truncation of a
// slightly longer run) made the card go out without fresh data, so it
// escalates to warn; only clearly faster runs stay at info.
function logUpstreamLatency(
  webhookEventId: string,
  op: string,
  durationMs: number,
): void {
  const deadlineMs = lastTradeDeadlineMs();
  const fields = { webhookEventId, op, durationMs, deadlineMs };
  if (durationMs >= deadlineMs) {
    logWarn("webhook", fields, "upstream latency over deadline");
  } else {
    logInfo("webhook", fields, "upstream latency");
  }
}
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
// this only goes out when somebody mentioned the bot. The "lot" hint only
// makes sense when Volume is opt-in (LOT_DISPLAY_MODE=lot_prefix_only); the
// default "always" mode already shows Volume on plain lookups, so the hint
// is dropped there.
const USAGE_MESSAGE_BODY =
  "\u274C \u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\n\u0E01\u0E23\u0E38\u0E13\u0E32\u0E2A\u0E48\u0E07 Wallet ID \u0E2B\u0E23\u0E37\u0E2D Trading Account \u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 T\n\u0E40\u0E0A\u0E48\u0E19 98241376, WL-98241376, T1928491038";
const USAGE_MESSAGE_LOT_HINT =
  "\n\u0E1E\u0E34\u0E21\u0E1E\u0E4C lot \u0E19\u0E33\u0E2B\u0E19\u0E49\u0E32 \u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E41\u0E2A\u0E14\u0E07 Volume \u0E40\u0E0A\u0E48\u0E19 lot 98241376";

const usageMessage = (): string =>
  getLotDisplayMode() === "lot_prefix_only"
    ? USAGE_MESSAGE_BODY + USAGE_MESSAGE_LOT_HINT
    : USAGE_MESSAGE_BODY;
// Group registry telemetry. join and leave are deliberately not recorded
// here: their own handlers own the `active` flag, and an upsert racing with
// them could resurrect a group the bot has just left. Telemetry only, so a
// failure is logged and never stops the reply.
async function recordGroupTraffic(
  db: DrizzleDb,
  ctx: ChatContext,
  eventType: string,
): Promise<void> {
  if (ctx.chatType === "user") return;
  try {
    await recordLineGroupEvent(db, {
      chatId: ctx.chatId,
      chatType: ctx.chatType,
      eventType,
    });
  } catch (err) {
    logError("line-group", err);
  }
}
async function notifyRetry(
  replyToken: string,
  ctx: ChatContext,
  webhookEventId: string,
): Promise<void> {
  // The catch-all also fires for chats that are not allowed and whose
  // rejection notice failed to send; they must not get a retry prompt.
  if (!isChatAllowed(ctx)) return;
  try {
    if (ctx.chatType === "user") {
      await sendReply(webhookEventId, "push", () =>
        replyOrPushText(replyToken, ctx.chatId, RETRY_MESSAGE),
      );
    } else {
      // A push fallback to a group bills one message per member, and a
      // generic retry notice is not worth that broadcast. Reply only.
      await sendReply(webhookEventId, "reply", () =>
        replyText(replyToken, RETRY_MESSAGE),
      );
    }
  } catch (err) {
    logError("webhook-notify", err);
  }
}
async function processTextEvent(
  event: TextMessageEvent,
  ctx: ChatContext,
  webhookEventId: string,
): Promise<void> {
  const replyToken = event.replyToken;

  if (!isChatAllowed(ctx)) {
    // An unregistered group is full of people who never asked the bot for
    // anything, so it gets silence instead of a rejection notice.
    if (ctx.chatType !== "user") {
      logInfo(
        "webhook",
        { webhookEventId, reason: "chat_not_allowed" },
        "event skipped",
      );
      return;
    }
    await sendReply(webhookEventId, "reply", () =>
      replyText(replyToken, NOT_ALLOWED_MESSAGE),
    );
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
    if (ctx.chatType !== "user") {
      logInfo(
        "webhook",
        { webhookEventId, reason: "report_not_in_group" },
        "event skipped",
      );
      return;
    }
    // Awaited, not fire-and-forget: in a queue consumer an unawaited call can be
    // cancelled, and awaiting also stops the old race where the loading request
    // could land after the reply and show a spinner under the answer.
    await showLoadingForChat(ctx).catch((err) => {
      logError("line-loading", err);
    });
    try {
      const reportMessages = await generateReportForUser({ reportPeriod });
      if (reportMessages.length === 1) {
        await sendReply(webhookEventId, "reply", () =>
          replyText(replyToken, reportMessages[0]!),
        );
      } else {
        await sendReply(webhookEventId, "reply", () =>
          replyTexts(replyToken, reportMessages),
        );
      }
    } catch (err) {
      logError("webhook-report", err);
      await sendReply(webhookEventId, "reply", () =>
        replyText(
          replyToken,
          "\u26A0\uFE0F \u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E2A\u0E23\u0E49\u0E32\u0E07\u0E23\u0E32\u0E22\u0E07\u0E32\u0E19\u0E44\u0E14\u0E49 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E25\u0E2D\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E2D\u0E35\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07"
        ),
      );
    }
    return;
  }

  const lookup = parsePerformanceLookup(inputText);

  // Message content stays out of the logs: only its length and whether it
  // parsed as a lookup are recorded.
  logInfo(
    "webhook",
    { webhookEventId, textLength: inputText.length, isLookup: lookup !== null },
    "text parsed",
  );

  if (!lookup) {
    // In a group every ordinary human sentence lands here. Answer only when
    // the bot was actually mentioned, otherwise stay quiet.
    if (ctx.chatType !== "user" && !isBotMentioned(event)) {
      logInfo(
        "webhook",
        { webhookEventId, reason: "no_mention_not_lookup" },
        "event skipped",
      );
      return;
    }
    await sendReply(webhookEventId, "reply", () =>
      replyText(replyToken, usageMessage()),
    );
    return;
  }

  await handleLookupAndReply(replyToken, ctx, lookup, webhookEventId);
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
  webhookEventId: string,
): Promise<void> {
  const replyToken = event.replyToken;

  if (!isChatAllowed(ctx)) {
    if (ctx.chatType !== "user") {
      logInfo(
        "webhook",
        { webhookEventId, reason: "chat_not_allowed" },
        "event skipped",
      );
      return;
    }
    await sendReply(webhookEventId, "reply", () =>
      replyText(replyToken, NOT_ALLOWED_MESSAGE),
    );
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
        // Preserve the "lot" opt-in across page navigation. In the default
        // "always" mode Volume is on regardless of vol=1, so every page
        // keeps showing it.
        showVolume:
          queryParams.vol === "1" || getLotDisplayMode() === "always",
      };
      await handleLookupAndReply(replyToken, ctx, lookup, webhookEventId, page);
    } else {
      logInfo(
        "webhook",
        { webhookEventId, reason: "postback_unhandled_action" },
        "event skipped",
      );
    }
  } else {
    logInfo(
      "webhook",
      { webhookEventId, reason: "postback_unhandled_action" },
      "event skipped",
    );
  }
}
async function handleLookupAndReply(
  replyToken: string,
  ctx: ChatContext,
  lookup: PerformanceLookup,
  webhookEventId: string,
  page: number = 1
): Promise<void> {
  // No-op in a group chat: LINE only has the loading animation in
  // one-on-one chats.
  // Awaited, not fire-and-forget: in a queue consumer an unawaited call can be
  // cancelled, and awaiting also stops the old race where the loading request
  // could land after the reply and show a spinner under the answer.
  await showLoadingForChat(ctx).catch((err) => {
    logError("line-loading", err);
  });

  const perfStartedAt = Date.now();
  const result = lookup.kind === "wallet"
    ? await fetchPerformance(lookup)
    : await resolveLinkedAccounts(lookup.id);
  logUpstreamLatency(
    webhookEventId,
    lookup.kind === "wallet" ? "fetch_performance" : "resolve_linked_accounts",
    Date.now() - perfStartedAt,
  );

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

    const lastTradeStartedAt = Date.now();
    const lastTradeByAccountId =
      (await getLastTradeMapWithin(lastTradeDeadlineMs())) ??
      new Map<number, string | null>();
    logUpstreamLatency(
      webhookEventId,
      "get_last_trade_map_within",
      Date.now() - lastTradeStartedAt,
    );

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
      await sendReply(webhookEventId, "flex", () =>
        replyOrPushFlex(
          replyToken,
          ctx.chatId,
          `Trading Summary \u2014 ${altLabel}`,
          bubbles[0]!
        ),
      );
    } else {
      await sendReply(webhookEventId, "flex", () =>
        replyOrPushFlex(
          replyToken,
          ctx.chatId,
          `Trading Summary \u2014 ${altLabel}`,
          {
            type: "carousel",
            contents: bubbles,
          }
        ),
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
  await sendReply(webhookEventId, "push", () =>
    replyOrPushText(replyToken, ctx.chatId, errMsg),
  );
}
// Greeting for a group the bot may serve. Sent once, on the join event.
// Like the usage text, the "lot" hint appears only when Volume is opt-in
// (LOT_DISPLAY_MODE=lot_prefix_only); the default "always" mode already
// shows Volume on every lookup.
const GROUP_WELCOME_BODY =
  "สวัสดีครับ 🙌\nพิมพ์ Wallet ID หรือ Trading Account ในกลุ่มนี้ได้เลย\nเช่น 98241376, WL-98241376, T1928491038";
const GROUP_WELCOME_LOT_HINT =
  "\nพิมพ์ lot นำหน้า เพื่อดู Volume เช่น lot 98241376";

const groupWelcomeMessage = (): string =>
  getLotDisplayMode() === "lot_prefix_only"
    ? GROUP_WELCOME_BODY + GROUP_WELCOME_LOT_HINT
    : GROUP_WELCOME_BODY;

// The chat ID is the only easy way for an operator to read it, so the
// rejection notice carries it.
function groupNotRegisteredMessage(chatId: string): string {
  return `❌ กลุ่มนี้ยังไม่ได้ลงทะเบียนใช้งานบอท\nกรุณาแจ้ง Group ID นี้กับ Support: ${chatId}`;
}
async function processJoinEvent(
  event: JoinEvent,
  ctx: ChatContext,
  webhookEventId: string,
): Promise<void> {
  // join never arrives from a one-on-one chat.
  if (ctx.chatType === "user") {
    logInfo(
      "webhook",
      { webhookEventId, reason: "join_from_user_chat" },
      "event skipped",
    );
    return;
  }

  const db = getDb();
  // The registry is telemetry (D8), so a database hiccup must not cost the
  // greeting or the not-registered notice that carries the group ID. The
  // row self-heals on the next event from this chat.
  try {
    await recordLineGroupEvent(db, {
      chatId: ctx.chatId,
      chatType: ctx.chatType,
      eventType: "join",
      active: 1,
    });
  } catch (err) {
    logError("line-group", err);
  }

  try {
    if (!isChatAllowed(ctx)) {
      await sendReply(webhookEventId, "reply", () =>
        replyText(event.replyToken, groupNotRegisteredMessage(ctx.chatId)),
      );
      return;
    }

    await sendReply(webhookEventId, "reply", () =>
      replyText(event.replyToken, groupWelcomeMessage()),
    );
  } finally {
    // The group name is for the operator list only, so it runs after the
    // greeting and never holds it up. It is awaited, and in a finally so a
    // failed greeting does not skip it, because the queue consumer's work ends
    // when this function returns. labelGroup never throws.
    if (ctx.chatType === "group") await labelGroup(db, ctx.chatId);
  }
}
async function labelGroup(db: DrizzleDb, chatId: string): Promise<void> {
  try {
    const label = await fetchGroupSummary(chatId);
    if (label) await updateLineGroupLabel(db, chatId, label);
  } catch (err) {
    logError("line-group", err);
  }
}
// leave carries no reply token, so nothing can be sent back. The row stays
// for the operator list and is only marked inactive.
async function processLeaveEvent(
  ctx: ChatContext,
  webhookEventId: string,
): Promise<void> {
  if (ctx.chatType === "user") {
    logInfo(
      "webhook",
      { webhookEventId, reason: "leave_from_user_chat" },
      "event skipped",
    );
    return;
  }

  await recordLineGroupEvent(getDb(), {
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    eventType: "leave",
    active: 0,
  });
}
/**
 * Handles exactly one LINE event to completion. Called by the queue consumer,
 * never by the HTTP route, because the HFM lookups behind it take seconds and
 * LINE times a webhook out after 2s.
 */
export async function dispatchWebhookEvent(
  message: LineEventMessage,
): Promise<void> {
  const { event, webhookEventId } = message;
  const db = getDb();

  logInfo(
    "webhook",
    {
      webhookEventId,
      eventType: event.type,
      sourceType: event.source?.type,
      chatId: event.source?.groupId ?? event.source?.roomId ?? event.source?.userId,
      hasUserId: typeof event.source?.userId === "string",
      isRedelivery: event.deliveryContext?.isRedelivery === true,
    },
    "webhook event received",
  );

  // Queues deliver at least once. A second delivery would find the reply
  // token spent, and replyOrPush would push a duplicate answer, billed per
  // member in a group. Only the delivery that claims the event replies.
  // Fails open: a database hiccup must never stop the customer's reply, so a
  // claim error is logged and the event is handled anyway.
  let firstDelivery = true;
  try {
    firstDelivery = await claimLineEvent(db, webhookEventId);
  } catch (err) {
    logError("webhook-claim", err);
  }
  if (!firstDelivery) {
    logInfo(
      "webhook",
      { webhookEventId, reason: "duplicate_delivery" },
      "event skipped",
    );
    return;
  }
  // Every later decision (permission, reply target, loading animation) comes
  // from this triple, never from event.source directly.
  const ctx = getChatContext(event);
  if (!ctx) {
    logInfo("webhook", { webhookEventId, reason: "no_chat_context" }, "event skipped");
    return;
  }

  if (ctx.userId) {
    // Telemetry only - a database hiccup must never stop the customer's reply.
    await recordLineUserRequest(db, ctx.userId, event.type).catch((err) =>
      logError("line-user", err),
    );
  }

  if (isTextMessageEvent(event)) {
    await recordGroupTraffic(db, ctx, event.type);
    const { replyToken } = event;
    try {
      await processTextEvent(event, ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
      await notifyRetry(replyToken, ctx, webhookEventId);
    }
    return;
  }

  if (isPostbackEvent(event)) {
    await recordGroupTraffic(db, ctx, event.type);
    const { replyToken } = event;
    try {
      await processPostbackEvent(event, ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
      await notifyRetry(replyToken, ctx, webhookEventId);
    }
    return;
  }

  if (isJoinEvent(event)) {
    // No notifyRetry here: the retry notice is about a failed lookup and would
    // make no sense as an answer to an invite.
    try {
      await processJoinEvent(event, ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
    }
    return;
  }

  if (isLeaveEvent(event)) {
    try {
      await processLeaveEvent(ctx, webhookEventId);
    } catch (err) {
      logError("webhook", err);
    }
    return;
  }

  // follow, unfollow, videoComplete, ... - no handler and no reply.
  logInfo("webhook", { webhookEventId, reason: "unhandled_event_type" }, "event skipped");
}
