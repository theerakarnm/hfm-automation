import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Workers allow only 6 outbound connections to wait for response headers at
// once, so an unbounded Promise.all over fetch is a silent queue, not
// parallelism. There is none in src/ today and this test keeps it that way.
// A future bounded fan-out must go through a helper with an explicit limit.
test("src/ has no unbounded Promise.all fan-out", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("Promise.all(") || line.includes("Promise.allSettled(")) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
