import { expect, test } from "bun:test";
import { getIctDateString, getPreviousIctDateString, formatIctDisplayDate, formatShortDate, getThisWeekRange, getLastWeekRange, getThisMonthRange, getLastMonthRange } from "../src/utils/date";

test("ICT date uses Asia/Bangkok instead of UTC", () => {
  const utcPreviousDay = new Date("2026-04-25T22:00:00.000Z");
  expect(getIctDateString(utcPreviousDay)).toBe("2026-04-26");
});

test("previous ICT date subtracts one local calendar day", () => {
  const runTime = new Date("2026-04-25T22:00:00.000Z");
  expect(getPreviousIctDateString(runTime)).toBe("2026-04-25");
});

test("display date is DD/MM/YYYY", () => {
  expect(formatIctDisplayDate("2026-04-26")).toBe("26/04/2026");
});

test("ICT date at midnight Bangkok is correct", () => {
  const midnightIct = new Date("2026-04-25T17:00:00.000Z");
  expect(getIctDateString(midnightIct)).toBe("2026-04-26");
});

test("previous ICT date wraps across month boundary", () => {
  const runTime = new Date("2026-05-01T22:00:00.000Z");
  expect(getPreviousIctDateString(runTime)).toBe("2026-05-01");
  expect(getPreviousIctDateString(runTime)).not.toBe("2026-05-02");
});

test("this week range starts on Monday — Thursday", () => {
  const now = new Date("2026-04-29T22:00:00.000Z");
  const range = getThisWeekRange(now);
  expect(range.from).toBe("2026-04-27");
  expect(range.to).toBe("2026-04-30");
});

test("this week range starts on Monday — Monday itself", () => {
  const now = new Date("2026-04-26T22:00:00.000Z");
  const range = getThisWeekRange(now);
  expect(range.from).toBe("2026-04-27");
  expect(range.to).toBe("2026-04-27");
});

test("last week range is previous Monday to Sunday", () => {
  const now = new Date("2026-04-29T22:00:00.000Z");
  const range = getLastWeekRange(now);
  expect(range.from).toBe("2026-04-20");
  expect(range.to).toBe("2026-04-26");
});

test("this month range is first of month to today", () => {
  const now = new Date("2026-04-29T22:00:00.000Z");
  const range = getThisMonthRange(now);
  expect(range.from).toBe("2026-04-01");
  expect(range.to).toBe("2026-04-30");
});

test("last month range is full previous month", () => {
  const now = new Date("2026-04-29T22:00:00.000Z");
  const range = getLastMonthRange(now);
  expect(range.from).toBe("2026-03-01");
  expect(range.to).toBe("2026-03-31");
});

test("last month range wraps year boundary", () => {
  const now = new Date("2026-01-15T22:00:00.000Z");
  const range = getLastMonthRange(now);
  expect(range.from).toBe("2025-12-01");
  expect(range.to).toBe("2025-12-31");
});

test("this month range on first day of month", () => {
  const now = new Date("2026-04-01T22:00:00.000Z");
  const range = getThisMonthRange(now);
  expect(range.from).toBe("2026-04-01");
  expect(range.to).toBe("2026-04-02");
});

test("formatShortDate formats as DD/MM/YY", () => {
  expect(formatShortDate("2026-04-26")).toBe("26/04/26");
});

test("formatShortDate returns input on invalid date", () => {
  expect(formatShortDate("not-a-date")).toBe("not-a-date");
});

test("formatIctDisplayDate throws on invalid input", () => {
  expect(() => formatIctDisplayDate("invalid")).toThrow();
});
