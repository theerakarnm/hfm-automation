# LINE Group Chat Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the LINE bot work inside group chats and multi-person chats, so any member can type a Wallet ID or Trading Account number and get the same Flex card the bot already sends in a one-on-one chat.

**Architecture:** Every webhook event is first reduced to a `ChatContext` (`chatType`, `chatId`, `userId`), and every reply, push, and permission check uses that context instead of the raw `userId`.
One-on-one behaviour stays exactly as it is today; group behaviour differs only where LINE forces it to (no loading animation, `userId` can be missing, unrelated human chatter must be ignored).
Group authorization is a group-level allowlist in env, mirroring the existing UID whitelist, plus a `line_groups` registry table so an operator can discover group IDs through `/internal/line-groups`.

**Tech Stack:** Bun, TypeScript (ESM, strict), Hono, Drizzle ORM + PostgreSQL 16, LINE Messaging API (webhook, reply, push, group summary), `bun test`.

---

## Findings (read before editing - already verified)

### Files that matter

| File | Role today | Change in this plan |
| --- | --- | --- |
| `apps/api/src/routes/webhook.ts` (311 lines) | Signature check, event dispatcher (lines 43-100), `processTextEvent` (113), `processPostbackEvent` (185), `handleLookupAndReply` (217). Every handler starts from `event.source.userId`. | Rewritten to use `ChatContext`; adds `join` / `leave` handling and group silence rules. |
| `apps/api/src/types/line.types.ts` (70 lines) | `WebhookEvent`, `isTextMessageEvent`, `isPostbackEvent`. Both guards hard-require `source.type === "user"`, so **every group event is dropped today**. | Guards widened to group and room; `mention` added; `join` / `leave` guards added. |
| `apps/api/src/utils/whitelist.ts` (20 lines) | `isWhitelisted(userId)` over `LINE_WHITELIST_UIDS` / `LINE_WHITELIST_ENABLED`. Empty list means allow all. | Adds `isGroupAllowed(chatId)` and `isChatAllowed(ctx)` with the same env semantics. |
| `apps/api/src/services/line.service.ts` (149 lines) | `pushMessage(userId, ...)`, `replyMessage`, `showLoading(chatId)`, `replyOrPushText/Flex(replyToken, userId, ...)`. | Push target renamed to `to`; adds `showLoadingForChat(ctx)` and `fetchGroupSummary(groupId)`. |
| `apps/api/src/db/schema.ts` (108 lines) | Drizzle tables, `lineUsers` at line 47. | Adds `lineGroups`. |
| `apps/api/src/db/connection.ts` (96 lines) | `initDb()` runs `CREATE TABLE IF NOT EXISTS` for every table at startup (line 20). | Adds the `line_groups` DDL. |
| `apps/api/tests/db-helpers.ts` | Test schema bootstrap, duplicated DDL. | Adds the same `line_groups` DDL plus its `DROP TABLE`. |
| `apps/api/tests/webhook.test.ts` (1200+ lines) | Has its own `setupTestDb()` with a `DROP TABLE` list, `computeSig()`, `waitFor()`, `importWebhook()`. | Adds the drop, plus the new group tests. |
| `apps/api/src/routes/internal.ts` (81 lines) | Key-guarded ops endpoints, `/line-uids` at line 68. | Adds `/line-groups`. |
| `apps/api/src/repositories/line-user.repository.ts` | Upsert telemetry pattern to copy. | Unchanged. |
| `apps/api/.env.example` | Env template. | Adds the two group vars. |

There is no `apps/api/drizzle/` migration folder in this repo.
Schema is applied by `initDb()` at startup (`CREATE TABLE IF NOT EXISTS`) and by `bun run db:push` for ad-hoc syncs, so a new table needs **three** edits: `schema.ts`, `connection.ts`, `tests/db-helpers.ts`.

### LINE Messaging API facts (verified against developers.line.biz)

These drive most of the design decisions below.

1. Group source is `{"type":"group","groupId":"C...","userId":"U..."}`; multi-person chat source is `{"type":"room","roomId":"R...","userId":"U..."}`.
   `userId` is **not guaranteed**: LINE documents it as "Only included in message events. Only users of LINE for iOS and LINE for Android are included in userId."
   The reply path must therefore never depend on `userId`.
   <https://developers.line.biz/en/reference/messaging-api/#source-group>
2. The bot receives a `message` event for **every** message any member sends in the group, exactly like a one-on-one chat.
   There is no mention-only delivery filter, so the filtering is our job.
   <https://developers.line.biz/en/docs/messaging-api/group-chats/#tip-for-using-message-events>
3. `join` has a `replyToken`; `leave` does **not**.
   `memberJoined` / `memberLeft` also exist and are out of scope here.
   <https://developers.line.biz/en/reference/messaging-api/#join-event>
4. Reply works identically in groups. Push accepts `userId`, `groupId`, or `roomId` in `to`.
   Multicast does not support groups.
   <https://developers.line.biz/en/reference/messaging-api/#send-push-message>
5. The loading animation (`POST /v2/bot/chat/loading/start`) is one-on-one only.
   A group ID returns `400` with `"Only user id is acceptable, please confirm if there are any group/room ids or illegal ids."`
   <https://developers.line.biz/en/docs/messaging-api/use-loading-indicator/>
6. Quota counts **per recipient**: one push to a 30-member group costs 30 messages. Reply messages are free.
   So the group path must prefer the reply token and treat push purely as a fallback.
   <https://developers.line.biz/en/docs/messaging-api/pricing/#how-to-count-the-number-of-messages-sent>
7. Bot mention detection: `message.mention.mentionees[]` with `type: "user"` and `isSelf: true`.
   The mention text (for example `@hfm_bot`) is part of `message.text`, so it must be cut out with `index` / `length` before parsing.
   `type: "all"` (an `@all` mention) carries no `isSelf`.
   <https://developers.line.biz/en/reference/messaging-api/#wh-text>
8. `GET /v2/bot/group/{groupId}/summary` returns `{groupId, groupName, pictureUrl?}`.
   There is no room equivalent.
   `GET /v2/bot/group/{groupId}/members/ids` needs a verified or premium account, so this plan does not use it.
   <https://developers.line.biz/en/reference/messaging-api/#get-group-summary>
9. **"Allow bot to join group chats" is disabled by default** in the LINE Developers Console (Messaging API tab).
   Only one LINE Official Account can sit in a group at a time.
   <https://developers.line.biz/en/docs/messaging-api/group-chats/#add-line-official-account-in-group-chats>
10. The reply token stays single-use with the ~60s expiry, so `LAST_TRADE_DEADLINE_MS` keeps its meaning in groups.

---

## Design Decisions

**D1. Group membership is the unit of trust, not the member UID.**
The request is "anyone in the invited group can look up an ID".
A per-member UID check is also impossible to enforce, because LINE omits `userId` for members who never used the iOS or Android app.
So: one-on-one chats keep `isWhitelisted(userId)`; group and room chats use the new group allowlist only.

**D2. Group allowlist copies the existing env semantics.**
`LINE_GROUP_WHITELIST_IDS` empty means allow every group (same as `LINE_WHITELIST_UIDS` today), and `LINE_GROUP_WHITELIST_ENABLED=false` bypasses the check.
This keeps "invite the bot and it just works" true out of the box, and lets an operator lock it down later without a code change.

**D3. In a group, an unparsed message produces silence.**
Today an unrecognized text gets a "wrong format" reply.
In a group that would answer every human sentence.
Rule: in a group the bot replies to an unparsed message **only** when it was mentioned; otherwise it returns without any API call.

**D4. A bot mention is stripped before parsing.**
`@hfm_bot 98241376` must behave like `98241376`.

**D5. Report commands (`report`, `reportweek`, `reportmonth`) stay one-on-one.**
They aggregate every client under the affiliate account, which is internal data, and groups may contain customers.
In a group these words are ignored silently.

**D6. No loading animation in groups.**
The service layer owns this rule (`showLoadingForChat`), so no caller can accidentally trigger the documented `400`.

**D7. No auto-leave.**
If a group is not allowlisted, the bot answers the `join` event once with its own group ID and then stays silent.
`POST /v2/bot/group/{groupId}/leave` exists and can be added later, but leaving on its own would also destroy the only easy way for an operator to read the group ID.

**D8. The `line_groups` table is a registry and telemetry, never the permission source.**
The reply path must not gain a database dependency it does not already have.

