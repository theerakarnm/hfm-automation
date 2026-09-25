import { expect, test, describe, afterEach } from "bun:test";
import {
  fetchPerformance,
  fetchClients,
  fetchAllClients,
  fetchClientsByRange,
} from "../src/services/hfm.service";

const ORIGINAL_FETCH = globalThis.fetch;

// AbortSignal.timeout() aborts with a DOMException named "TimeoutError". This
// is what the Workers runtime and Bun both throw, so every HFM call must map
// it to the "timeout" reason instead of the generic server error.
function timingOutFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as typeof globalThis.fetch;
}

describe("HFM timeouts are reported as timeouts", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("fetchPerformance maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchPerformance({ kind: "wallet", id: 1, label: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchClients maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchClients(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchAllClients maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchAllClients(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  test("fetchClientsByRange maps TimeoutError to timeout", async () => {
    globalThis.fetch = timingOutFetch();
    const result = await fetchClientsByRange("2026-09-01", "2026-09-22", 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });
});
