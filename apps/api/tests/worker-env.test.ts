import { test, expect, afterEach } from "bun:test";
import { assertProcessEnvPopulated, type WorkerEnv } from "../src/config/env";

const originalTenant = process.env.TENANT;

afterEach(() => {
  if (originalTenant === undefined) delete process.env.TENANT;
  else process.env.TENANT = originalTenant;
});

test("passes when process.env mirrors the bindings", () => {
  process.env.TENANT = "maow";
  expect(() =>
    assertProcessEnvPopulated({ TENANT: "maow" } as WorkerEnv),
  ).not.toThrow();
});

test("throws when process.env is empty", () => {
  delete process.env.TENANT;
  expect(() =>
    assertProcessEnvPopulated({ TENANT: "maow" } as WorkerEnv),
  ).toThrow("process.env is not populated");
});

test("throws when process.env holds another tenant", () => {
  process.env.TENANT = "simple-trade";
  expect(() =>
    assertProcessEnvPopulated({ TENANT: "maow" } as WorkerEnv),
  ).toThrow("process.env is not populated");
});
