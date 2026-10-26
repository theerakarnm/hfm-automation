import { test, expect, describe } from "bun:test";
import { cronJobName, CRON_JOBS } from "../src/jobs";

describe("cron dispatch", () => {
  test("maps the five minute schedule to the health check", () => {
    expect(cronJobName("*/5 * * * *")).toBe("hfm-healthcheck");
  });

  test("maps the daily scan schedule (00:30 Bangkok is 17:30 UTC)", () => {
    expect(cronJobName("30 17 * * *")).toBe("daily-scan");
  });

  // The daily client report cron was removed on purpose in commit 96e6a0e.
  test("still does not schedule the daily client report", () => {
    expect(cronJobName("0 1 * * *")).toBeNull();
    expect(cronJobName("0 22 * * *")).toBeNull();
    expect(Object.values(CRON_JOBS)).toEqual(["hfm-healthcheck", "daily-scan"]);
  });

  test("returns null for an unknown schedule", () => {
    expect(cronJobName("7 7 7 7 7")).toBeNull();
  });
});
