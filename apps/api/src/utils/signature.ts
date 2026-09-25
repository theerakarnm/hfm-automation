import { createHmac, timingSafeEqual } from "node:crypto";

// Stays on node:crypto on Cloudflare Workers by choice. At compatibility_date
// 2026-09-22 nodejs_compat is on by default and Cloudflare supports all of
// node:crypto except DSA/DH key generation, argon2, ed448/x448 and FIPS
// toggling, so createHmac, timingSafeEqual and Buffer all work as they do on
// Bun. The WebCrypto alternative, crypto.subtle.sign, is async only, which
// would turn this synchronous guard into a Promise and change every caller,
// and WebCrypto has no synchronous constant-time compare to replace
// timingSafeEqual.
export function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string
): boolean {
  const digest = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  try {
    // Throws when the two buffers differ in length, which is exactly the
    // "signature is garbage" case, so the catch answers false.
    return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}
