import {
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatchBridge, type RoleProvision } from "../../src/host/dispatch.js";
import { SessionBindings, taskOperation } from "../../src/host/bindings.js";
import { ResearchSessions } from "../../src/host/sessions.js";
import { DigestService } from "../../src/services/digests.js";
import {
  analysis,
  DigestAdapter,
  dispatchHost,
} from "../fixtures/dispatch-host.js";
import { continuationHost } from "../fixtures/continuation-host.js";
import { deferred, textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function host(
  followup = true,
  onFollowup?: (request: GenerateOptions) => Promise<void>,
) {
  const storage = await dispatchHost([]);
  cleanups.push(storage.close);
  const calls = new Map<string, number>();
  const native = await continuationHost({
    respond: async function* (request): AsyncIterable<StreamChunk> {
      const id = String(request.sessionId);
      if (id === "host-other") {
        yield* textResponse("Parent received result.");
        return;
      }
      const count = (calls.get(id) ?? 0) + 1;
      calls.set(id, count);
      if (count === 3) await onFollowup?.(request);
      if (count % 2 === 0) {
        yield* textResponse(`Saved report round ${count / 2}.`);
        return;
      }
      const callId = ToolCallId(`save-${count}`);
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: callId,
        name: "save_report",
        argumentsDelta: "{}",
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: callId,
          name: "save_report",
          arguments: "{}",
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    },
  });
  cleanups.push(native.close);
  const bindings = new SessionBindings();
  const sessions = new ResearchSessions(native.ctx, bindings);
  const save: ToolDefinition = {
    name: "save_report",
    description: "Publish the task report.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: () => [{ type: "text", text: "saved" }],
    },
    async execute(_value, exec) {
      const operation = taskOperation(bindings.require(exec.agent));
      const content = analysis();
      content.inputRefs = storage.runs.readAttempt(operation).inputRefs;
      storage.artifacts.submitArtifact(operation, [content], "save");
      return "saved";
    },
  };
  native.ctx.tools.register(save);
  const provision = (): RoleProvision => ({
    prompt: [{ type: "text", text: "first-turn-marker: prepare the report." }],
    tools: [save],
    ...(followup ? { followup: () => provision() } : {}),
  });
  const digests = new DigestService(
    storage.runs,
    storage.artifacts,
    async () => {
      throw new Error("Unexpected digest call");
    },
  );
  const bridge = new DispatchBridge(
    native.ctx,
    storage.runs,
    sessions,
    provision,
    digests,
  );
  cleanups.push(() => bridge.close());
  const signal = new AbortController().signal;
  const parent = native.outside.agent;
  const dispatch = (taskId = "analysis") =>
    bridge.dispatch(parent, storage.runId, taskId, `initial-${taskId}`, signal);
  const follow = (
    requestId = "follow",
    message = "second-turn-marker: add detail.",
  ) =>
    bridge.followup(
      parent,
      storage.runId,
      "analysis",
      message,
      requestId,
      false,
      signal,
    );
  return { ...storage, native, bridge, parent, dispatch, follow };
}