**D9. New user-facing Thai strings are written as literal UTF-8, not `\uXXXX` escapes.**
The existing escapes in `webhook.ts` are an artifact of an older tool; they are unreadable in review, and Bun reads the source as UTF-8 either way.
Existing escaped strings are left untouched.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `apps/api/src/utils/chat-context.ts` | Create | `ChatContext` type and `getChatContext(event)`. The single place that knows how LINE encodes "where am I talking". |
| `apps/api/src/utils/mention.ts` | Create | `isBotMentioned(event)` and `stripBotMention(event)`. |
| `apps/api/src/repositories/line-group.repository.ts` | Create | All SQL for `line_groups`. |
| `apps/api/tests/chat-context.test.ts` | Create | Unit tests for the context reducer. |
| `apps/api/tests/mention.test.ts` | Create | Unit tests for mention parsing. |
| `apps/api/tests/line-group.repository.test.ts` | Create | Repository tests against the real test database. |
| `apps/api/src/types/line.types.ts` | Modify | Widen guards to group and room; add `mention`, `JoinEvent`, `LeaveEvent`. |
| `apps/api/src/utils/whitelist.ts` | Modify | Add `isGroupAllowed` and `isChatAllowed`. |
| `apps/api/src/services/line.service.ts` | Modify | Chat-aware loading, generic push target, group summary lookup. |
| `apps/api/src/routes/webhook.ts` | Modify | Context-driven dispatch, group rules, join and leave handling. |
| `apps/api/src/db/schema.ts`, `src/db/connection.ts`, `tests/db-helpers.ts` | Modify | `line_groups` table in all three places. |
| `apps/api/src/routes/internal.ts` | Modify | `GET /internal/line-groups`. |
| `apps/api/tests/whitelist.test.ts`, `tests/webhook.test.ts`, `tests/line.service.test.ts` | Modify | New cases for the group paths. |
| `apps/api/.env.example`, `AGENTS.md` | Modify | Document the two new env vars and the group behaviour. |

---

## Prerequisites (do these first, they are not code)

> Awaiting human: enable "Allow bot to join group chats" in the LINE Developers Console. Only blocks the manual E2E in Task 11 Step 4, not the code tasks.

- [ ] **P1: Turn on group joining for the channel.**
  LINE Developers Console > the Messaging API channel > **Messaging API** tab > **Allow bot to join group chats** > enable.
  It is off by default, and without it no `join` event and no group `message` event ever arrives.

- [x] **P2: Start the test database.**

> Deviation: port 5433 is already bound by the tuasa-postgres container (another project). The test Postgres runs as `hfm-postgres-test` on host port **5434** via podman (`podman run -d --name hfm-postgres-test -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=hfm_test -p 127.0.0.1:5434:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine`). All test runs use `TEST_DATABASE_URL=postgresql://test:test@localhost:5434/hfm_test`.

Run from the repo root:

```bash
docker compose up -d postgres-test
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/hfm_test
```

- [x] **P3: Confirm the suite is green before any edit.**

Run from `apps/api`:

```bash
bun test
bun run typecheck
```

Expected: all tests pass, `tsc --noEmit` prints nothing.
If anything already fails, stop and fix that first; this plan assumes a green baseline.

---

## Task 1: Chat context reducer

Turns any webhook event into the `{chatType, chatId, userId}` triple every later task depends on.

**Files:**
- Create: `apps/api/src/utils/chat-context.ts`
- Test: `apps/api/tests/chat-context.test.ts`

- [x] **Step 1: Write the failing test**

Create `apps/api/tests/chat-context.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { getChatContext } from "../src/utils/chat-context";
import type { WebhookEvent } from "../src/types/line.types";

function event(source: WebhookEvent["source"]): WebhookEvent {
  return {
    type: "message",
    mode: "active",
    timestamp: 1716000000000,
    source,
    replyToken: "token123",
    message: { type: "text", id: "1", text: "98241376" },
  };
}

describe("getChatContext", () => {
  test("user chat uses the user id as the chat id", () => {
    const ctx = getChatContext(event({ type: "user", userId: "Uabc123" }));
    expect(ctx).toEqual({ chatType: "user", chatId: "Uabc123", userId: "Uabc123" });
  });

  test("group chat uses the group id as the chat id", () => {
    const ctx = getChatContext(
      event({ type: "group", groupId: "Cgroup1", userId: "Umember1" }),
    );
    expect(ctx).toEqual({ chatType: "group", chatId: "Cgroup1", userId: "Umember1" });
  });

  test("group chat without a user id still resolves", () => {
    const ctx = getChatContext(event({ type: "group", groupId: "Cgroup1" }));
    expect(ctx).toEqual({ chatType: "group", chatId: "Cgroup1", userId: null });
  });

  test("multi-person chat uses the room id as the chat id", () => {
    const ctx = getChatContext(
      event({ type: "room", roomId: "Rroom1", userId: "Umember1" }),
    );
    expect(ctx).toEqual({ chatType: "room", chatId: "Rroom1", userId: "Umember1" });
  });

  test("user chat without a user id returns null", () => {
    expect(getChatContext(event({ type: "user" }))).toBeNull();
  });

  test("group chat without a group id returns null", () => {
    expect(getChatContext(event({ type: "group", userId: "Umember1" }))).toBeNull();
  });

  test("missing source returns null", () => {
    const broken = { type: "message", mode: "active", timestamp: 1 } as unknown as WebhookEvent;
    expect(getChatContext(broken)).toBeNull();
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/chat-context.test.ts
```

Expected: FAIL with a resolve error like `Cannot find module '../src/utils/chat-context'`.

- [x] **Step 3: Write the implementation**

Create `apps/api/src/utils/chat-context.ts`:

```ts
import type { WebhookEvent } from "../types/line.types";

export type ChatType = "user" | "group" | "room";

export interface ChatContext {
  // Where the conversation happens. Drives the permission check and whether
  // a loading animation is legal.
  chatType: ChatType;
  // Push target. LINE accepts a userId, groupId or roomId in `to`.
  chatId: string;
  // Who typed. LINE omits this for group members who have never used the
  // iOS or Android app, so nothing on the reply path may depend on it.
  userId: string | null;
}

export function getChatContext(event: WebhookEvent): ChatContext | null {
  const source = event.source;
  if (!source) return null;

  const userId = typeof source.userId === "string" ? source.userId : null;

  if (source.type === "group") {
    return source.groupId
      ? { chatType: "group", chatId: source.groupId, userId }
      : null;
  }

  if (source.type === "room") {
    return source.roomId
      ? { chatType: "room", chatId: source.roomId, userId }
      : null;
  }

  return userId ? { chatType: "user", chatId: userId, userId } : null;
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/chat-context.test.ts
```

Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/utils/chat-context.ts apps/api/tests/chat-context.test.ts
git commit -m "feat: add chat context reducer"
```

---

## Task 2: Accept group and room events in the type guards

`isTextMessageEvent` currently returns `false` for every group event, which is the single reason group chat does nothing today.

**Files:**
- Modify: `apps/api/src/types/line.types.ts:6-70`
- Test: `apps/api/tests/line-types.test.ts` (create)

- [x] **Step 1: Write the failing test**

Create `apps/api/tests/line-types.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import {
  isTextMessageEvent,
  isPostbackEvent,
  isJoinEvent,
  isLeaveEvent,
} from "../src/types/line.types";
import type { WebhookEvent } from "../src/types/line.types";

const base = { mode: "active", timestamp: 1716000000000 };

