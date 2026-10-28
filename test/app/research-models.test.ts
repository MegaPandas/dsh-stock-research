import type { Agent } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureResearchModels,
  readResearchModels,
  RESEARCH_MODELS_INPUT,
  type ResearchModels,
} from "../../src/app/research-models.js";
import type { JsonValue } from "../../src/contracts/cache.js";
import type { DigestModelInput } from "../../src/contracts/digests.js";
import type { RunService } from "../../src/services/runs.js";
import { HostDigestModel } from "../../src/host/digest-model.js";
import { runtimeHost } from "../fixtures/runtime-host.js";
import {
  dispatchHost,
  DigestAdapter,
  digestSubmit,
} from "../fixtures/dispatch-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function parent() {
  const h = await runtimeHost();
  cleanups.push(h.close);
  h.outside.agent.options.reasoningEffort = ReasoningEffortId("high");
  h.outside.agent.options.maxTokens = 1024;
  return { h, agent: h.outside.agent };
}

function openSnapshot(
  runs: RunService,
  sourceRunId: string,
  models: ResearchModels,
) {
  const { versions } = runs.inputCatalog(sourceRunId);
  return runs.open(
    "model-snapshot",
    {
      definition: runs.readDefinition(sourceRunId),
      versions,
      inputs: [
        {
          name: RESEARCH_MODELS_INPUT,
          content: JSON.parse(JSON.stringify(models)) as JsonValue,
        },
      ],
    },
    "open-snapshot",
  ).runId;
}

