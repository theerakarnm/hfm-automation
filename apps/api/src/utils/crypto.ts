// apps/api/src/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Key rotation: bump this when a new CONFIG_ENCRYPTION_KEY is introduced,
// keep decrypt support for old versions in decryptSecret.
export const CURRENT_KEY_VERSION = 1;

// AES-256-GCM needs exactly a 32 byte key and a 12 byte IV.
// Ciphertext format: "<ivB64>.<authTagB64>.<cipherB64>".
const IV_BYTES = 12;

export function loadEncryptionKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is not set. Generate one with: " +
        "bun -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `CONFIG_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}`,
    );
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadEncryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected iv.tag.ct");
  }
  const [iv, tag, ct] = parts as [string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadEncryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Auth failure means tampering or the wrong CONFIG_ENCRYPTION_KEY.
    // Never return partial plaintext.
    throw new Error(
      "Decryption failed: ciphertext is tampered or CONFIG_ENCRYPTION_KEY changed",
    );
  }
}

// The UI shows this instead of a secret. First 4 and last 4 characters only.
export function maskSecret(plain: string): string {
  if (plain.length <= 4) return plain.slice(0, 1) + "**";
  if (plain.length <= 8) return plain.slice(0, 4) + "...";
  return `${plain.slice(0, 4)}...${plain.slice(-4)}`;
}