describe("isTextMessageEvent", () => {
  test("accepts a one-on-one text message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "user", userId: "Uabc123" },
      replyToken: "t1",
      message: { type: "text", id: "1", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(true);
  });

  test("accepts a group text message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
      replyToken: "t2",
      message: { type: "text", id: "2", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(true);
  });

  test("accepts a room text message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "room", roomId: "Rroom1" },
      replyToken: "t3",
      message: { type: "text", id: "3", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(true);
  });

  test("rejects a sticker message", () => {
    const e = {
      ...base,
      type: "message",
      source: { type: "group", groupId: "Cgroup1" },
      replyToken: "t4",
      message: { type: "sticker", id: "4" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(false);
  });

  test("rejects an event with no reply token (standby mode)", () => {
    const e = {
      ...base,
      mode: "standby",
      type: "message",
      source: { type: "group", groupId: "Cgroup1" },
      message: { type: "text", id: "5", text: "98241376" },
    } as WebhookEvent;
    expect(isTextMessageEvent(e)).toBe(false);
  });
});

describe("isPostbackEvent", () => {
  test("accepts a group postback", () => {
    const e = {
      ...base,
      type: "postback",
      source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
      replyToken: "t6",
      postback: { data: "action=page&kind=wallet&id=1&page=2" },
    } as WebhookEvent;
    expect(isPostbackEvent(e)).toBe(true);
  });
});

describe("isJoinEvent and isLeaveEvent", () => {
  test("accepts a join event with a reply token", () => {
    const e = {
      ...base,
      type: "join",
      source: { type: "group", groupId: "Cgroup1" },
      replyToken: "t7",
    } as WebhookEvent;
    expect(isJoinEvent(e)).toBe(true);
    expect(isLeaveEvent(e)).toBe(false);
  });

  test("rejects a join event with no reply token", () => {
    const e = {
      ...base,
      type: "join",
      source: { type: "group", groupId: "Cgroup1" },
    } as WebhookEvent;
    expect(isJoinEvent(e)).toBe(false);
  });

  test("accepts a leave event, which never carries a reply token", () => {
    const e = {
      ...base,
      type: "leave",
      source: { type: "group", groupId: "Cgroup1" },
    } as WebhookEvent;
    expect(isLeaveEvent(e)).toBe(true);
    expect(isTextMessageEvent(e)).toBe(false);
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/line-types.test.ts
```

Expected: FAIL. `isJoinEvent` and `isLeaveEvent` do not exist, and the group and room cases return `false`.

- [x] **Step 3: Write the implementation**

Replace the whole content of `apps/api/src/types/line.types.ts` with:

```ts
export interface WebhookBody {
  destination: string;
  events: WebhookEvent[];
}

// One entry of message.mention.mentionees. `isSelf` is present only when
// `type` is "user", and it is the documented way to know the bot itself was
// mentioned.
export interface Mentionee {
  index: number;
  length: number;
  type: "user" | "all";
  userId?: string;
  isSelf?: boolean;
}

export interface WebhookEvent {
  type: string;
  mode: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  replyToken?: string;
  message?: {
    type: string;
    id: string;
    text?: string;
    mention?: { mentionees: Mentionee[] };
  };
  postback?: {
    data: string;
    params?: Record<string, string>;
  };
}

// Source is deliberately NOT narrowed to a user chat: the same handler serves
// one-on-one, group and multi-person chats. Use getChatContext() to learn
// where the event came from.
export interface TextMessageEvent extends WebhookEvent {
  type: "message";
  replyToken: string;
  message: {
    type: "text";
    id: string;
    text: string;
    mention?: { mentionees: Mentionee[] };
  };
}

export function isTextMessageEvent(
  event: WebhookEvent
): event is TextMessageEvent {
  return (
    event.type === "message" &&
    event.message != null &&
    event.message.type === "text" &&
    typeof event.message.text === "string" &&
    typeof event.replyToken === "string"
  );
}

export interface PostbackEvent extends WebhookEvent {
  type: "postback";
  replyToken: string;
  postback: {
    data: string;
    params?: Record<string, string>;
  };
}

export function isPostbackEvent(
  event: WebhookEvent
): event is PostbackEvent {
  return (
    event.type === "postback" &&
    event.postback != null &&
    typeof event.postback.data === "string" &&
    typeof event.replyToken === "string"
  );
}

// Fired when the bot is invited into a group or multi-person chat. Unlike
// `leave`, it carries a reply token.
export interface JoinEvent extends WebhookEvent {
  type: "join";
  replyToken: string;
}

export function isJoinEvent(event: WebhookEvent): event is JoinEvent {
  return event.type === "join" && typeof event.replyToken === "string";
}

// Fired when the bot is removed. No reply token, so nothing can be sent back.
export interface LeaveEvent extends WebhookEvent {
  type: "leave";
}

export function isLeaveEvent(event: WebhookEvent): event is LeaveEvent {
  return event.type === "leave";
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/line-types.test.ts
```

Expected: PASS, 9 tests.

- [x] **Step 5: Confirm the expected type break in the webhook route**

Run from `apps/api`:

```bash
bun run typecheck
```

Expected: FAIL in `src/routes/webhook.ts` with errors like `Type 'string | undefined' is not assignable to type 'string'`.
This is correct and intended: `event.source.userId` is no longer guaranteed, and Task 6 removes those reads.
Do not patch it here.
> Deviation: The expected typecheck failure did not occur; `bun run typecheck` stayed clean. `webhook.ts` already reads `event.source.userId` as `string | undefined` and early-returns when it is missing, so removing the narrowed source type breaks nothing. Nothing was patched.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/types/line.types.ts apps/api/tests/line-types.test.ts
git commit -m "feat: accept group events in line guards"
```

---

## Task 3: Bot mention helpers

`@hfm_bot 98241376` must look up `98241376`, and an unparsable group message must only get an answer when the bot was mentioned.

**Files:**
- Create: `apps/api/src/utils/mention.ts`
- Test: `apps/api/tests/mention.test.ts`

- [x] **Step 1: Write the failing test**

Create `apps/api/tests/mention.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { isBotMentioned, stripBotMention } from "../src/utils/mention";
import type { Mentionee, TextMessageEvent } from "../src/types/line.types";

function textEvent(text: string, mentionees?: Mentionee[]): TextMessageEvent {
  return {
    type: "message",
    mode: "active",
    timestamp: 1716000000000,
    source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
    replyToken: "token123",
    message: {
      type: "text",
      id: "1",
      text,
      ...(mentionees ? { mention: { mentionees } } : {}),
    },
  };
}

describe("isBotMentioned", () => {
  test("false when there is no mention at all", () => {
    expect(isBotMentioned(textEvent("สวัสดีครับ"))).toBe(false);
  });

  test("true when a mentionee is the bot", () => {
    const e = textEvent("@hfm_bot hello", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(isBotMentioned(e)).toBe(true);
  });

  test("false when only another member is mentioned", () => {
    const e = textEvent("@somchai hello", [
      { index: 0, length: 8, type: "user", userId: "Uother", isSelf: false },
    ]);
    expect(isBotMentioned(e)).toBe(false);
  });

  test("false for an @all mention, which has no isSelf", () => {
    const e = textEvent("@all hello", [{ index: 0, length: 4, type: "all" }]);
    expect(isBotMentioned(e)).toBe(false);
  });
});

describe("stripBotMention", () => {
  test("returns the trimmed text when there is no mention", () => {
    expect(stripBotMention(textEvent("  98241376  "))).toBe("98241376");
  });

  test("removes a leading bot mention", () => {
    const e = textEvent("@hfm_bot 98241376", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(stripBotMention(e)).toBe("98241376");
  });

  test("removes a trailing bot mention", () => {
    const e = textEvent("98241376 @hfm_bot", [
      { index: 9, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(stripBotMention(e)).toBe("98241376");
  });

  test("keeps mentions of other members", () => {
    const e = textEvent("@hfm_bot @somchai 98241376", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
      { index: 9, length: 8, type: "user", userId: "Uother", isSelf: false },
    ]);
    expect(stripBotMention(e)).toBe("@somchai 98241376");
  });

  test("removes two bot mentions without shifting the offsets", () => {
    const e = textEvent("@hfm_bot 98241376 @hfm_bot", [
      { index: 0, length: 8, type: "user", userId: "Ubot", isSelf: true },
      { index: 18, length: 8, type: "user", userId: "Ubot", isSelf: true },
    ]);
    expect(stripBotMention(e)).toBe("98241376");
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/mention.test.ts
```

Expected: FAIL with `Cannot find module '../src/utils/mention'`.

- [x] **Step 3: Write the implementation**

Create `apps/api/src/utils/mention.ts`:

```ts
import type { Mentionee, TextMessageEvent } from "../types/line.types";

function selfMentions(event: TextMessageEvent): Mentionee[] {
  const mentionees = event.message.mention?.mentionees ?? [];
  // `isSelf` is only set for type "user"; an @all mention must not count as
  // talking to the bot, or the bot answers every @all in the group.
  return mentionees.filter((m) => m.type === "user" && m.isSelf === true);
}

export function isBotMentioned(event: TextMessageEvent): boolean {
  return selfMentions(event).length > 0;
}

// The mention is part of message.text as a display string such as
// "@hfm_bot", so it has to be cut out by offset before the text can be
// parsed as a Wallet ID. Cutting from the end backwards keeps every
// remaining index valid.
export function stripBotMention(event: TextMessageEvent): string {
  const ordered = selfMentions(event).sort((a, b) => b.index - a.index);
  let text = event.message.text;
  for (const mention of ordered) {
    text = text.slice(0, mention.index) + text.slice(mention.index + mention.length);
  }
  return text.trim();
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/mention.test.ts
```

Expected: PASS, 9 tests.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/utils/mention.ts apps/api/tests/mention.test.ts
git commit -m "feat: add bot mention helpers"
```

---

## Task 4: Group allowlist

**Files:**
- Modify: `apps/api/src/utils/whitelist.ts:1-20`
- Test: `apps/api/tests/whitelist.test.ts` (append a new `describe`)

- [x] **Step 1: Write the failing test**

Append to `apps/api/tests/whitelist.test.ts`:

```ts
import { isGroupAllowed, isChatAllowed } from "../src/utils/whitelist";
import type { ChatContext } from "../src/utils/chat-context";

describe("isGroupAllowed", () => {
  const origIds = process.env.LINE_GROUP_WHITELIST_IDS;
  const origFlag = process.env.LINE_GROUP_WHITELIST_ENABLED;

  afterEach(() => {
    if (origIds === undefined) delete process.env.LINE_GROUP_WHITELIST_IDS;
    else process.env.LINE_GROUP_WHITELIST_IDS = origIds;
    if (origFlag === undefined) delete process.env.LINE_GROUP_WHITELIST_ENABLED;
    else process.env.LINE_GROUP_WHITELIST_ENABLED = origFlag;
  });

  test("allows every group when the list is unset", () => {
    delete process.env.LINE_GROUP_WHITELIST_IDS;
    expect(isGroupAllowed("Canygroup")).toBe(true);
  });

  test("allows every group when the list is blank", () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "   ";
    expect(isGroupAllowed("Canygroup")).toBe(true);
  });

  test("allows a listed group and rejects an unlisted one", () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1, Cgroup2";
    expect(isGroupAllowed("Cgroup1")).toBe(true);
    expect(isGroupAllowed("Cgroup2")).toBe(true);
    expect(isGroupAllowed("Cstranger")).toBe(false);
  });

  test("flag=false bypasses the group list", () => {
    process.env.LINE_GROUP_WHITELIST_ENABLED = "false";
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    expect(isGroupAllowed("Cstranger")).toBe(true);
  });
});

describe("isChatAllowed", () => {
  const origUids = process.env.LINE_WHITELIST_UIDS;
  const origIds = process.env.LINE_GROUP_WHITELIST_IDS;

  afterEach(() => {
    if (origUids === undefined) delete process.env.LINE_WHITELIST_UIDS;
    else process.env.LINE_WHITELIST_UIDS = origUids;
    if (origIds === undefined) delete process.env.LINE_GROUP_WHITELIST_IDS;
    else process.env.LINE_GROUP_WHITELIST_IDS = origIds;
  });

  test("a one-on-one chat is checked against the UID whitelist", () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed";
    const allowed: ChatContext = { chatType: "user", chatId: "Uallowed", userId: "Uallowed" };
    const denied: ChatContext = { chatType: "user", chatId: "Ustranger", userId: "Ustranger" };
    expect(isChatAllowed(allowed)).toBe(true);
    expect(isChatAllowed(denied)).toBe(false);
  });

  test("a group member is NOT checked against the UID whitelist", () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed";
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const ctx: ChatContext = { chatType: "group", chatId: "Cgroup1", userId: "Ustranger" };
    expect(isChatAllowed(ctx)).toBe(true);
  });

  test("an unlisted group is rejected whoever typed", () => {
    process.env.LINE_WHITELIST_UIDS = "Uallowed";
    process.env.LINE_GROUP_WHITELIST_IDS = "Cgroup1";
    const ctx: ChatContext = { chatType: "group", chatId: "Cother", userId: "Uallowed" };
    expect(isChatAllowed(ctx)).toBe(false);
  });

  test("a multi-person chat uses the same group list", () => {
    process.env.LINE_GROUP_WHITELIST_IDS = "Rroom1";
    const ok: ChatContext = { chatType: "room", chatId: "Rroom1", userId: null };
    const no: ChatContext = { chatType: "room", chatId: "Rroom2", userId: null };
    expect(isChatAllowed(ok)).toBe(true);
    expect(isChatAllowed(no)).toBe(false);
  });
});
```

The existing file imports only `test, expect, describe` from `bun:test`.
Change that first line to:

```ts
import { test, expect, describe, afterEach } from "bun:test";
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/whitelist.test.ts
```

Expected: FAIL with `Export named 'isGroupAllowed' not found`.

- [x] **Step 3: Write the implementation**

Replace the whole content of `apps/api/src/utils/whitelist.ts` with:

```ts
import type { ChatContext } from "./chat-context";

function isFlagOff(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  return ["false", "0", "off", "no"].includes(value);
}

function isWhitelistEnabled(): boolean {
  return !isFlagOff(process.env.LINE_WHITELIST_ENABLED);
}

function isGroupWhitelistEnabled(): boolean {
  return !isFlagOff(process.env.LINE_GROUP_WHITELIST_ENABLED);
}

function parseIdList(raw: string | undefined): string[] {
  return (raw?.trim() ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function isWhitelisted(userId: string): boolean {
  if (!isWhitelistEnabled()) return true;

  const allowed = parseIdList(process.env.LINE_WHITELIST_UIDS);
  // An empty list means "not configured yet", which stays allow-all so a
  // fresh deployment is usable.
  if (allowed.length === 0) return true;

  return allowed.includes(userId);
}

export function isGroupAllowed(chatId: string): boolean {
  if (!isGroupWhitelistEnabled()) return true;

  const allowed = parseIdList(process.env.LINE_GROUP_WHITELIST_IDS);
  if (allowed.length === 0) return true;

  return allowed.includes(chatId);
}

// In a group the group itself is the unit of trust: the request is that any
// member can look an ID up, and LINE does not even send a userId for members
// who have never used the iOS or Android app. So the per-UID whitelist is
// applied to one-on-one chats only.
export function isChatAllowed(ctx: ChatContext): boolean {
  return ctx.chatType === "user"
    ? isWhitelisted(ctx.chatId)
    : isGroupAllowed(ctx.chatId);
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/whitelist.test.ts
```

Expected: PASS. The original whitelist tests still pass unchanged, plus 8 new ones.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/utils/whitelist.ts apps/api/tests/whitelist.test.ts
git commit -m "feat: add group allowlist check"
```

---

## Task 5: Chat-aware LINE service

Three changes: the push target stops being called `userId`, the loading animation refuses group chats inside the service, and the group name can be fetched for the operator list.

**Files:**
- Modify: `apps/api/src/services/line.service.ts:8-149`
- Test: `apps/api/tests/line.service.test.ts` (append)

- [x] **Step 1: Write the failing test**

Append to `apps/api/tests/line.service.test.ts`:

```ts
import { showLoadingForChat, fetchGroupSummary } from "../src/services/line.service";
import type { ChatContext } from "../src/utils/chat-context";

describe("showLoadingForChat", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("calls the loading API for a one-on-one chat", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    const ctx: ChatContext = { chatType: "user", chatId: "Uabc123", userId: "Uabc123" };
    await showLoadingForChat(ctx);

    expect(urls).toEqual(["https://api.line.me/v2/bot/chat/loading/start"]);
  });

  test("does nothing for a group chat, which LINE rejects with 400", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    const ctx: ChatContext = { chatType: "group", chatId: "Cgroup1", userId: "Umember1" };
    await showLoadingForChat(ctx);

    expect(urls).toEqual([]);
  });

  test("does nothing for a multi-person chat", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    const ctx: ChatContext = { chatType: "room", chatId: "Rroom1", userId: null };
    await showLoadingForChat(ctx);

    expect(urls).toEqual([]);
  });
});

describe("fetchGroupSummary", () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("returns the group name", async () => {
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      expect(String(input)).toBe("https://api.line.me/v2/bot/group/Cgroup1/summary");
      return new Response(
        JSON.stringify({ groupId: "Cgroup1", groupName: "HFM VIP" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    expect(await fetchGroupSummary("Cgroup1")).toBe("HFM VIP");
  });

  test("returns null on an error response instead of throwing", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch;

    expect(await fetchGroupSummary("Cgroup1")).toBeNull();
  });

  test("returns null when the call throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    expect(await fetchGroupSummary("Cgroup1")).toBeNull();
  });
});
```

Make sure the first import line of the file includes `afterEach`:

```ts
import { test, expect, describe, afterEach } from "bun:test";
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/line.service.test.ts
```

Expected: FAIL with `Export named 'showLoadingForChat' not found`.

- [x] **Step 3: Write the implementation**

In `apps/api/src/services/line.service.ts`, add the import at the top of the file:

```ts
import type { ChatContext } from "../utils/chat-context";
```

Add the group summary constant next to the other endpoint constants (lines 3-6):

```ts
const LINE_GROUP_SUMMARY_API = "https://api.line.me/v2/bot/group";
```

Rename the push target from `userId` to `to` in `pushMessage` (line 8), because the same call now targets a user, a group, or a multi-person chat:

```ts
async function pushMessage(
  to: string,
  message: object
): Promise<void> {
  const res = await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
    signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`LINE push failed ${res.status}: ${errText}`);
    logError("line-service", err);
    throw err;
  }
}
```

Rename the same parameter in the exported push helpers (lines 93-100):

```ts
export const pushText = (to: string, text: string) =>
  pushMessage(to, { type: "text", text });

export const pushFlex = (
  to: string,
  altText: string,
  contents: object
) => pushMessage(to, { type: "flex", altText, contents });
```

Rename it in `replyOrPush` and its two wrappers (lines 114-139):

```ts
// Replies with the reply token, falling back to a push when the reply is
// rejected (expired token, LINE 4xx) so the customer is never left with
// silence. Throws only when the push fails too.
// `to` is the chat, not the sender: in a group the fallback push goes to the
// groupId, and LINE bills one message per group member, so this stays a
// fallback and never the normal path.
async function replyOrPush(
  replyToken: string,
  to: string,
  message: object
): Promise<void> {
  try {
    await replyMessage(replyToken, message);
    return;
  } catch {
    // replyMessage already logged the failure.
  }
  await pushMessage(to, message);
}

export const replyOrPushText = (
  replyToken: string,
  to: string,
  text: string
) => replyOrPush(replyToken, to, { type: "text", text });

export const replyOrPushFlex = (
  replyToken: string,
  to: string,
  altText: string,
  contents: object
) => replyOrPush(replyToken, to, { type: "flex", altText, contents });
```

Add the two new exports at the end of the file, after `pushToAll`:

```ts
// The loading animation exists only in one-on-one chats. Sending a groupId or
// roomId as chatId returns 400 "Only user id is acceptable", so the rule lives
// here and no caller can get it wrong.
export async function showLoadingForChat(ctx: ChatContext): Promise<void> {
  if (ctx.chatType !== "user") return;
  await showLoading(ctx.chatId);
}

// Group display name for the operator-facing group list. Telemetry only:
// every failure degrades to null, and there is no room equivalent of this
// endpoint.
export async function fetchGroupSummary(groupId: string): Promise<string | null> {
  try {
    const res = await fetch(`${LINE_GROUP_SUMMARY_API}/${groupId}/summary`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { groupName?: string };
    return data.groupName ?? null;
  } catch (err) {
    logError("line-service", err);
    return null;
  }
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/line.service.test.ts
```

Expected: PASS. The existing `replyOrPush` and `pushToAll` tests still pass, plus 6 new ones.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/line.service.ts apps/api/tests/line.service.test.ts
git commit -m "feat: make line service chat aware"
```

---

## Task 6: line_groups registry table

**Files:**
- Modify: `apps/api/src/db/schema.ts` (after `lineUsers`, line 57)
- Modify: `apps/api/src/db/connection.ts:20-82` (the `initDb` DDL)
- Modify: `apps/api/tests/db-helpers.ts` (drop list and DDL)
- Create: `apps/api/src/repositories/line-group.repository.ts`
- Test: `apps/api/tests/line-group.repository.test.ts`

- [x] **Step 1: Write the failing test**

Create `apps/api/tests/line-group.repository.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type postgres from "postgres";
import { createTestDb, closeTestDb } from "./db-helpers";
import type { DrizzleDb } from "../src/db/connection";
import {
  recordLineGroupEvent,
  updateLineGroupLabel,
  listLineGroups,
} from "../src/repositories/line-group.repository";

describe("line-group.repository", () => {
  let db: DrizzleDb;
  let client: postgres.Sql;

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db as unknown as DrizzleDb;
    client = created.client;
  });

  afterEach(async () => {
    await closeTestDb(client);
  });

  test("records a new group as active with one request", async () => {
    await recordLineGroupEvent(db, {
      chatId: "Cgroup1",
      chatType: "group",
      eventType: "message",
    });

    const groups = await listLineGroups(db);
    expect(groups.length).toBe(1);
    expect(groups[0]?.chat_id).toBe("Cgroup1");
    expect(groups[0]?.chat_type).toBe("group");
    expect(groups[0]?.request_count).toBe(1);
    expect(groups[0]?.last_event_type).toBe("message");
    expect(groups[0]?.active).toBe(1);
    expect(groups[0]?.label).toBeNull();
  });

  test("a second event increments the counter instead of inserting", async () => {
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "message" });
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "postback" });

    const groups = await listLineGroups(db);
    expect(groups.length).toBe(1);
    expect(groups[0]?.request_count).toBe(2);
    expect(groups[0]?.last_event_type).toBe("postback");
  });

  test("a label is stored and survives later events", async () => {
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "join" });
    await updateLineGroupLabel(db, "Cgroup1", "HFM VIP");
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "message" });

    const groups = await listLineGroups(db);
    expect(groups[0]?.label).toBe("HFM VIP");
    expect(groups[0]?.request_count).toBe(2);
  });

  test("labelling an unknown group changes nothing", async () => {
    await updateLineGroupLabel(db, "Cmissing", "Ghost");
    expect(await listLineGroups(db)).toEqual([]);
  });

  test("leave deactivates and a later join reactivates", async () => {
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "join", active: 1 });
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "leave", active: 0 });

    let groups = await listLineGroups(db);
    expect(groups[0]?.active).toBe(0);
    expect(groups[0]?.last_event_type).toBe("leave");

    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "join", active: 1 });
    groups = await listLineGroups(db);
    expect(groups[0]?.active).toBe(1);
  });

  test("a message event does not change the active flag", async () => {
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "leave", active: 0 });
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "message" });

    const groups = await listLineGroups(db);
    expect(groups[0]?.active).toBe(0);
  });

  test("groups and multi-person chats live in the same table", async () => {
    await recordLineGroupEvent(db, { chatId: "Cgroup1", chatType: "group", eventType: "message" });
    await recordLineGroupEvent(db, { chatId: "Rroom1", chatType: "room", eventType: "message" });

    const groups = await listLineGroups(db);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.chat_type).sort()).toEqual(["group", "room"]);
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/line-group.repository.test.ts
```

Expected: FAIL with `Cannot find module '../src/repositories/line-group.repository'`.

- [x] **Step 3: Add the Drizzle table**

In `apps/api/src/db/schema.ts`, insert after the `lineUsers` block (which ends at line 57):

```ts
// Registry of every group and multi-person chat the bot has been added to.
// Telemetry and an operator lookup for group IDs - never the permission
// source, so the reply path keeps working when the database is down.
export const lineGroups = pgTable("line_groups", {
  chatId: text("chat_id").primaryKey(),
  chatType: text("chat_type").notNull(),
  label: text("label"),
  firstSeenAt: timestamp("first_seen_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
  lastSeenAt: timestamp("last_seen_at", { mode: "string" })
    .notNull()
    .default(sql`now()`),
  requestCount: integer("request_count").notNull().default(1),
  lastEventType: text("last_event_type"),
  active: integer("active").notNull().default(1),
});
```

- [x] **Step 4: Add the startup DDL**

In `apps/api/src/db/connection.ts`, inside the `initDb` template literal, add after the `line_users` block:

```sql
    CREATE TABLE IF NOT EXISTS line_groups (
      chat_id         TEXT PRIMARY KEY,
      chat_type       TEXT NOT NULL,
      label           TEXT,
      first_seen_at   TIMESTAMP NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMP NOT NULL DEFAULT now(),
      request_count   INTEGER NOT NULL DEFAULT 1,
      last_event_type TEXT,
      active          INTEGER NOT NULL DEFAULT 1
    );
```

- [x] **Step 5: Add the same table to the test bootstrap**

In `apps/api/tests/db-helpers.ts`, add to the `DROP TABLE` block, as the first line inside it:

```sql
    DROP TABLE IF EXISTS line_groups CASCADE;
```

And add the identical `CREATE TABLE IF NOT EXISTS line_groups (...)` statement from Step 4 to the create block, after `line_users`.

Three test files carry their own copy of the drop list.
Add the same `DROP TABLE IF EXISTS line_groups CASCADE;` line as the first line inside the `DROP TABLE` block of each one, so rows never leak between files:

- `apps/api/tests/webhook.test.ts` (in `setupTestDb()`)
- `apps/api/tests/line-uids.test.ts` (in `setupTestDb()`)
- `apps/api/tests/health.test.ts` (inline in `beforeEach`)

All three call `initDb()` right after, so the table is recreated for them automatically.

- [x] **Step 6: Write the repository**

Create `apps/api/src/repositories/line-group.repository.ts`:

```ts
import { desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/connection";
import { lineGroups } from "../db/schema";

export interface LineGroupRow {
  chat_id: string;
  chat_type: string;
  label: string | null;
  first_seen_at: string;
  last_seen_at: string;
  request_count: number;
  last_event_type: string | null;
  active: number;
}

export interface RecordLineGroupEventParams {
  chatId: string;
  chatType: "group" | "room";
  eventType: string;
  // Only join (1) and leave (0) touch this. Message traffic leaves it alone,
  // so a stale message event cannot resurrect a group the bot has left.
  active?: number;
}

export async function recordLineGroupEvent(
  db: DrizzleDb,
  params: RecordLineGroupEventParams,
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .insert(lineGroups)
    .values({
      chatId: params.chatId,
      chatType: params.chatType,
      label: null,
      firstSeenAt: now,
      lastSeenAt: now,
      requestCount: 1,
      lastEventType: params.eventType,
      active: params.active ?? 1,
    })
    .onConflictDoUpdate({
      target: lineGroups.chatId,
      set: {
        lastSeenAt: now,
        requestCount: sql`${lineGroups.requestCount} + 1`,
        lastEventType: params.eventType,
        ...(params.active != null ? { active: params.active } : {}),
      },
    });
}

// Separate from recordLineGroupEvent so the group name, which arrives later
// and from a different API, never bumps the request counter and is never
// wiped by a message event.
export async function updateLineGroupLabel(
  db: DrizzleDb,
  chatId: string,
  label: string,
): Promise<void> {
  await db
    .update(lineGroups)
    .set({ label })
    .where(eq(lineGroups.chatId, chatId));
}

export async function listLineGroups(db: DrizzleDb): Promise<LineGroupRow[]> {
  const rows = await db
    .select()
    .from(lineGroups)
    .orderBy(desc(lineGroups.lastSeenAt));

  return rows.map((r) => ({
    chat_id: r.chatId,
    chat_type: r.chatType,
    label: r.label,
    first_seen_at: r.firstSeenAt,
    last_seen_at: r.lastSeenAt,
    request_count: r.requestCount,
    last_event_type: r.lastEventType,
    active: r.active,
  }));
}

```

- [x] **Step 7: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/line-group.repository.test.ts
```

Expected: PASS, 7 tests.

- [x] **Step 8: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/connection.ts apps/api/tests/db-helpers.ts apps/api/tests/webhook.test.ts apps/api/tests/line-uids.test.ts apps/api/tests/health.test.ts apps/api/src/repositories/line-group.repository.ts apps/api/tests/line-group.repository.test.ts
git commit -m "feat: add line_groups registry table"
```

---

## Task 7: Route group messages through the lookup path

This is the task that makes the feature work.
Every handler stops reading `event.source.userId` and takes a `ChatContext` instead.

**Files:**
- Modify: `apps/api/src/routes/webhook.ts` (whole file)
- Test: `apps/api/tests/webhook.test.ts` (new `describe` block plus three small edits)

- [x] **Step 1: Prepare the test file**

In `apps/api/tests/webhook.test.ts`:

1. Add two imports after the existing `initDb` import:

```ts
import { getDb } from "../src/db/connection";
import { listLineGroups } from "../src/repositories/line-group.repository";
```

2. Add the two group env vars to the existing top-level `afterEach`, next to `delete process.env.LINE_WHITELIST_UIDS;`:

```ts
    delete process.env.LINE_GROUP_WHITELIST_IDS;
    delete process.env.LINE_GROUP_WHITELIST_ENABLED;
```

- [x] **Step 2: Write the failing tests**

Insert this block inside `describe("webhook", ...)`, directly after the `describe("flex-v2 lookup path", ...)` block and before the closing `});` of the outer describe.
It must stay inside the outer describe so it inherits the `beforeEach` that sets up the database and env.

```ts
  describe("group chat", () => {
    const HFM_CLIENT = {
      client_id: 45219,
      account_id: 78451293,
      activity_status: "active",
      trades: 24,
      volume: 3.42,
      account_type: "Standard",
      balance: 12450.8,
      account_currency: "USD",
      equity: 12998.35,
      archived: false,
      subaffiliate: 0,
      account_regdate: "2024-01-15T00:00:00Z",
      status: "approved",
    };

    type Call = { url: string; body?: string };

    // Answers the HFM lookup with one client and every LINE endpoint with a
    // 200, recording each call so a test can assert what the bot did or did
    // not send. `replyStatus` forces the reply to fail for the push fallback.
    function mockFetch(calls: Call[], replyStatus = 200): void {
      globalThis.fetch = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1]
      ) => {
        const url = String(input);
        calls.push({
          url,
          body: typeof init?.body === "string" ? init.body : undefined,
        });

        if (url.includes("/api/performance/client-performance")) {
          return new Response(
            JSON.stringify({ clients: [HFM_CLIENT], totals: {} }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url === "https://api.line.me/v2/bot/message/reply") {
          return new Response("{}", { status: replyStatus });
        }

        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch;
    }

    async function seedLastTradeCache(): Promise<void> {
      await getLastTradeMap({
        fetchClientsFn: async () => ({
          ok: true,
          data: [
            { id: 78451293, last_trade: "2026-07-18T09:30:00Z" } as HFMClientRow,
          ],
        }),
      });
    }

    async function postEvent(
      app: Hono,
      event: Record<string, unknown>
    ): Promise<void> {
      const body = JSON.stringify({ destination: "U123", events: [event] });
      const sig = computeSig(body, SECRET);
      const res = await app.fetch(
        new Request("http://localhost/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-line-signature": sig,
          },
          body,
        })
      );
      expect(res.status).toBe(200);
    }

    function groupTextEvent(
      text: string,
      options: { replyToken?: string; mentionLength?: number } = {}
    ): Record<string, unknown> {
      return {
        type: "message",
        message: {
          type: "text",
          id: "1",
          text,
          ...(options.mentionLength
            ? {
                mention: {
                  mentionees: [
                    {
                      index: 0,
                      length: options.mentionLength,
                      type: "user",
                      userId: "Ubot",
                      isSelf: true,
                    },
                  ],
                },
              }
            : {}),
        },
        source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
        replyToken: options.replyToken ?? "tokenGroup",
        timestamp: 1716000000000,
        mode: "active",
      };
    }

    test("a wallet id from any member gets a flex reply", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(app, groupTextEvent("98241376"));

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      const reply = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/reply"
      );
      const replyBody = JSON.parse(reply?.body ?? "{}");
      expect(replyBody.replyToken).toBe("tokenGroup");
      expect(replyBody.messages[0].type).toBe("flex");
    });

    test("no loading animation is requested in a group", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(app, groupTextEvent("98241376"));

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      expect(
        calls.some((c) => c.url.endsWith("/v2/bot/chat/loading/start"))
      ).toBe(false);
    });

    test("ordinary group chatter is ignored", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(app, groupTextEvent("ไปกินข้าวกันไหมครับ"));

      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([]);
    });

    test("a mention with unusable text gets the usage help", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(
        app,
        groupTextEvent("@hfm_bot สวัสดี", { mentionLength: 8 })
      );

      await waitFor(() => calls.length >= 1);
      expect(calls[0]?.url).toBe("https://api.line.me/v2/bot/message/reply");
      const replyBody = JSON.parse(calls[0]?.body ?? "{}");
      expect(replyBody.messages[0].type).toBe("text");
      expect(replyBody.messages[0].text).toContain("Wallet ID");
    });

    test("a mention in front of a wallet id is stripped before parsing", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(
        app,
        groupTextEvent("@hfm_bot 98241376", { mentionLength: 8 })
      );

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      const reply = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/reply"
      );
      const replyBody = JSON.parse(reply?.body ?? "{}");
      expect(replyBody.messages[0].type).toBe("flex");
    });

    test("report commands are ignored in a group", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(app, groupTextEvent("report"));

      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([]);
    });

    test("a group outside the allowlist gets silence", async () => {
      process.env.LINE_GROUP_WHITELIST_IDS = "Callowed";
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(app, groupTextEvent("98241376"));

      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([]);
    });

    test("a failed reply falls back to a push addressed to the group", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls, 400);
      await seedLastTradeCache();

      await postEvent(app, groupTextEvent("98241376"));

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/push")
      );
      const push = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/push"
      );
      const pushBody = JSON.parse(push?.body ?? "{}");
      expect(pushBody.to).toBe("Cgroup1");
    });

    test("a group pagination postback replies with the next page", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(app, {
        type: "postback",
        postback: { data: "action=page&kind=wallet&id=98241376&page=1" },
        source: { type: "group", groupId: "Cgroup1", userId: "Umember1" },
        replyToken: "tokenPostback",
        timestamp: 1716000000000,
        mode: "active",
      });

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      const reply = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/reply"
      );
      const replyBody = JSON.parse(reply?.body ?? "{}");
      expect(replyBody.replyToken).toBe("tokenPostback");
      expect(replyBody.messages[0].type).toBe("flex");
    });

    test("a multi-person chat works like a group", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(app, {
        type: "message",
        message: { type: "text", id: "1", text: "98241376" },
        source: { type: "room", roomId: "Rroom1", userId: "Umember1" },
        replyToken: "tokenRoom",
        timestamp: 1716000000000,
        mode: "active",
      });

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      const reply = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/reply"
      );
      expect(JSON.parse(reply?.body ?? "{}").replyToken).toBe("tokenRoom");
    });

    test("the group is recorded in the registry", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(app, groupTextEvent("98241376"));

      const db = getDb();
      let groups = await listLineGroups(db);
      const startedAt = Date.now();
      while (groups.length === 0 && Date.now() - startedAt < 1000) {
        await new Promise((r) => setTimeout(r, 10));
        groups = await listLineGroups(db);
      }

      expect(groups.length).toBe(1);
      expect(groups[0]?.chat_id).toBe("Cgroup1");
      expect(groups[0]?.chat_type).toBe("group");
    });

    test("a one-on-one chat is not recorded as a group", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);
      await seedLastTradeCache();

      await postEvent(app, {
        type: "message",
        message: { type: "text", id: "1", text: "98241376" },
        source: { type: "user", userId: "Uabc123" },
        replyToken: "tokenDirect",
        timestamp: 1716000000000,
        mode: "active",
      });

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      expect(await listLineGroups(getDb())).toEqual([]);
    });
  });
