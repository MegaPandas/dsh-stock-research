import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchError } from "../../src/core.js";
import {
  getHttpRequestMetadata,
  HttpClient,
  HttpStatusError,
} from "../../src/data/http.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const clients: HttpClient[] = [];
const servers: Server[] = [];

function client(timeoutMs = 5_000, maxConcurrency = 1) {
  const value = new HttpClient({ timeoutMs, maxConcurrency, minIntervalMs: 0 });
  clients.push(value);
  return value;
}

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("HttpClient", () => {
  it("serializes each source while allowing other sources to reach the server", async () => {
    const both = deferred<void>();
    const replies: ServerResponse[] = [];
    const paths: string[] = [];
    const base = await serve((request, reply) => {
      paths.push(request.url!);
      if (request.url === "/a2") reply.end("a2");
      else {
        replies.push(reply);
        if (replies.length === 2) both.resolve();
      }
    });
    const http = client();
    const a = http.forSource("a");
    expect(http.forSource("a")).toBe(a);
    const work = [
      a.getText(base + "/a1"),
      http.forSource("a").getText(base + "/a2"),
      http.forSource("b").getText(base + "/b"),
    ];
    await both.promise;
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(expect.arrayContaining(["/a1", "/b"]));
    for (const reply of replies) reply.end("ok");
    await expect(Promise.all(work)).resolves.toEqual(["ok", "a2", "ok"]);
    expect(paths[2]).toBe("/a2");
  });

  it("closes and drains active and queued source requests", async () => {
    const started = deferred<void>();
    const base = await serve((_request, reply) => {
      reply.writeHead(200);
      reply.write("pending");
      started.resolve();
    });
    const http = client();
    const source = http.forSource("a");
    const active = expect(source.getText(base)).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    const queued = expect(source.getText(base)).rejects.toMatchObject({
      name: "AbortError",
    });
    await http.close();
    await Promise.all([active, queued]);
    expect(() => http.forSource("new")).toThrowError(
      expect.objectContaining({ name: "AbortError" }),
    );
    await expect(source.getText(base)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("rejects configurations outside the public limits", () => {
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      expect(
        () =>
          new HttpClient({ timeoutMs, maxConcurrency: 1, minIntervalMs: 0 }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
    for (const maxConcurrency of [0, -1, 1.5, NaN, Infinity, 2 ** 53]) {
      expect(
        () =>
          new HttpClient({
            timeoutMs: 1_000,
            maxConcurrency,
            minIntervalMs: 0,
          }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("sends GET headers and resolves only with the complete text body", async () => {
    const response = deferred<ServerResponse>();
    const base = await serve((request, reply) => {
      expect(request.method).toBe("GET");
      expect(request.headers["x-research"]).toBe("daily");
      reply.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      reply.write("市场");
      response.resolve(reply);
    });
    const result = client().getText(new URL("/text", base), {
      headers: new Headers({ "x-research": "daily" }),
    });
    const reply = await response.promise;
    reply.end(" research");
    await expect(result).resolves.toBe("市场 research");
  });

  it("keeps the concurrency slot through the body and serves queued calls FIFO", async () => {
    const replies: ServerResponse[] = [];
    const first = deferred<void>();
    const paths: string[] = [];
    let active = 0;
    let maximum = 0;
    const base = await serve((request, reply) => {
      paths.push(request.url!);
      active += 1;
      maximum = Math.max(maximum, active);
      reply.on("finish", () => {
        active -= 1;
      });
      reply.writeHead(200);
      reply.write("part");
      replies.push(reply);
      if (paths.length === 1) first.resolve();
      else reply.end(request.url);
    });
    const http = client();
    const results = ["/a", "/b", "/c"].map((path) => http.getText(base + path));
    await first.promise;
    await delay(100);
    expect(paths).toEqual(["/a"]);
    replies[0]!.end("/a");
    await expect(Promise.all(results)).resolves.toEqual([
      "part/a",
      "part/b",
      "part/c",
    ]);
    expect(paths).toEqual(["/a", "/b", "/c"]);
    expect(maximum).toBe(1);
  });

  it("allows the configured number of simultaneous requests", async () => {
    const both = deferred<void>();
    const replies: ServerResponse[] = [];
    const base = await serve((_request, reply) => {
      replies.push(reply);
      if (replies.length === 2) both.resolve();
    });
    const http = client(5_000, 2);
    const results = [http.getText(base), http.getText(base)];
    await both.promise;
    for (const reply of replies) reply.end("ok");
    await expect(Promise.all(results)).resolves.toEqual(["ok", "ok"]);
  });

  it("never sends an already cancelled call", async () => {
    let requests = 0;
    const base = await serve((_request, reply) => {
      requests += 1;
      reply.end("ok");
    });
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    const http = client();
    await expect(
      http.getText(base + "/cancelled", { signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(http.getText(base + "/next")).resolves.toBe("ok");
    expect(requests).toBe(1);
  });

  it("removes cancelled queued calls and lets the next call proceed", async () => {
    const first = deferred<ServerResponse>();
    const paths: string[] = [];
    const base = await serve((request, reply) => {
      paths.push(request.url!);
      if (request.url === "/first") first.resolve(reply);
      else reply.end("next");
    });
    const http = client();
    const running = http.getText(base + "/first");
    const reply = await first.promise;
    const controller = new AbortController();
    const reason = { stopped: true };
    const queued = http.getText(base + "/cancelled", {
      signal: controller.signal,
    });
    const rejected = expect(queued).rejects.toBe(reason);
    const next = http.getText(base + "/next");
    controller.abort(reason);
    await rejected;
    reply.end("first");
    await expect(running).resolves.toBe("first");
    await expect(next).resolves.toBe("next");
    expect(paths).toEqual(["/first", "/next"]);
  });

  it("disconnects an active response and preserves the caller's cancellation reason", async () => {
    const started = deferred<void>();
    const disconnected = deferred<void>();
    const base = await serve((_request, reply) => {
      reply.on("close", () => disconnected.resolve());
      reply.writeHead(200);
      reply.write("pending");
      started.resolve();
    });
    const controller = new AbortController();
    const reason = new Error("stop reading");
    const result = client().getText(base, { signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    await disconnected.promise;
  });

  it("applies the total timeout while reading a stalled body", async () => {
    const disconnected = deferred<void>();
    const base = await serve((_request, reply) => {
      reply.on("close", () => disconnected.resolve());
      reply.writeHead(200);
      reply.write("unfinished");
    });
    const error: unknown = await client(800)
      .getText(base)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(getHttpRequestMetadata(error)).toEqual({ url: base, method: "GET" });
    await disconnected.promise;
  });

  it("does not restart the total timeout after queueing", async () => {
    const first = deferred<ServerResponse>();
    const base = await serve((request, reply) => {
      if (request.url === "/first") first.resolve(reply);
      else {
        reply.writeHead(200);
        reply.write("stalled");
      }
    });
    const http = client(1_000);
    const running = http.getText(base + "/first");
    const reply = await first.promise;
    const caller = AbortSignal.timeout(1_400);
    const queued = http.getText(base + "/queued", { signal: caller });
    const outcome = queued.catch((cause: unknown) => cause);
    await delay(650);
    reply.end("first");
    await expect(running).resolves.toBe("first");
    const error: unknown = await outcome;
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(caller.aborted).toBe(false);
  });

  it("reports non-success status once and cancels its unfinished body", async () => {
    const disconnected = deferred<void>();
    let failures = 0;
    const base = await serve((request, reply) => {
      if (request.url === "/ok") {
        reply.end("ok");
        return;
      }
      failures += 1;
      reply.on("close", () => disconnected.resolve());
      reply.writeHead(503, "Temporarily Unavailable");
      reply.write("unfinished error body");
    });
    const http = client();
    const error: unknown = await http
      .getText(base + "/failure?api_key=hidden")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toBeInstanceOf(ResearchError);
    expect(error).toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      statusText: "Temporarily Unavailable",
      url: base + "/failure",
    });
    expect(getHttpRequestMetadata(error)).toEqual({
      url: base + "/failure",
      method: "GET",
    });
    await disconnected.promise;
    await expect(http.getText(base + "/ok")).resolves.toBe("ok");
    expect(failures).toBe(1);
  });

  it("closes active and waiting requests, is repeatable, and rejects new calls", async () => {
    const started = deferred<void>();
    const disconnected = deferred<void>();
    const paths: string[] = [];
    const base = await serve((request, reply) => {
      paths.push(request.url!);
      reply.on("close", () => disconnected.resolve());
      reply.writeHead(200);
      reply.write("pending");
      started.resolve();
    });
    const http = client();
    let settled = 0;
    const running = http.getText(base + "/running");
    void running.then(
      () => {
        settled += 1;
      },
      () => {
        settled += 1;
      },
    );
    const runningRejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    const queued = http.getText(base + "/queued");
    void queued.then(
      () => {
        settled += 1;
      },
      () => {
        settled += 1;
      },
    );
    const queuedRejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    await http.close();
    expect(settled).toBe(2);
    await Promise.all([runningRejected, queuedRejected, disconnected.promise]);
    await http.close();
    await expect(http.getText(base + "/new")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(paths).toEqual(["/running"]);
  });

  it("propagates a network interruption without converting it to a status error", async () => {
    let requests = 0;
    const base = await serve((_request, reply) => {
      requests += 1;
      reply.writeHead(200);
      reply.write("partial");
      reply.socket!.destroy();
    });
    const error: unknown = await client()
      .postText(base + "/interrupted?secret=hidden")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ResearchError);
    expect(error).toHaveProperty("cause");
    expect(getHttpRequestMetadata(error)).toEqual({
      url: base + "/interrupted",
      method: "POST",
    });
    expect(requests).toBe(1);
  });
});
