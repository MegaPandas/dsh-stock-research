import { afterEach, describe, expect, it, vi } from "vitest";
import { getHttpRequestMetadata, HttpClient } from "../../src/data/http.js";

const clients: HttpClient[] = [];

function setup(timeoutMs = 1_000, maxConcurrency = 3) {
  vi.useFakeTimers();
  const starts: Array<{ url: string; at: number }> = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) => {
      starts.push({ url: String(url), at: performance.now() });
      return new Response("ok");
    });
  const http = new HttpClient({
    timeoutMs,
    maxConcurrency,
    minIntervalMs: 100,
  });
  clients.push(http);
  return { http, fetch, starts };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((http) => http.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HTTP request pacing", () => {
  it("shares pacing across calls for one source with independent source schedules", async () => {
    const { http, starts } = setup();
    const work = [
      http.forSource("a").getText("https://source.invalid/a1"),
      http.forSource("a").getText("https://source.invalid/a2"),
      http.forSource("b").getText("https://source.invalid/b1"),
    ];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(work);
    expect(starts).toEqual([
      { url: "https://source.invalid/a1", at: 0 },
      { url: "https://source.invalid/b1", at: 0 },
      { url: "https://source.invalid/a2", at: 100 },
    ]);
  });

  it("adds request diagnostics without changing a network error or caller reason", async () => {
    const { http, fetch } = setup();
    const cause = new Error("socket failed");
    const error = new TypeError("fetch failed", { cause });
    fetch.mockRejectedValueOnce(error);
    await expect(
      http.postText("https://source.invalid/data?api_key=secret"),
    ).rejects.toBe(error);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("fetch failed");
    expect(getHttpRequestMetadata(error)).toEqual({
      url: "https://source.invalid/data",
      method: "POST",
    });
    const reason = new Error("caller stopped", { cause });
    const signal = AbortSignal.abort(reason);
    await expect(
      http.getText("https://source.invalid/data", { signal }),
    ).rejects.toBe(reason);
    expect(getHttpRequestMetadata(reason)).toBeUndefined();
    expect(reason.cause).toBe(cause);
  });
  it("paces source POST queries in the same queue as GET requests", async () => {
    const { http, fetch, starts } = setup();
    const work = [
      http.getText("https://source.invalid/first"),
      http.postText("https://source.invalid/statistics"),
      http.getText("https://source.invalid/last"),
    ];
    await vi.advanceTimersByTimeAsync(200);
    await expect(Promise.all(work)).resolves.toEqual(["ok", "ok", "ok"]);
    expect(starts.map((item) => item.at)).toEqual([0, 100, 200]);
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });
  it("rejects invalid intervals at configuration entry", () => {
    for (const minIntervalMs of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
      expect(
        () =>
          new HttpClient({ timeoutMs: 1000, maxConcurrency: 1, minIntervalMs }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("spaces a burst across origins even when earlier requests finish immediately", async () => {
    const { http, starts } = setup();
    const urls = [
      "https://first.invalid/1",
      "https://second.invalid/2",
      "https://first.invalid/3",
    ];
    const results = urls.map((url) => http.getText(url));
    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toEqual([{ url: urls[0], at: 0 }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([
      { url: urls[0], at: 0 },
      { url: urls[1], at: 100 },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toEqual([
      { url: urls[0], at: 0 },
      { url: urls[1], at: 100 },
      { url: urls[2], at: 200 },
    ]);
    await expect(Promise.all(results)).resolves.toEqual(["ok", "ok", "ok"]);
  });

  it("does not accumulate burst credits while idle", async () => {
    const { http, starts } = setup();
    await http.getText("https://source.invalid/first");
    await vi.advanceTimersByTimeAsync(1000);
    const second = http.getText("https://source.invalid/second");
    const third = http.getText("https://source.invalid/third");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([second, third]);
    expect(starts.map(({ at }) => at)).toEqual([0, 1000, 1100]);
  });

  it("keeps the concurrency bound when the pacing delay has elapsed", async () => {
    const { http, fetch, starts } = setup(1000, 2);
    const replies: Array<(response: Response) => void> = [];
    fetch.mockImplementation((url) => {
      starts.push({ url: String(url), at: performance.now() });
      if (starts.length <= 2)
        return new Promise<Response>((resolve) => replies.push(resolve));
      return Promise.resolve(new Response("ok"));
    });
    const results = ["first", "second", "third", "fourth"].map((path) =>
      http.getText(`https://source.invalid/${path}`),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(starts.map(({ at }) => at)).toEqual([0, 100]);
    replies[0]!(new Response("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts.map(({ at }) => at)).toEqual([0, 100, 300]);
    await vi.advanceTimersByTimeAsync(100);
    replies[1]!(new Response("second"));
    await expect(Promise.all(results)).resolves.toEqual([
      "first",
      "second",
      "ok",
      "ok",
    ]);
    expect(starts.map(({ at }) => at)).toEqual([0, 100, 300, 400]);
  });

  it("cancels a paced request without consuming the next start", async () => {
    const { http, starts } = setup();
    await http.getText("https://source.invalid/first");
    const controller = new AbortController();
    const reason = new Error("cancel queued fetch");
    const rejected = expect(
      http.getText("https://source.invalid/cancelled", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    const next = http.getText("https://source.invalid/next");
    await vi.advanceTimersByTimeAsync(50);
    controller.abort(reason);
    await rejected;
    await vi.advanceTimersByTimeAsync(50);
    await expect(next).resolves.toBe("ok");
    expect(starts).toEqual([
      { url: "https://source.invalid/first", at: 0 },
      { url: "https://source.invalid/next", at: 100 },
    ]);
  });

  it("includes pacing in the original timeout and clears the last waiting timer", async () => {
    const { http, fetch } = setup(50);
    await http.getText("https://source.invalid/first");
    const rejected = expect(
      http.getText("https://source.invalid/expired"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(http.getText("https://source.invalid/later")).resolves.toBe(
      "ok",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("closes paced requests without sending them or retaining a wake-up timer", async () => {
    const { http, fetch } = setup();
    await http.getText("https://source.invalid/first");
    const rejected = expect(
      http.getText("https://source.invalid/waiting"),
    ).rejects.toMatchObject({ name: "AbortError" });
    await http.close();
    await rejected;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
