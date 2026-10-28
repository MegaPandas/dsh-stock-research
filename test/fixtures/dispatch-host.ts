import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type HarnessError,
  type StreamChunk,
  type FinishReason,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type {
  AnalysisPayload,
  ResearchArtifactInput,
} from "../../src/contracts/artifact-payloads.js";
import type { MemoryState } from "../../src/contracts/memory-service.js";
import type { GenerateDigest } from "../../src/contracts/digests.js";
import type { ModelCallRecord } from "../../src/host/model-events.js";
import type {
  RoleDispatchContext,
  RunState,
} from "../../src/contracts/runs.js";
import {
  SessionBindings,
  type ResearchBinding,
} from "../../src/host/bindings.js";
import { DispatchBridge } from "../../src/host/dispatch.js";
import { ResearchSessions } from "../../src/host/sessions.js";
import { MemoryStore } from "../../src/memory/store.js";
import { RunStore } from "../../src/runs/store.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { DecisionService } from "../../src/services/decisions.js";
import { DigestService } from "../../src/services/digests.js";
import { MemoryService } from "../../src/services/memory.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { createControlTools } from "../../src/tools/control.js";
import { createWriteTools } from "../../src/tools/write.js";
import { US_SECURITY } from "./market.js";

export function analysis(): Extract<
  ResearchArtifactInput,
  { kind: "analysis" }
> & { payload: AnalysisPayload } {
  return {
    kind: "analysis",
    title: "Dispatch analysis",
    body: "Artificial qualitative finding.",
    inputRefs: [],
    claims: [],
    payload: {
      findings: [{ text: "Artificial finding", evidence: [], numbers: [] }],
      risks: [],
      gaps: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function modelGate() {
  const started = deferred<GenerateOptions>();
  const aborted = deferred<void>();
  const released = deferred<void>();
  return { started, aborted, released };
}
export type ModelGate = ReturnType<typeof modelGate>;
export type ModelScript =
  | {
      kind: "save";
      afterSave?: ModelGate;
      usage?: TokenUsage;
      artifact?: ResearchArtifactInput;
    }
  | { kind: "text" }
  | { kind: "error"; error: HarnessError }
  | { kind: "wait"; gate: ModelGate };

/** Only the external provider stream is replaced; all host routing remains real. */
class DispatchAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly #sessions = new Map<
    string,
    { script: ModelScript | { kind: "parent"; runId: string }; calls: number }
  >();
  constructor(private readonly scripts: ModelScript[]) {
    super();
  }
  prepareParentDispatch(runId: string): void {
    this.#sessions.set("coordinator", {
      script: { kind: "parent", runId },
      calls: 0,
    });
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const id = String(options.sessionId);
    let session = this.#sessions.get(id);
    if (session === undefined) {
      const script = this.scripts.shift();
      if (script === undefined)
        throw new Error("Unexpected fixture model call");
      session = { script, calls: 0 };
      this.#sessions.set(id, session);
    }
    session.calls++;
    const { script } = session;
    if (script.kind === "error") throw script.error;
    if (script.kind === "parent" && session.calls === 1) {
      for (const [index, taskId] of ["analysis", "parallel"].entries()) {
        const id = ToolCallId(`dispatch-${taskId}`);
        const args = JSON.stringify({
          runId: script.runId,
          taskId,
          requestId: `parent-${taskId}`,
        });
        yield { type: "block-start", index, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index,
          id,
          name: "stock_dispatch_task",
          argumentsDelta: args,
        };
        yield {
          type: "block-end",
          index,
          block: {
            type: "tool-call",
            id,
            name: "stock_dispatch_task",
            arguments: args,
          },
        };
      }
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const gate =
      script.kind === "wait"
        ? script.gate
        : script.kind === "save" && session.calls > 1
          ? script.afterSave
          : undefined;
    if (gate !== undefined) {
      const aborted = () => gate.aborted.resolve();
      options.signal?.addEventListener("abort", aborted, { once: true });
      gate.started.resolve(options);
      if (options.signal?.aborted) aborted();
      try {
        // The test releases this after observing cancellation, proving owned work drains.
        await gate.released.promise;
        options.signal?.throwIfAborted();
      } finally {
        options.signal?.removeEventListener("abort", aborted);
      }
    }
    if (script.kind === "save" && session.calls === 1) {
      const callId = ToolCallId("submit-analysis");
      const args = JSON.stringify({
        requestId: "report",
        contents: [script.artifact ?? analysis()],
      });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: callId,
        name: "stock_save_report",
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: callId,
          name: "stock_save_report",
          arguments: args,
        },
      };
      if (script.usage !== undefined)
        yield { type: "usage", usage: script.usage };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "Analysis complete." };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "Analysis complete." },
    };
    if (script.kind === "save" && script.usage !== undefined)
      yield { type: "usage", usage: script.usage };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function unsafeTool(name: string): ToolDefinition {
  return {
    name,
    description: "Unsafe parent fixture capability",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute() {
      throw new Error("The child must never invoke this parent capability");
    },
  };
}

