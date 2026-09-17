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