```

- [x] **Step 3: Run the tests and confirm they fail**

Run from `apps/api`:

```bash
bun test tests/webhook.test.ts -t "group chat"
```

Expected: FAIL.
Today `isTextMessageEvent` still rejects group sources (Task 2 fixed the guard, but the route still reads `event.source.userId`), so the typecheck error from Task 2 Step 5 shows up here as a runtime or compile failure.

- [x] **Step 4: Rewrite the route**

Replace the whole content of `apps/api/src/routes/webhook.ts` with:

```ts
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
```

- [x] **Step 5: Run the group tests and confirm they pass**

Run from `apps/api`:

```bash
bun test tests/webhook.test.ts -t "group chat"
```

Expected: PASS, 12 tests.

- [x] **Step 6: Run the whole webhook suite to prove one-on-one chat did not change**

Run from `apps/api`:

```bash
bun test tests/webhook.test.ts
bun run typecheck
```

Expected: every existing test still passes and `tsc --noEmit` is silent.
The typecheck error introduced in Task 2 is now gone, because nothing reads `event.source.userId` any more.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/routes/webhook.ts apps/api/tests/webhook.test.ts
git commit -m "feat: answer lookups in group chats"
```

---

## Task 8: Handle join and leave

**Files:**
- Modify: `apps/api/src/routes/webhook.ts` (imports, dispatcher, two new handlers)
- Test: `apps/api/tests/webhook.test.ts` (new `describe` block)

