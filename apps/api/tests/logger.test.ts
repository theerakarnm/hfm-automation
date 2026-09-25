import { afterEach, beforeEach, expect, test } from "bun:test";
import * as loggerMod from "../src/utils/logger";
import { logError, logInfo, logWarn, logger } from "../src/utils/logger";

const ORIGINAL_LOG = console.log;
const ORIGINAL_ERROR = console.error;

let out: Record<string, unknown>[] = [];
let err: Record<string, unknown>[] = [];

beforeEach(() => {
  out = [];
  err = [];
  console.log = (line: unknown) => {
    out.push(line as Record<string, unknown>);
  };
  console.error = (line: unknown) => {
    err.push(line as Record<string, unknown>);
  };
  process.env.TENANT = "maow";
  delete process.env.LOG_LEVEL;
});

afterEach(() => {
  console.log = ORIGINAL_LOG;
  console.error = ORIGINAL_ERROR;
  delete process.env.TENANT;
  delete process.env.LOG_LEVEL;
});

test("logInfo emits one structured object on console.log", () => {
  logInfo("webhook", { eventId: "abc", durationMs: 12 }, "handled");

  expect(out).toHaveLength(1);
  expect(err).toHaveLength(0);
  const line = out[0]!;
  expect(line.level).toBe("info");
  expect(line.context).toBe("webhook");
  expect(line.eventId).toBe("abc");
  expect(line.durationMs).toBe(12);
  expect(line.msg).toBe("handled");
  expect(typeof line.time).toBe("number");
});

test("every line carries the tenant field", () => {
  logInfo("webhook", { eventId: "abc" }, "handled");
  logWarn("webhook", { eventId: "abc" }, "slow");
  logError("webhook", new Error("boom"));

  const all = [...out, ...err];
  expect(all).toHaveLength(3);
  for (const line of all) {
    expect(line.tenant).toBe(process.env.TENANT ?? "unknown");
    expect(Object.keys(line)).toContain("tenant");
  }
});

test("logWarn and logError go to console.error", () => {
  logWarn("hfm", { clientId: 1 }, "retry");
  logError("hfm", new Error("boom"));

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(2);
  expect(err[0]!.level).toBe("warn");
  expect(err[1]!.level).toBe("error");
});

test("logError keeps the message and the stack in msg", () => {
  const error = new Error("boom");
  logError("hfm", error);

  expect(err).toHaveLength(1);
  expect(String(err[0]!.msg)).toContain("boom");
  expect(String(err[0]!.msg)).toContain(error.stack!);
});

test("logError stringifies a non-Error throw", () => {
  logError("hfm", "plain string failure");

  expect(err).toHaveLength(1);
  expect(err[0]!.msg).toBe("plain string failure");
});

test("debug is dropped at the default info level", () => {
  logger.debug({ context: "boot" }, "verbose");

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(0);
});

test("LOG_LEVEL=warn drops info and keeps warn", () => {
  process.env.LOG_LEVEL = "warn";

  logInfo("webhook", { eventId: "abc" }, "handled");
  logWarn("webhook", { eventId: "abc" }, "slow");

  expect(out).toHaveLength(0);
  expect(err).toHaveLength(1);
  expect(err[0]!.level).toBe("warn");
});

test("LOG_LEVEL=debug lets debug through", () => {
  process.env.LOG_LEVEL = "debug";

  logger.debug({ context: "boot" }, "verbose");

  expect(out).toHaveLength(1);
  expect(out[0]!.level).toBe("debug");
});

test("an unknown LOG_LEVEL falls back to info", () => {
  process.env.LOG_LEVEL = "loud";

  logger.debug({ context: "boot" }, "verbose");
  logInfo("webhook", { eventId: "abc" }, "handled");

  expect(out).toHaveLength(1);
  expect(out[0]!.level).toBe("info");
});

test("logger.warn stays reassignable for the flex builder test", () => {
  const original = logger.warn;
  const seen: string[] = [];
  logger.warn = (_o: object, m?: string) => {
    seen.push(m ?? "");
  };
  try {
    logger.warn({ context: "flex-version" }, "replaced");
  } finally {
    logger.warn = original;
  }
  expect(seen).toEqual(["replaced"]);
});

test("the filesystem log readers are gone", () => {
  expect("readLog" in loggerMod).toBe(false);
  expect("parseLog" in loggerMod).toBe(false);
  expect("listLogDates" in loggerMod).toBe(false);
});