export async function dispatchHost(
  scripts: ModelScript[] = [{ kind: "save" }],
  generateDigest?: (ctx: Context, directory: string) => GenerateDigest,
) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-dispatch-"));
  const root = new DataRoot(directory);
  const ctx = new Context();
  const now = "2024-01-04T00:00:00.000Z";
  const runs = new RunService(new RunStore<RunState>(root), () => now);
  const numbers = new NumberService(runs);
  const artifacts = new ArtifactService(runs, numbers);
  const memory = new MemoryService(
    new MemoryStore<MemoryState>(root, () => ({
      stateVersion: 1,
      receipts: [],
    })),
    runs,
    async () => {
      throw new Error("Unexpected fixture returns query");
    },
    () => now,
  );
  const digests = new DigestService(
    runs,
    artifacts,
    generateDigest?.(ctx, directory) ??
      (async () => {
        throw new Error("Unexpected fixture digest generation");
      }),
  );
  const decisions = new DecisionService(runs, () => now);
  const scope = {
    security: US_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-03T22:00:00.000Z",
  };
  const task = (id: string, dependsOn: string[]) => ({
    id,
    executor: {
      kind: "role" as const,
      role: "analyst" as const,
      specialty: id,
    },
    dependsOn,
    inputTasks: dependsOn,
    outputKinds: ["analysis" as const],
    dataRequirements: [],
    instructionVersion: 1,
  });
  const { runId } = runs.open(
    "fixture-owner",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          task("analysis", []),
          task("parallel", []),
          task("dependent", ["analysis"]),
          {
            id: "digest",
            executor: { kind: "service", service: "digest" },
            dependsOn: ["analysis"],
            inputTasks: ["analysis"],
            outputKinds: ["digest"],
            dataRequirements: [],
            instructionVersion: 1,
          },
          {
            id: "finalize",
            executor: { kind: "service", service: "finalize" },
            dependsOn: ["analysis", "parallel", "dependent", "digest"],
            inputTasks: ["analysis", "parallel", "dependent", "digest"],
            outputKinds: ["decision", "report"],
            dataRequirements: [],
            instructionVersion: 1,
          },
        ],
      },
      versions: {
        plugin: "fixture",
        mode: "fixture",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    "open",
  );
  const gates = scripts.flatMap((script) =>
    script.kind === "wait"
      ? [script.gate]
      : script.kind === "save" && script.afterSave !== undefined
        ? [script.afterSave]
        : [],
  );
  let bridge: DispatchBridge | undefined;
  async function close() {
    for (const gate of gates) gate.released.resolve();
    try {
      await bridge?.close();
    } finally {
      try {
        await ctx.fiber.dispose();
      } finally {
        await memory.close();
        root.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  try {
    await mountAgentLoopTestDependencies(ctx, {
      workingDirectory: true,
      tools: { mode: "native" },
    });
    await ctx.plugin(Loader, { baseUrl: import.meta.url });
    await ctx.plugin(AgentPresetRegistry, { default: "research-task" });
    await ctx.agentPresets.register({ id: "research-task", plugins: [] });
    await ctx.agentPresets.register({ id: "parent-wide", plugins: [] });
    const adapter = new DispatchAdapter([...scripts]);
    ctx.llm.registerAdapter(["fixture"], adapter);
    await mountAgentLoopTestHarness(ctx);
    await ctx.plugin(SubagentRuntime, {});
    await ctx.plugin(SpawnInProcess, { providerName: "spawn" });
    const bindings = new SessionBindings();
    const sessions = new ResearchSessions(ctx, bindings);
    const prepared: RoleDispatchContext[] = [];
    const actualBridge = (bridge = new DispatchBridge(
      ctx,
      runs,
      sessions,
      (context) => {
        prepared.push(context);
        return {
          agentPreset: "research-task",
          prompt: [
            {
              type: "text",
              text: `Prepare ${context.claim.taskId} attempt ${context.claim.attempt}.`,
            },
          ],
          tools: [save],
        };
      },
      digests,
    ));
    const writeTools = createWriteTools(
      { artifacts, memory, digests: actualBridge, decisions },
      bindings,
      { freshness: { market: 0, fundamentals: 0, macro: 0 }, secCiks: {} },
    );
    for (const tool of writeTools) ctx.tools.register(tool);
    ctx.tools.register(unsafeTool("shell"));
    const save = writeTools.find((tool) => tool.name === "stock_save_report")!;
    const controls = createControlTools(actualBridge, bindings);
    for (const tool of controls) ctx.tools.register(tool);
    const children = new Map<
      string,
      {
        agent: Agent;
        binding: ResearchBinding;
        preset: string | undefined;
        tools: string[];
      }
    >();
    ctx.on("agent/created", ({ agent }) => {
      if (agent.session.header.origin === "subagent")
        children.set(agent.id, {
          agent,
          binding: bindings.require(agent).binding,
          preset: ctx.agentPresets.composedPreset(agent.ctx),
          tools: ctx.tools.schemas(agent).map((tool) => tool.name),
        });
      return undefined;
    });
    const parent = await ctx.agents.create({
      sessionId: SessionId("coordinator"),
      agentOptions: { provider: "fixture", model: "dispatch-fixture" },
      meta: { cwd: directory },
      async setup(agentCtx) {
        await ctx.agentPresets.mount(agentCtx, "parent-wide");
        agentCtx.tools.register(unsafeTool("parent_secret_tool"));
      },
    });
    bindings.bind(parent.agent, { kind: "coordinator", runIds: [runId] });
    const operation = { runId, identity: parent.agent.id };
    let callId = 0;
    function call(
      name: string,
      args: unknown,
      agent = parent.agent,
      signal = new AbortController().signal,
    ) {
      return ctx.tools.execute({
        agent,
        name,
        arguments: args,
        signal,
        callId: ToolCallId(`control-${++callId}`),
      });
    }
    function dispatch(
      requestId = "dispatch",
      taskId = "analysis",
      signal = new AbortController().signal,
    ) {
      return actualBridge.dispatch(
        parent.agent,
        runId,
        taskId,
        requestId,
        signal,
      );
    }
    return {
      ctx,
      root,
      runs,
      artifacts,
      runId,
      scope,
      bindings,
      sessions,
      bridge: actualBridge,
      digests,
      adapter,
      prepared,
      children,
      parent,
      operation,
      dispatch,
      call,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export class DigestAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(
    private readonly respond: (
      request: GenerateOptions,
    ) => AsyncIterable<StreamChunk>,
  ) {
    super();
  }
  stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    return this.respond(request);
  }
}

export async function* digestText(
  text: string,
  reason: FinishReason = { kind: "stop" },
  usage?: TokenUsage,
): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  if (usage !== undefined) yield { type: "usage", usage };
  yield { type: "finish", reason };
}

export async function* digestSubmit(
  request: GenerateOptions,
  draft: object,
  usage?: TokenUsage,
): AsyncIterable<StreamChunk> {
  if (request.messages.some((message) => message.role === "tool")) {
    yield* digestText("Digest submission finished.", { kind: "stop" }, usage);
    return;
  }
  let submitted = draft;
  if ("body" in draft && "facts" in draft) {
    const old = draft as {
      body: string;
      facts: (string | { text: string })[];
      disagreements: string[];
      riskSummaries: { issueId: string; text: string }[];
    };
    submitted = {
      summary: old.body,
      content: {
        keyPoints: old.facts.map((fact) =>
          typeof fact === "string" ? fact : fact.text,
        ),
        disagreements: old.disagreements,
        riskSummaries: old.riskSummaries,
        openQuestions: [],
      },
    };
  }
  const id = ToolCallId("submit-digest");
  const args = JSON.stringify(submitted);
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield {
    type: "tool-call-delta",
    index: 0,
    id,
    name: "stock_submit",
    argumentsDelta: args,
  };
  yield {
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id, name: "stock_submit", arguments: args },
  };
  if (usage !== undefined) yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

export function captureModelLogs(ctx: Context): ModelCallRecord[] {
  const records: ModelCallRecord[] = [];
  ctx.logger.exporter({
    export(message) {
      const record: unknown = message.args[0];
      if (
        typeof record === "object" &&
        record !== null &&
        "event" in record &&
        record.event === "stock.model"
      )
        records.push(record as ModelCallRecord & { event: "stock.model" });
    },
  });
  return records;
}