- [x] **Step 1: Write the failing tests**

Insert this block inside `describe("webhook", ...)`, right after the `describe("group chat", ...)` block from Task 7:

```ts
  describe("group join and leave", () => {
    type Call = { url: string; body?: string };

    function mockFetch(calls: Call[], groupName?: string): void {
      globalThis.fetch = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1]
      ) => {
        const url = String(input);
        calls.push({
          url,
          body: typeof init?.body === "string" ? init.body : undefined,
        });

        if (url === "https://api.line.me/v2/bot/group/Cgroup1/summary") {
          return new Response(
            JSON.stringify({ groupId: "Cgroup1", groupName: groupName ?? "HFM VIP" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch;
    }

    async function postEvent(
      app: Hono,
      event: Record<string, unknown>
    ): Promise<void> {
      const body = JSON.stringify({ destination: "U123", events: [event] });
      const sig = computeSig(body, SECRET);
      const res = await app.fetch(
        new Request("http://localhost/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-line-signature": sig,
          },
          body,
        })
      );
      expect(res.status).toBe(200);
    }

    async function waitForGroups(count: number) {
      const db = getDb();
      const startedAt = Date.now();
      let groups = await listLineGroups(db);
      while (groups.length < count && Date.now() - startedAt < 1000) {
        await new Promise((r) => setTimeout(r, 10));
        groups = await listLineGroups(db);
      }
      return groups;
    }

    const joinEvent = {
      type: "join",
      source: { type: "group", groupId: "Cgroup1" },
      replyToken: "tokenJoin",
      timestamp: 1716000000000,
      mode: "active",
    };

    test("join in an allowed group replies with the usage greeting", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(app, joinEvent);

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      const reply = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/reply"
      );
      const replyBody = JSON.parse(reply?.body ?? "{}");
      expect(replyBody.replyToken).toBe("tokenJoin");
      expect(replyBody.messages[0].text).toContain("Wallet ID");
    });

    test("join records the group as active", async () => {
      const { app } = await importWebhook();
      mockFetch([]);

      await postEvent(app, joinEvent);

      const groups = await waitForGroups(1);
      expect(groups[0]?.chat_id).toBe("Cgroup1");
      expect(groups[0]?.active).toBe(1);
      expect(groups[0]?.last_event_type).toBe("join");
    });

    test("join stores the group name for the operator list", async () => {
      const { app } = await importWebhook();
      mockFetch([], "HFM VIP");

      await postEvent(app, joinEvent);

      const startedAt = Date.now();
      let groups = await waitForGroups(1);
      while (groups[0]?.label == null && Date.now() - startedAt < 1000) {
        await new Promise((r) => setTimeout(r, 10));
        groups = await listLineGroups(getDb());
      }
      expect(groups[0]?.label).toBe("HFM VIP");
    });

    test("join in a group outside the allowlist returns the group id", async () => {
      process.env.LINE_GROUP_WHITELIST_IDS = "Callowed";
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(app, joinEvent);

      await waitFor(() =>
        calls.some((c) => c.url === "https://api.line.me/v2/bot/message/reply")
      );
      const reply = calls.find(
        (c) => c.url === "https://api.line.me/v2/bot/message/reply"
      );
      const replyBody = JSON.parse(reply?.body ?? "{}");
      expect(replyBody.messages[0].text).toContain("Cgroup1");
    });

    test("leave marks the group inactive and sends nothing", async () => {
      const { app } = await importWebhook();
      const calls: Call[] = [];
      mockFetch(calls);

      await postEvent(app, {
        type: "leave",
        source: { type: "group", groupId: "Cgroup1" },
        timestamp: 1716000000000,
        mode: "active",
      });

      const groups = await waitForGroups(1);
      expect(groups[0]?.active).toBe(0);
      expect(groups[0]?.last_event_type).toBe("leave");
      expect(
        calls.some((c) => c.url.startsWith("https://api.line.me/v2/bot/message"))
      ).toBe(false);
    });
  });
```

