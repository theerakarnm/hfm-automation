import { test, expect, describe } from "bun:test";
import { cronJobName, CRON_JOBS } from "../src/jobs";

describe("cron dispatch", () => {
  test("maps the five minute schedule to the health check", () => {
    expect(cronJobName("*/5 * * * *")).toBe("hfm-healthcheck");
  });

  // The daily report cron was removed on purpose in commit 96e6a0e.
  test("does not schedule the daily client report", () => {
    expect(cronJobName("0 1 * * *")).toBeNull();
    expect(cronJobName("0 22 * * *")).toBeNull();
    expect(Object.values(CRON_JOBS)).toEqual(["hfm-healthcheck"]);
  });

  test("returns null for an unknown schedule", () => {
    expect(cronJobName("7 7 7 7 7")).toBeNull();
  });
});
