import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import { continueChild } from "../../src/host/child-continuation.js";
import { continuationHost } from "../fixtures/continuation-host.js";
import { deferred, textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function host(options?: Parameters<typeof continuationHost>[0]) {
  const h = await continuationHost(options);
  cleanups.push(h.close);
  return h;
}
async function start(h: Awaited<ReturnType<typeof host>>, id: string) {
  return h.ctx.subagents.startActivation({
    provider: "spawn",
    childId: SessionId(id),
    label: "continuation test",
    request: {
      parent: h.outside.agent,
      prompt: [{ type: "text", text: "Remember first-turn-marker." }],
    },
    signal: new AbortController().signal,
    delivery: "caller",
  });
}

describe("native child continuation", () => {
  it("cold restores the same session history and captures the new turn", async () => {
    const childId = SessionId("continuation-history");
    let turns = 0;
    const h = await host({
      respond: (request) =>
        textResponse(
          request.sessionId === childId
            ? `Child turn ${++turns}.`
            : "Parent received native settlement.",
        ),
    });
    const first = await start(h, childId);
    expect(await first.result).toMatchObject({ stopReason: "completed" });
    expect(h.ctx.agents.get(childId)).toBeUndefined();
    expect(await h.ctx.sessionPersistence.stat(childId)).toBeDefined();
    const second = await continueChild(
      h.ctx,
      h.outside.agent,
      childId,
      [{ type: "text", text: "Continue second-turn-marker." }],
      new AbortController().signal,
    );
    expect(second.childId).toBe(childId);
    expect(second.messageId).toBeDefined();
    expect(await second.result).toEqual({
      stopReason: "completed",
      output: [{ type: "text", text: "Child turn 2." }],
    });
    const requests = h.adapter.requests.filter(
      (request) => request.sessionId === childId,
    );
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain(
      "first-turn-marker",
    );
    expect(JSON.stringify(requests[1]!.messages)).toContain("Child turn 1.");
    expect(JSON.stringify(requests[1]!.messages)).toContain(
      "second-turn-marker",
    );
    expect(h.ctx.agents.get(childId)).toBeUndefined();
    await second.dispose();
  });

  it("disposes the resumed activation without disposing a sibling", async () => {
    const childId = SessionId("continuation-cancel");
    const siblingId = SessionId("continuation-sibling");
    const running = deferred<void>();
    const release = deferred<void>();
    const releaseSibling = deferred<void>();
    let turns = 0;
    const h = await host({
      respond: async function* (request) {
        if (request.sessionId === siblingId) {
          await releaseSibling.promise;
        } else if (request.sessionId === childId && ++turns === 2) {
          running.resolve();
          await release.promise;
        }
        yield* textResponse("Turn complete.");
      },
    });
    const first = await start(h, childId);
    await first.result;
    const sibling = await start(h, siblingId);
    const next = await continueChild(
      h.ctx,
      h.outside.agent,
      childId,
      [{ type: "text", text: "Continue until cancelled." }],
      new AbortController().signal,
    );
    await running.promise;
    await first.dispose();
    expect(h.ctx.agents.get(childId)).toBeDefined();
    const disposal = next.dispose();
    release.resolve();
    await disposal;
    expect(await next.result).toMatchObject({ stopReason: "aborted" });
    expect(h.ctx.agents.get(childId)).toBeUndefined();
    expect(h.ctx.agents.get(siblingId)).toBeDefined();
    releaseSibling.resolve();
    await sibling.result;
  });

  it("preserves cancellation before acceptance without resuming the child", async () => {
    const h = await host();
    const first = await start(h, "continuation-not-accepted");
    await first.result;
    const controller = new AbortController();
    const reason = new Error("Caller cancelled before acceptance");
    controller.abort(reason);
    await expect(
      continueChild(
        h.ctx,
        h.outside.agent,
        first.childId,
        [{ type: "text", text: "Must not run." }],
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(h.ctx.agents.get(first.childId)).toBeUndefined();
  });

  it("keeps a settled continuation disposer from cancelling a later activation", async () => {
    const childId = SessionId("continuation-stale-dispose");
    const running = deferred<void>();
    const release = deferred<void>();
    let turns = 0;
    const h = await host({
      respond: async function* (request) {
        if (request.sessionId === childId && ++turns === 3) {
          running.resolve();
          await release.promise;
        }
        yield* textResponse("Turn complete.");
      },
    });
    const first = await start(h, childId);
    await first.result;
    const resume = () =>
      continueChild(
        h.ctx,
        h.outside.agent,
        childId,
        [{ type: "text", text: "Continue." }],
        new AbortController().signal,
      );
    const second = await resume();
    await second.result;
    const third = await resume();
    await running.promise;
    await second.dispose();
    expect(h.ctx.agents.get(childId)).toBeDefined();
    const disposal = third.dispose();
    release.resolve();
    await disposal;
    expect(await third.result).toMatchObject({ stopReason: "aborted" });
  });
});