- [x] **Step 2: Run the tests and confirm they fail**

Run from `apps/api`:

```bash
bun test tests/webhook.test.ts -t "group join and leave"
```

Expected: FAIL. `join` and `leave` events currently fall through the dispatcher, so no reply is sent and no row is written.

- [x] **Step 3: Extend the imports**

In `apps/api/src/routes/webhook.ts`, change four import lines:

```ts
import {
  replyText,
  replyTexts,
  showLoadingForChat,
  replyOrPushText,
  replyOrPushFlex,
  fetchGroupSummary,
} from "../services/line.service";
import { isTextMessageEvent, isPostbackEvent, isJoinEvent, isLeaveEvent } from "../types/line.types";
import { recordLineGroupEvent, updateLineGroupLabel } from "../repositories/line-group.repository";
import type { WebhookBody, TextMessageEvent, PostbackEvent, JoinEvent } from "../types/line.types";
```

- [x] **Step 4: Extend the dispatcher**

In the event loop, replace the closing of the postback branch:

```ts
      } else if (isPostbackEvent(event)) {
        recordGroupTraffic(db, ctx, event.type);
        const { replyToken } = event;
        processPostbackEvent(event, ctx).catch((err) => {
          logError("webhook", err);
          void notifyRetry(replyToken, ctx);
        });
      }
```

