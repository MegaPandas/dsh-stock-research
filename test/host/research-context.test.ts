import type { Agent, AgentSetup } from "@deepseek-ai/dsh-agent";
import {
  createUserMessage,
  HarnessError,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  buildForkSeed,
  SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { afterEach, expect, it } from "vitest";
import { setupResearchContext } from "../../src/host/research-context.js";
import {
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  sectionSelectionSchema,
} from "../../src/host/tool-protocol/parameters.js";
import { continuationHost } from "../fixtures/continuation-host.js";
import { toolCall } from "../fixtures/quick-host.js";
import { textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function host(
  respond: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
) {
  const h = await continuationHost({ respond });
  cleanups.push(h.close);
  const errors: unknown[] = [];
  h.ctx.on("agent/error", ({ error }) => {
    errors.push(error);
  });
  return { ...h, errors };
}
function setup(
  h: Awaited<ReturnType<typeof host>>,
  tools: ToolDefinition[],
  managed = true,
): AgentSetup {
  return (ctx, agent) => {
    for (const tool of tools) ctx.tools.register(tool);
    if (managed)
      ctx.effect(() => setupResearchContext(ctx, agent, h.ctx.sessionQuery));
  };
}
function readTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "stock_read_run",
    description: "Read the current run snapshot.",
    parameters: objectSchema({ runId: stringSchema }),
    output: resultOutput(opaqueObjectSchema),
    execute,
  };
}
async function run(agent: Agent, text = "Continue.") {
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }),
  );
  await agent.whenIdle();
}
function toolText(request: GenerateOptions): string {
  return JSON.stringify(request.messages.filter(({ role }) => role === "tool"));
}

it("keeps the latest identical read, independent reads and failures while retaining the original log", async () => {
  const actions = [
    ["stock_read_run", { runId: "one" }],
    ["host_marker", {}],
    ["stock_read_run", { runId: "two" }],
    ["stock_read_run", { runId: "one" }],
    ["stock_read_run", { runId: "failed" }],
  ] as const;
  let step = 0;
  const h = await host(async function* () {
    const action = actions[step++];
    if (action !== undefined) {
      for await (const chunk of toolCall(
        action[0],
        action[1],
        `read-${step}`,
      )) {
        const formatted = JSON.stringify(action[1], null, 2);
        if (step === 4 && chunk.type === "tool-call-delta")
          yield { ...chunk, argumentsDelta: formatted };
        else if (
          step === 4 &&
          chunk.type === "block-end" &&
          chunk.block.type === "tool-call"
        )
          yield { ...chunk, block: { ...chunk.block, arguments: formatted } };
        else yield chunk;
      }
    } else yield* textResponse("Done.");
  });
  const counts = new Map<string, number>();
  const handle = await h.ctx.agents.create({
    ...h.agentOptions("latest-reads"),
    setup: setup(h, [
      readTool(async (value) => {
        const { runId } = value as { runId: string };
        if (runId === "failed")
          throw new HarnessError("read-failed-marker", "INVALID_INPUT");
        const count = (counts.get(runId) ?? 0) + 1;
        counts.set(runId, count);
        return { value: `${runId}-${count}-snapshot` };
      }),
    ]),
  });
  await run(handle.agent);
  expect(h.errors).toEqual([]);
  expect(h.adapter.requests).toHaveLength(actions.length + 1);
  const last = h.adapter.requests.at(-1)!;
  expect(toolText(last)).not.toContain("one-1-snapshot");
  for (const text of [
    "one-2-snapshot",
    "two-1-snapshot",
    "read-failed-marker",
    "host remains available",
  ])
    expect(toolText(last)).toContain(text);
  expect(toolText(h.adapter.requests[1]!)).toContain("one-1-snapshot");
  const log = await h.ctx.sessionQuery.readSession(handle.agent.id);
  expect(JSON.stringify(log.events)).toContain("one-1-snapshot");
  const replacements = log.events.filter(
    (event) => event.type === "tool/result" && event.surfaceOp !== "append",
  );
  expect(replacements).toHaveLength(1);
  await run(handle.agent, "Keep the current result.");
  const later = await h.ctx.sessionQuery.readSession(handle.agent.id);
  expect(
    later.events.filter(
      (event) => event.type === "tool/result" && event.surfaceOp !== "append",
    ),
  ).toHaveLength(1);
  await handle.dispose();
});

