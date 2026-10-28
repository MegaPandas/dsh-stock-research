import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedQueries } from "../../src/services/shared-queries.js";

const release: (() => void)[] = [];
const close: (() => Promise<void>)[] = [];
function shared<T>() {
  const queries = new SharedQueries<T>();
  close.push(() => queries.close());
  return queries;
}
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  release.push(() => resolve(cleanupValue));
  return { promise, resolve };
}
afterEach(async () => {
  for (const finish of release.splice(0)) finish();
  await Promise.all(close.splice(0).map((finish) => finish()));
});

describe("shared in-flight queries", () => {
  it("loads one matching query and rejects a conflicting in-flight identity", async () => {
    const queries = shared<number>();
    const result = deferred(0);
    const started = deferred<void>(undefined);
    const load = vi.fn(async () => {
      started.resolve();
      return result.promise;
    });
    const first = queries.run("call", "request", load);
    const second = queries.run("call", "request", load);
    await started.promise;
    await expect(queries.run("call", "changed", load)).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    result.resolve(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(
      queries.run("call", "new request", async () => 7),
    ).resolves.toBe(7);
  });

  it("cancels only one waiter while the remaining caller still needs the producer", async () => {
    const queries = shared<number>();
    const result = deferred(0);
    const started = deferred<AbortSignal>(new AbortController().signal);
    const owner = new AbortController();
    const load = vi.fn(async (signal: AbortSignal) => {
      started.resolve(signal);
      return result.promise;
    });
    const first = queries.run("call", "request", load, owner.signal);
    const second = queries.run("call", "request", load);
    const producer = await started.promise;
    const reason = new Error("first caller stopped");
    const rejected = expect(first).rejects.toBe(reason);
    owner.abort(reason);
    await rejected;
    expect(producer.aborted).toBe(false);
    result.resolve(11);
    await expect(second).resolves.toBe(11);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("aborts the producer after its last waiter cancels and accepts a new explicit call", async () => {
    const queries = shared<number>();
    const result = deferred(0);
    const started = deferred<AbortSignal>(new AbortController().signal);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const load = vi.fn(async (signal: AbortSignal) => {
      started.resolve(signal);
      return result.promise;
    });
    const first = queries.run("call", "request", load, firstController.signal);
    const second = queries.run(
      "call",
      "request",
      load,
      secondController.signal,
    );
    const producer = await started.promise;
    const firstReason = new Error("first stopped");
    const secondReason = new Error("last stopped");
    const firstRejected = expect(first).rejects.toBe(firstReason);
    const secondRejected = expect(second).rejects.toBe(secondReason);
    firstController.abort(firstReason);
    secondController.abort(secondReason);
    await Promise.all([firstRejected, secondRejected]);
    expect(producer.aborted).toBe(true);
    expect(producer.reason).toBe(secondReason);
    await expect(queries.run("call", "request", async () => 22)).resolves.toBe(
      22,
    );
    result.resolve(0);
  });

  it("does not start a producer when all callers cancel before it starts", async () => {
    const queries = shared<number>();
    const one = new AbortController();
    const two = new AbortController();
    const load = vi.fn(async () => 1);
    const first = queries.run("call", "request", load, one.signal);
    const second = queries.run("call", "request", load, two.signal);
    const firstReason = new Error("one");
    const secondReason = new Error("two");
    const firstRejected = expect(first).rejects.toBe(firstReason);
    const secondRejected = expect(second).rejects.toBe(secondReason);
    one.abort(firstReason);
    two.abort(secondReason);
    await Promise.all([firstRejected, secondRejected]);
    await queries.close();
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps a replacement shared when an abandoned producer finishes late", async () => {
    const queries = shared<number>();
    const oldResult = deferred(0);
    const oldStarted = deferred<void>(undefined);
    const oldController = new AbortController();
    const old = queries.run(
      "call",
      "request",
      async () => {
        oldStarted.resolve();
        return oldResult.promise;
      },
      oldController.signal,
    );
    await oldStarted.promise;
    const reason = new Error("abandon old request");
    const oldRejected = expect(old).rejects.toBe(reason);
    oldController.abort(reason);
    await oldRejected;

    const replacementResult = deferred(0);
    const replacementEntered = deferred<void>(undefined);
    const replacementReady = deferred<void>(undefined);
    const replacementLoad = vi.fn(async () => {
      replacementEntered.resolve();
      await oldResult.promise;
      replacementReady.resolve();
      return replacementResult.promise;
    });
    const replacement = queries.run("call", "request", replacementLoad);
    await replacementEntered.promise;
    oldResult.resolve(1);
    await replacementReady.promise;
    const thirdLoad = vi.fn(async () => 99);
    const joined = queries.run("call", "request", thirdLoad);
    replacementResult.resolve(42);
    await expect(Promise.all([replacement, joined])).resolves.toEqual([42, 42]);
    expect(replacementLoad).toHaveBeenCalledTimes(1);
    expect(thirdLoad).not.toHaveBeenCalled();
  });

  it("propagates a loader failure unchanged without retrying or retaining the result", async () => {
    const queries = shared<number>();
    const failure = new Error("provider failed");
    const load = vi.fn(async () => {
      throw failure;
    });
    await expect(queries.run("call", "request", load)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(queries.run("call", "request", async () => 5)).resolves.toBe(
      5,
    );
  });

  it("rejects an already cancelled caller without loading", async () => {
    const queries = shared<number>();
    const caller = new AbortController();
    const reason = new Error("already stopped");
    caller.abort(reason);
    const load = vi.fn(async () => 1);
    await expect(
      queries.run("call", "request", load, caller.signal),
    ).rejects.toBe(reason);
    expect(load).not.toHaveBeenCalled();
  });

  it("closes waiters immediately but waits for an abandoned noncooperative loader to settle", async () => {
    const queries = shared<number>();
    const gate = deferred(0);
    const started = deferred<AbortSignal>(new AbortController().signal);
    const caller = new AbortController();
    const waiting = queries.run(
      "call",
      "request",
      async (signal) => {
        started.resolve(signal);
        return gate.promise;
      },
      caller.signal,
    );
    const producer = await started.promise;
    const reason = new Error("caller stopped before close");
    const rejected = expect(waiting).rejects.toBe(reason);
    caller.abort(reason);
    await rejected;
    let closed = false;
    const closing = queries.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(producer.aborted).toBe(true);
    gate.resolve(3);
    await closing;
    expect(closed).toBe(true);
    await queries.close();
    const load = vi.fn(async () => 2);
    await expect(queries.run("new", "request", load)).rejects.toBe(
      queries.signal.reason,
    );
    expect(queries.signal.reason).toMatchObject({ name: "AbortError" });
    expect(load).not.toHaveBeenCalled();
  });

  it("aborts live producer and caller signals when closing", async () => {
    const queries = shared<number>();
    const gate = deferred(0);
    const started = deferred<AbortSignal>(new AbortController().signal);
    const waiting = queries.run("call", "request", async (signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const producer = await started.promise;
    const rejected = expect(waiting).rejects.toMatchObject({
      name: "AbortError",
    });
    const closing = queries.close();
    await rejected;
    expect(producer.aborted).toBe(true);
    expect(producer.reason).toBe(queries.signal.reason);
    gate.resolve(0);
    await closing;
  });

  it("runs different keys independently", async () => {
    const queries = shared<number>();
    const gate = deferred(0);
    const first = queries.run("one", "request", async () => gate.promise);
    await expect(queries.run("two", "request", async () => 2)).resolves.toBe(2);
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
  });
});
