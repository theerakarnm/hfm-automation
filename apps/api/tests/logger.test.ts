import { expect, test } from "bun:test";
import { parseLog } from "../src/utils/logger";

test("parseLog formats pino timestamp with dayjs", () => {
  const line = JSON.stringify({ time: 1716000000000, level: 30, context: "test", msg: "hello" });
  const entries = parseLog(line);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.timestamp).toBe("2024-05-18 02:40:00.000");
  expect(entries[0]!.level).toBe("info");
  expect(entries[0]!.context).toBe("test");
  expect(entries[0]!.message).toBe("hello");
});

test("parseLog handles multiple lines", () => {
  const content = [
    JSON.stringify({ time: 1716000000000, level: 30, msg: "first" }),
    JSON.stringify({ time: 1716000001000, level: 40, msg: "second" }),
  ].join("\n");
  const entries = parseLog(content);
  expect(entries).toHaveLength(2);
  expect(entries[0]!.message).toBe("first");
  expect(entries[1]!.message).toBe("second");
});

test("parseLog skips unparseable lines", () => {
  const entries = parseLog("not json\nalso not json");
  expect(entries).toHaveLength(0);
});
