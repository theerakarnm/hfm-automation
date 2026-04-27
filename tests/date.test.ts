import { expect, test } from "bun:test";
import { getIctDateString, getPreviousIctDateString, formatIctDisplayDate } from "../src/utils/date";

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