describe("research run model snapshots", () => {
  it("captures inherited options independently for research and digest without changing the main Agent", async () => {
    const { agent } = await parent();
    const models = captureResearchModels(agent);
    const expected = {
      provider: "runtime-fixture",
      model: "runtime",
      reasoningEffort: "high",
      maxTokens: 1024,
    };
    expect(models).toEqual({ research: expected, digest: expected });
    models.digest.model = "digest-only";
    expect(models.research.model).toBe("runtime");
    expect(agent.options).toEqual(expected);
  });

  it("lets digest inherit a custom research route and output limit", async () => {
    const { agent } = await parent();
    expect(
      captureResearchModels(agent, {
        provider: "research",
        model: "research-model",
        reasoningEffort: ReasoningEffortId("low"),
      }),
    ).toEqual({
      research: {
        provider: "research",
        model: "research-model",
        reasoningEffort: "low",
        maxTokens: 1024,
      },
      digest: {
        provider: "research",
        model: "research-model",
        reasoningEffort: "low",
        maxTokens: 1024,
      },
    });
    expect(agent.options.model).toBe("runtime");
  });

  it("applies independent digest overrides and clears inherited effort on route changes", async () => {
    const { agent } = await parent();
    const models = captureResearchModels(
      agent,
      {
        provider: "research",
        model: "research-model",
        reasoningEffort: ReasoningEffortId("low"),
      },
      { provider: "digest", model: "digest-model" },
    );
    expect(models.research.reasoningEffort).toBe("low");
    expect(models.digest).toEqual({
      provider: "digest",
      model: "digest-model",
      maxTokens: 1024,
    });
    expect(
      captureResearchModels(agent, undefined, { reasoningEffort: null }).digest,
    ).toEqual({
      provider: "runtime-fixture",
      model: "runtime",
      maxTokens: 1024,
    });
    expect(
      captureResearchModels(agent, { reasoningEffort: null }).research
        .reasoningEffort,
    ).toBeUndefined();
  });

  it("reads detached persistent snapshots and keeps legacy runs without a snapshot", async () => {
    const h = await dispatchHost();
    cleanups.push(h.close);
    expect(readResearchModels(h.runs, h.runId)).toBeUndefined();
    const models = captureResearchModels(h.parent.agent);
    const runId = openSnapshot(h.runs, h.runId, models);
    models.research.model = "changed-after-start";
    h.parent.agent.options.model = "new-main-model";
    const stored = readResearchModels(h.runs, runId)!;
    expect(stored.research.model).toBe("dispatch-fixture");
    stored.digest.model = "changed-read";
    expect(readResearchModels(h.runs, runId)!.digest.model).toBe(
      "dispatch-fixture",
    );
  });

  it("dispatches using the saved route after the main Agent changes models", async () => {
    const h = await dispatchHost([{ kind: "save" }]);
    cleanups.push(h.close);
    const models = captureResearchModels(h.parent.agent);
    models.research.model = "saved-research-model";
    models.research.maxTokens = 512;
    const runId = openSnapshot(h.runs, h.runId, models);
    h.parent.agent.options.model = "new-main-model";
    h.parent.agent.options.maxTokens = 2048;
    const result = await h.bridge.dispatch(
      h.parent.agent,
      runId,
      "analysis",
      "saved-route",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(
      h.adapter.requests.every(
        (request) =>
          request.model === "saved-research-model" && request.maxTokens === 512,
      ),
    ).toBe(true);
    expect(h.parent.agent.options.model).toBe("new-main-model");
  });

  it("does not inherit a later effort or token limit when the saved same-route options omit them", async () => {
    const h = await dispatchHost([{ kind: "save" }]);
    cleanups.push(h.close);
    const models = captureResearchModels(h.parent.agent, {
      reasoningEffort: null,
    });
    const runId = openSnapshot(h.runs, h.runId, models);
    h.parent.agent.options.reasoningEffort = ReasoningEffortId("high");
    h.parent.agent.options.maxTokens = 2048;
    const result = await h.bridge.dispatch(
      h.parent.agent,
      runId,
      "analysis",
      "saved-default",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(h.adapter.requests[0]!.reasoningEffort).toBeUndefined();
    expect(h.adapter.requests[0]!.maxTokens).not.toBe(2048);
    expect(h.parent.agent.options.reasoningEffort).toBe("high");
    const child: Agent = h.children.get(result.sessionId!)!.agent;
    expect(child.options.reasoningEffort).toBeUndefined();
    expect(child.options.maxTokens).toBeUndefined();
  });

  it("generates a digest from its saved options instead of the current deployment config", async () => {
    const h = await runtimeHost();
    cleanups.push(h.close);
    const { runtime } = await h.mount(h.config({ enabledSources: [] }));
    const base = runtime.runs.open(
      "fixture",
      {
        definition: { scope: h.scope, mode: "quick", tasks: [] },
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
      "base",
    ).runId;
    const models = captureResearchModels(h.outside.agent, undefined, {
      provider: "saved-digest",
      model: "snapshot",
    });
    models.digest.maxTokens = 512;
    const runId = openSnapshot(runtime.runs, base, models);
    const adapter = new DigestAdapter((request) =>
      digestSubmit(request, {
        summary: "固定摘要",
        content: {
          keyPoints: [],
          disagreements: [],
          riskSummaries: [],
          openQuestions: [],
        },
      }),
    );
    h.ctx.llm.registerAdapter(["saved-digest"], adapter);
    const host = new HostDigestModel(h.ctx, {
      provider: "unavailable-live",
      model: "changed",
    });
    const input: DigestModelInput = {
      scope: h.scope,
      taskId: "digest",
      instructionVersion: 2,
      instruction: "Summarize the saved input.",
      artifacts: [],
      reports: [],
      references: [],
      numbers: [],
      risks: [],
      gaps: [],
    };
    const operation = {
      runId,
      taskId: "digest",
      attempt: 1,
      identity: h.outside.agent.id,
      sessionId: null,
    };
    const committed = { runId, taskId: "digest", attempt: 1, refs: [] };
    expect(
      await host.generate(
        input,
        new AbortController().signal,
        operation,
        () => committed,
      ),
    ).toEqual(committed);
    expect(adapter.requests[0]).toMatchObject({
      provider: "saved-digest",
      model: "snapshot",
      maxTokens: 512,
    });
    expect(h.outside.agent.options).toEqual({
      provider: "runtime-fixture",
      model: "runtime",
    });
  });
});
