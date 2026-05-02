import { test, expect } from "bun:test";
import { verifyLineSignature } from "../src/utils/signature";
import { createHmac } from "node:crypto";

const SECRET = "test_channel_secret";
const BODY = '{"destination":"U123","events":[]}';

function computeSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

test("valid HMAC signature returns true", () => {
  const sig = computeSig(BODY, SECRET);
  expect(verifyLineSignature(BODY, sig, SECRET)).toBe(true);
});

test("invalid signature returns false", () => {
  expect(verifyLineSignature(BODY, "invalid_signature", SECRET)).toBe(false);
});

test("wrong secret returns false", () => {
  const sig = computeSig(BODY, SECRET);
  expect(verifyLineSignature(BODY, sig, "wrong_secret")).toBe(false);
});

test("length-mismatched signature returns false without throwing", () => {
  expect(verifyLineSignature(BODY, "short", SECRET)).toBe(false);
});

test("empty signature returns false", () => {
  expect(verifyLineSignature(BODY, "", SECRET)).toBe(false);
});
