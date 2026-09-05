// apps/api/tests/crypto.test.ts
import { test, describe, expect, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  loadEncryptionKey,
  CURRENT_KEY_VERSION,
} from "../src/utils/crypto";

const KEY_32 = Buffer.alloc(32, 7).toString("base64");

describe("crypto", () => {
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = KEY_32;
  });

  test("loadEncryptionKey returns the 32 byte key", () => {
    expect(loadEncryptionKey().length).toBe(32);
  });

  test("encryptSecret then decryptSecret round trips", () => {
    const enc = encryptSecret("my-secret-token");
    expect(enc).not.toContain("my-secret-token");
    expect(enc.split(".")).toHaveLength(3);
    expect(decryptSecret(enc)).toBe("my-secret-token");
  });

  test("same plaintext encrypts differently every time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("tampered ciphertext throws", () => {
    const enc = encryptSecret("my-secret-token");
    const [iv, tag, ct] = enc.split(".");
    const flipped = ct!.slice(0, -2) + (ct!.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(`${iv}.${tag}.${flipped}`)).toThrow();
  });

  test("wrong key throws instead of returning garbage", () => {
    const enc = encryptSecret("my-secret-token");
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptSecret(enc)).toThrow();
  });

  test("maskSecret never reveals the middle", () => {
    const masked = maskSecret("abcdefghijklmnop");
    expect(masked).toBe("abcd...mnop");
    expect(masked).not.toContain("efgh");
  });

  test("maskSecret handles short values", () => {
    expect(maskSecret("abc")).toBe("a**");
  });

  test("CURRENT_KEY_VERSION is 1", () => {
    expect(CURRENT_KEY_VERSION).toBe(1);
  });

  test("missing env throws a clear error", () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(() => loadEncryptionKey()).toThrow(/CONFIG_ENCRYPTION_KEY/);
  });

  test("short env value throws a clear error", () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadEncryptionKey()).toThrow(/32 bytes/);
  });
});