with:

```ts
      } else if (isPostbackEvent(event)) {
        recordGroupTraffic(db, ctx, event.type);
        const { replyToken } = event;
        processPostbackEvent(event, ctx).catch((err) => {
          logError("webhook", err);
          void notifyRetry(replyToken, ctx);
        });
      } else if (isJoinEvent(event)) {
        // No notifyRetry here: the retry notice is about a failed lookup and
        // would make no sense as an answer to an invite.
        processJoinEvent(event, ctx).catch((err) => logError("webhook", err));
      } else if (isLeaveEvent(event)) {
        processLeaveEvent(ctx).catch((err) => logError("webhook", err));
      }
```

- [x] **Step 5: Add the handlers**

Append to `apps/api/src/routes/webhook.ts`, directly above `export default webhook;`:

```ts
// Greeting for a group the bot may serve. Sent once, on the join event.
const GROUP_WELCOME_MESSAGE =
  "สวัสดีครับ 🙌\nพิมพ์ Wallet ID หรือ Trading Account ในกลุ่มนี้ได้เลย\nเช่น 98241376, WL-98241376, T1928491038\nพิมพ์ lot นำหน้า เพื่อดู Volume เช่น lot 98241376";

// The chat ID is the only easy way for an operator to read it, so the
// rejection notice carries it.
function groupNotRegisteredMessage(chatId: string): string {
  return `❌ กลุ่มนี้ยังไม่ได้ลงทะเบียนใช้งานบอท\nกรุณาแจ้ง Group ID นี้กับ Support: ${chatId}`;
}

async function processJoinEvent(
  event: JoinEvent,
  ctx: ChatContext,
): Promise<void> {
  // join never arrives from a one-on-one chat.
  if (ctx.chatType === "user") return;

  const db = getDb();
  await recordLineGroupEvent(db, {
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    eventType: "join",
    active: 1,
  });

  // The group name is for the operator list only, and there is no room
  // equivalent of the endpoint, so it must not hold up the welcome reply.
  if (ctx.chatType === "group") void labelGroup(db, ctx.chatId);

  if (!isChatAllowed(ctx)) {
    await replyText(event.replyToken, groupNotRegisteredMessage(ctx.chatId));
    return;
  }

  await replyText(event.replyToken, GROUP_WELCOME_MESSAGE);
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
async function processLeaveEvent(ctx: ChatContext): Promise<void> {
  if (ctx.chatType === "user") return;

  await recordLineGroupEvent(getDb(), {
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    eventType: "leave",
    active: 0,
  });
}
```

- [x] **Step 6: Run the tests and confirm they pass**

Run from `apps/api`:

```bash
bun test tests/webhook.test.ts -t "group join and leave"
bun run typecheck
```