it("keeps prior draft reads after failed writes and retires them after successful writes", async () => {
  const actions = [
    ["stock_read_report_draft", { sections: [] }],
    ["stock_write_report", { fail: true }],
    ["stock_write_handoff", {}],
  ] as const;
  let step = 0;
  const h = await host(async function* (request) {
    if (step === 2) expect(toolText(request)).toContain("draft-before-write");
    const action = actions[step++];
    if (action !== undefined)
      yield* toolCall(action[0], action[1], `draft-${step}`);
    else yield* textResponse("Done.");
  });
  const handle = await h.ctx.agents.create({
    ...h.agentOptions("draft-writes"),
    setup: setup(h, [
      {
        name: "stock_read_report_draft",
        description: "Read draft.",
        parameters: objectSchema({ sections: sectionSelectionSchema }),
        output: resultOutput(opaqueObjectSchema),
        execute: async () => ({ value: "draft-before-write" }),
      },
      {
        name: "stock_write_report",
        description: "Write draft.",
        parameters: objectSchema({ fail: { type: "boolean" } }),
        output: resultOutput(opaqueObjectSchema),
        execute: async () => {
          throw new HarnessError("atomic-write-failed", "INVALID_INPUT");
        },
      },
      {
        name: "stock_write_handoff",
        description: "Write handoff.",
        parameters: objectSchema({}),
        output: resultOutput(opaqueObjectSchema),
        execute: async () => ({ status: "saved" }),
      },
    ]),
  });
  await run(handle.agent);
  expect(h.errors).toEqual([]);
  const last = toolText(h.adapter.requests.at(-1)!);
  expect(last).not.toContain("draft-before-write");
  expect(last).toContain("atomic-write-failed");
  await handle.dispose();
});

it("retires stale seeded draft reads on cold resume without rewriting persisted evidence", async () => {
  let round = 1;
  let step = 0;
  const h = await host(async function* () {
    if (round === 1 && step++ === 0)
      yield* toolCall(
        "stock_read_report_draft",
        { sections: [] },
        "old-draft-read",
      );
    else if (round === 1)
      yield* toolCall("stock_write_report", {}, "saved-draft");
    else if (step++ === 0)
      yield* toolCall(
        "stock_read_report_draft",
        { sections: [] },
        "new-draft-read",
      );
    else yield* textResponse("Resumed.");
  });
  const prepare = setup(h, [
    {
      name: "stock_read_report_draft",
      description: "Read draft.",
      parameters: objectSchema({ sections: sectionSelectionSchema }),
      output: resultOutput(opaqueObjectSchema),
      execute: async () => ({
        value: round === 1 ? "old-draft-result" : "current-draft-result",
      }),
    },
    {
      name: "stock_write_report",
      description: "Save draft and finish this turn.",
      parameters: objectSchema({}),
      output: resultOutput(opaqueObjectSchema),
      execute: async (_value, exec) => {
        exec.concludeTurn();
        return { status: "saved" };
      },
    },
  ]);
  const id = SessionId("resume-draft-context");
  const first = await h.ctx.agents.create({
    ...h.agentOptions(id),
    setup: prepare,
  });
  await run(first.agent, "Original task marker.");
  await first.dispose();
  const before = await h.ctx.sessionQuery.readSession(id);
  expect(JSON.stringify(before.events)).toContain("old-draft-result");
  expect(
    before.events.filter(
      (event) => event.type === "tool/result" && event.surfaceOp !== "append",
    ),
  ).toEqual([]);
  const offset = h.adapter.requests.length;
  round = 2;
  step = 0;
  const second = await h.ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: h.agentOptions(id).agentOptions,
    setup: prepare,
  });
  await run(second.agent, "Revise only the requested section.");
  expect(h.errors).toEqual([]);
  expect(toolText(h.adapter.requests[offset]!)).not.toContain(
    "old-draft-result",
  );
  expect(JSON.stringify(h.adapter.requests[offset]!.messages)).toContain(
    "Original task marker.",
  );
  expect(toolText(h.adapter.requests.at(-1)!)).toContain(
    "current-draft-result",
  );
  const after = await h.ctx.sessionQuery.readSession(id);
  expect(JSON.stringify(after.events)).toContain("old-draft-result");
  expect(
    after.events.filter(
      (event) => event.type === "tool/result" && event.surfaceOp !== "append",
    ),
  ).toHaveLength(1);
  await second.dispose();
});

it("does not retire fork-inherited reads or modify the parent session", async () => {
  const steps = new Map<string, number>();
  const h = await host(async function* (request) {
    const id = String(request.sessionId);
    const step = (steps.get(id) ?? 0) + 1;
    steps.set(id, step);
    if (step <= 2)
      yield* toolCall("stock_read_run", { runId: "shared" }, `${id}-${step}`);
    else yield* textResponse("Done.");
  });
  let count = 0;
  const read = readTool(async () => ({ value: `snapshot-${++count}` }));
  const parent = await h.ctx.agents.create({
    ...h.agentOptions("context-parent"),
    setup: setup(h, [read], false),
  });
  await run(parent.agent);
  const original = await h.ctx.sessionQuery.readSession(parent.agent.id);
  const boundary = original.events.at(-1)!.seq;
  const child = await h.ctx.agents.create({
    ...h.agentOptions("context-fork"),
    seed: buildForkSeed(original.events, boundary),
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta: { cwd: h.directory, parentSession: parent.agent.id, isSeeded: true },
    setup: setup(h, [read]),
  });
  await run(child.agent);
  expect(h.errors).toEqual([]);
  const last = toolText(h.adapter.requests.at(-1)!);
  for (const text of ["snapshot-1", "snapshot-2", "snapshot-4"])
    expect(last).toContain(text);
  expect(last).not.toContain("snapshot-3");
  expect(
    (await h.ctx.sessionQuery.readSession(parent.agent.id)).events,
  ).toEqual(original.events);
  await child.dispose();
  await parent.dispose();
});
