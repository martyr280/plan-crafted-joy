import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetch is stubbed per test: no Samsara call ever leaves the process.
describe("10. Samsara per-request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("SAMSARA_API_TOKEN", "test-token-not-real");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("aborts a hung request after 12 s with a clear error", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { samsaraApi, SAMSARA_REQUEST_TIMEOUT_MS } = await import("@/lib/samsara/hos.server");
    expect(SAMSARA_REQUEST_TIMEOUT_MS).toBe(12_000);
    const p = samsaraApi("/fleet/drivers");
    const assertion = expect(p).rejects.toThrow("Samsara request timed out after 12s on /fleet/drivers");
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries 429 with backoff and then succeeds", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : new Response(JSON.stringify({ ok: 1 }), { status: 200 }))),
    );
    const { samsaraApi } = await import("@/lib/samsara/hos.server");
    const p = samsaraApi("/fleet/drivers");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(n).toBe(2);
  });
});