describe("role follow-up in a persistent native child", () => {
  it("reuses history and publishes a new attempt while retaining old artifacts and invalidating downstream", async () => {
    const h = await host();
    const first = await h.dispatch();
    expect(first.status).toBe("succeeded");
    const dependent = await h.dispatch("dependent");
    expect(dependent.status).toBe("succeeded");
    const second = await h.follow();
    expect(second).toMatchObject({
      status: "succeeded",
      attempt: 2,
      sessionId: first.sessionId,
    });
    expect(second.refs).not.toEqual(first.refs);
    expect(h.runs.readArtifact(first.refs[0]!)).toMatchObject({
      attempt: 1,
      producerSessionId: first.sessionId,
    });
    expect(h.runs.readAttempt(first).status).toBe("invalidated");
    expect(h.runs.readAttempt(dependent).status).toBe("invalidated");
    expect(second.refs[0]!.revision).toBe(first.refs[0]!.revision + 1);
    expect(h.runs.readAttempt(second).instructionVersion).toBe(2);
    const requests = h.native.adapter.requests.filter(
      (request) => request.sessionId === first.sessionId,
    );
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[2]!.messages)).toContain(
      "first-turn-marker",
    );
    expect(JSON.stringify(requests[2]!.messages)).toContain(
      "Saved report round 1.",
    );
    expect(JSON.stringify(requests[2]!.messages)).toContain(
      "second-turn-marker",
    );
    expect(requests[2]!.tools?.map(({ name }) => name)).toEqual([
      "save_report",
    ]);
  });

  it("shares a request receipt and rejects conflicting payloads without another message", async () => {
    const h = await host();
    const first = await h.dispatch();
    const pending = h.follow();
    expect(h.follow()).toBe(pending);
    const result = await pending;
    expect(await h.follow()).toEqual(result);
    await expect(
      h.follow("follow", "different feedback"),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(
      h.native.adapter.requests.filter(
        (request) => request.sessionId === first.sessionId,
      ),
    ).toHaveLength(4);
  });

  it("rejects another parent and a missing session factory", async () => {
    const h = await host();
    await h.dispatch();
    await expect(
      h.bridge.followup(
        h.parent === h.native.outside.agent ? h.native.outside.agent : h.parent,
        h.runId,
        "parallel",
        "feedback",
        "unknown",
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    const other = await h.native.ctx.agents.create(
      h.native.agentOptions("different-parent"),
    );
    await expect(
      h.bridge.followup(
        other.agent,
        h.runId,
        "analysis",
        "feedback",
        "other",
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    h.bridge.releaseRun(h.runId);
    await expect(h.follow()).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
  });

  it("rejects provisions that do not support continuation", async () => {
    const h = await host(false);
    await h.dispatch();
    await expect(h.follow()).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
  });
  it("rejects steering while the next attempt is running and cancellation preserves a sibling", async () => {
    const started = deferred<void>();
    const released = deferred<void>();
    const h = await host(true, async (request) => {
      started.resolve();
      await released.promise;
      request.signal?.throwIfAborted();
    });
    const first = await h.dispatch();
    const controller = new AbortController();
    const pending = h.bridge.followup(
      h.parent,
      h.runId,
      "analysis",
      "wait for cancellation",
      "cancel-round",
      false,
      controller.signal,
    );
    await started.promise;
    await expect(h.follow("concurrent")).rejects.toMatchObject({
      code: "STALE_ATTEMPT",
    });
    const siblingStarted = deferred<void>();
    const releaseSibling = deferred<void>();
    h.native.ctx.llm.registerAdapter(
      ["sibling-fixture"],
      new DigestAdapter(async function* () {
        siblingStarted.resolve();
        await releaseSibling.promise;
        yield* textResponse("Sibling completed.");
      }),
    );
    const sibling = await h.native.ctx.subagents.startActivation({
      provider: "spawn",
      childId: SessionId("followup-sibling"),
      label: "Sibling task",
      delivery: "caller",
      request: {
        parent: h.parent,
        agentOptions: { provider: "sibling-fixture", model: "sibling" },
        prompt: [{ type: "text", text: "Wait independently." }],
      },
      signal: new AbortController().signal,
    });
    cleanups.push(async () => {
      releaseSibling.resolve();
      await sibling.dispose();
    });
    await siblingStarted.promise;
    controller.abort(new Error("cancel this round"));
    released.resolve();
    await pending;
    expect(
      h.native.ctx.agents.get(SessionId(first.sessionId!)),
    ).toBeUndefined();
    expect(h.native.ctx.agents.get(sibling.childId)).toBeDefined();
    releaseSibling.resolve();
    await sibling.result;
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "analysis", attempt: 2 })
        .status,
    ).toBe("failed");
  });

  it("preserves the original session binding storage failure", async () => {
    const h = await host();
    await h.dispatch();
    const failure = new Error("binding storage unavailable");
    vi.spyOn(h.runs, "bindTaskSession").mockImplementationOnce(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      await h.follow();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const chain: unknown[] = [];
    function collect(error: unknown): void {
      chain.push(error);
      if (error instanceof Error && error.cause !== undefined)
        collect(error.cause);
      if (error instanceof AggregateError)
        for (const nested of error.errors) collect(nested);
    }
    collect(caught);
    expect(chain).toContain(failure);
  });
});