Expected: PASS, 5 tests, and a silent typecheck.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/routes/webhook.ts apps/api/tests/webhook.test.ts
git commit -m "feat: greet groups on join and track leave"
```

---

## Task 9: Operator endpoint for group IDs

Without this there is no supported way to read a group ID, which is what `LINE_GROUP_WHITELIST_IDS` needs.

**Files:**
- Modify: `apps/api/src/routes/internal.ts:9-10, 68-81`
- Test: `apps/api/tests/line-groups-endpoint.test.ts` (create)

- [x] **Step 1: Write the failing test**

Create `apps/api/tests/line-groups-endpoint.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { initDb, getDb, resetDbForTests } from "../src/db/connection";
import { recordLineGroupEvent } from "../src/repositories/line-group.repository";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5433/hfm_test";

async function setupTestDb(): Promise<void> {
  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`DROP TABLE IF EXISTS line_groups CASCADE;`);
  await initDb(db);
  await client.end();
  resetDbForTests();
}

async function createApp(): Promise<Hono> {
  const internalMod = await import("../src/routes/internal");
  const app = new Hono();
  app.route("/internal", internalMod.default);
  return app;
}

describe("GET /internal/line-groups", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INTERNAL_API_KEY = "test_key";
    await setupTestDb();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  test("returns 401 without the API key", async () => {
    const app = await createApp();
    const res = await app.fetch(
      new Request("http://localhost/internal/line-groups?key=wrong")
    );
    expect(res.status).toBe(401);
  });

  test("returns an empty list when the bot is in no group", async () => {
    const app = await createApp();
    const res = await app.fetch(
      new Request("http://localhost/internal/line-groups?key=test_key")
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { count: number; groups: unknown[] };
    expect(json.count).toBe(0);
    expect(json.groups).toEqual([]);
  });

  test("returns the recorded groups", async () => {
    const db = getDb();
    await recordLineGroupEvent(db, {
      chatId: "Cgroup1",
      chatType: "group",
      eventType: "join",
    });

    const app = await createApp();
    const res = await app.fetch(
      new Request("http://localhost/internal/line-groups?key=test_key")
    );
    const json = (await res.json()) as {
      count: number;
      groups: Array<{ chat_id: string; chat_type: string; active: number }>;
    };
    expect(json.count).toBe(1);
    expect(json.groups[0]?.chat_id).toBe("Cgroup1");
    expect(json.groups[0]?.chat_type).toBe("group");
    expect(json.groups[0]?.active).toBe(1);
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run from `apps/api`:

```bash
bun test tests/line-groups-endpoint.test.ts
```

Expected: FAIL. The route does not exist, so the request returns 404 instead of 200.

- [x] **Step 3: Write the implementation**

In `apps/api/src/routes/internal.ts`, add the import next to the existing repository import:

```ts
import { listLineGroups } from "../repositories/line-group.repository";
```

Add the cap next to `MAX_LINE_UIDS` (line 10):

```ts
const MAX_LINE_GROUPS = 200;
```

Add the route after the `/line-uids` handler, before `export default internal;`:

```ts
// Operator lookup: a group ID is not visible anywhere in the LINE app, and
// LINE_GROUP_WHITELIST_IDS needs it.
internal.get("/line-groups", async (c) => {
  const db = getDb();
  const groups = await listLineGroups(db);
  const truncated = groups.length > MAX_LINE_GROUPS;
  return c.json({
    count: Math.min(groups.length, MAX_LINE_GROUPS),
    truncated,
    groups: groups.slice(0, MAX_LINE_GROUPS),
  });
});
```

- [x] **Step 4: Run the test and confirm it passes**

Run from `apps/api`:

```bash
bun test tests/line-groups-endpoint.test.ts
```

Expected: PASS, 3 tests.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/internal.ts apps/api/tests/line-groups-endpoint.test.ts
git commit -m "feat: list line groups for operators"
```

---

## Task 10: Document the feature

**Files:**
- Modify: `apps/api/.env.example`
- Modify: `AGENTS.md` (repo root)

- [x] **Step 1: Add the env template entries**

In `apps/api/.env.example`, add directly under `LINE_WHITELIST_UIDS=`:

```bash
# Group chat access. The bot answers Wallet ID and Trading Account lookups
# from any member of a group it has been invited to.
# Empty list = every group is allowed (same rule as LINE_WHITELIST_UIDS).
# Fill it with comma separated group or room IDs to lock the bot down; read
# the IDs from GET /internal/line-groups?key=<INTERNAL_API_KEY>.
LINE_GROUP_WHITELIST_ENABLED=true
LINE_GROUP_WHITELIST_IDS=
```

- [x] **Step 2: Document the behaviour in AGENTS.md**

In `AGENTS.md`, inside the "Architecture Rules (apps/api)" section, add these bullets after the LINE reply-token bullet:

```markdown
- The bot serves one-on-one chats, group chats, and multi-person chats. Every handler works from the `ChatContext` (`chatType`, `chatId`, `userId`) built by `src/utils/chat-context.ts`, never from `event.source.userId`: LINE omits `userId` for group members who have never used the iOS or Android app.
- Group rules: the whole group is authorized by `LINE_GROUP_WHITELIST_IDS` (an empty list allows every group), report commands stay one-on-one, an unparsed group message is answered only when the bot is mentioned, and the loading animation is skipped because LINE rejects it outside one-on-one chats.
```

In the "Environment & Security" section, add the two new vars to the secrets and settings list:

```markdown
- Group access is controlled by `LINE_GROUP_WHITELIST_ENABLED` and `LINE_GROUP_WHITELIST_IDS`; group IDs are listed by `GET /internal/line-groups`.
```

- [x] **Step 3: Commit**

```bash
git add apps/api/.env.example AGENTS.md
git commit -m "docs: document group chat support"
```

---

## Task 11: Full verification

- [ ] **Step 1: Run the whole suite**

Run from `apps/api`:

```bash
bun test
```

Expected: every test passes, including the untouched one-on-one tests.

- [ ] **Step 2: Typecheck**

Run from `apps/api`:

```bash
bun run typecheck
```

Expected: no output.

- [ ] **Step 3: Confirm the table lands on a real database**

Run from `apps/api` against a scratch database, never a production one:

```bash
bun run db:push
```

Expected: drizzle-kit reports `line_groups` as the only new table.
A production deployment does not need this step, because `initDb()` runs the same `CREATE TABLE IF NOT EXISTS` on startup.

- [ ] **Step 4: Manual end-to-end check in a real LINE group**

Do these in order, with the server running and the webhook reachable:

1. Confirm **Allow bot to join group chats** is on (Prerequisite P1).
2. Create a test group, add one other person, and invite the bot.
   Expected: the greeting message appears once.
3. Send `98241376` from the **other person's** account, not yours.
   Expected: the same Flex card as in a one-on-one chat, and no loading animation.
4. Send an ordinary sentence such as `ไปกินข้าวกัน`.
   Expected: no reply at all.
5. Send `@<bot name> hello`.
   Expected: the usage help.
6. Send `@<bot name> 98241376`.
   Expected: the Flex card.
7. Send `report`.
   Expected: no reply in the group. Then send `report` in a one-on-one chat and confirm the report still arrives.
8. If the wallet has more than 5 accounts, tap the pagination button.
   Expected: page 2 renders.
9. Call `GET /internal/line-groups?key=<INTERNAL_API_KEY>`.
   Expected: the group appears with its name and `active: 1`.
10. Remove the bot from the group, then call the endpoint again.
    Expected: `active: 0`.
11. Set `LINE_GROUP_WHITELIST_IDS` to some other ID, restart, and send a lookup in the test group.
    Expected: silence.

- [ ] **Step 5: Commit the plan completion**

```bash
git add docs/plans/2026-09-17-line-group-chat-support.md
git commit -m "docs: mark group chat plan complete"
```

---

## Rollback

The feature is additive and env-gated at two levels:

- Set `LINE_GROUP_WHITELIST_IDS` to a single unused ID to silence every real group without a deploy.
- Turn off **Allow bot to join group chats** in the LINE console to stop group events at the source.
- A full revert is `git revert` of the Task 7 and Task 8 commits; `line_groups` can stay, it is unused by the one-on-one path.

---

## Self-Review Notes

Checked while writing:

- **Spec coverage.** "Invite the bot into a group" is Task 8. "Anyone in the group can type a Wallet ID or Trading Account number" is Task 4 (D1) plus Task 7. "The bot replies with the same Flex card as in a one-on-one chat" is Task 7, which reuses `handleLookupAndReply` untouched, so the card, pagination, `lot` prefix, and flex-v2 behaviour are identical by construction.
- **Type consistency.** `ChatContext` is `{chatType, chatId, userId}` everywhere. `recordLineGroupEvent(db, {chatId, chatType, eventType, active?})` and `updateLineGroupLabel(db, chatId, label)` keep the same signatures in Tasks 6, 7, 8, and 9. `showLoadingForChat(ctx)` takes the context, `fetchGroupSummary(groupId)` takes a raw ID.
- **Known gap, deliberate.** `memberJoined` and `memberLeft` are not handled; nothing in the request needs them.
- **Known gap, deliberate.** There is no group-level rate limit. A group that spams IDs costs HFM calls, and reply messages are free, so this can wait for evidence that it is a real problem.
