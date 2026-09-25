/**
 * Repairs the global types that @cloudflare/workers-types corrupts when it is
 * loaded alongside bun-types ("types": ["@cloudflare/workers-types", "bun"]).
 *
 * workers-types re-declares the whole web platform globally (class Blob,
 * declare const Buffer: any, ...). skipLibCheck silences the resulting
 * duplicate-declaration conflicts inside the .d.ts files, but a few merged
 * globals come out missing members that only bun-types declares. This file
 * adds those members back, verbatim from bun-types:
 *
 * - Blob.json(), Blob.formData(), Blob.image(): dropped by the class merge.
 *   scripts/ reads JSON through Bun.file(...).json().
 * - Buffer.toString(encoding?, start?, end?): workers-types declares
 *   `const Buffer: any`, which collapses the merged overload set to zero
 *   arguments. src/utils/logger.ts reads log tails with toString("utf-8").
 *
 * If a future workers-types or bun-types release drops more members, extend
 * this file instead of weakening the tsconfig.
 */
declare global {
  interface Blob {
    json(): Promise<any>;
    formData(): Promise<FormData>;
    image(options?: Bun.Image.ConstructorOptions): Bun.Image;
  }

  interface Buffer {
    toString(
      encoding?: import("node:buffer").BufferEncoding,
      start?: number,
      end?: number,
    ): string;
  }
}

export {};
