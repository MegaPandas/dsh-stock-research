import { afterEach, expect, it, vi } from "vitest";
import { runtimeHost } from "../fixtures/runtime-host.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it.each(["12", "8"])(
  "assembles fixed handoffs without model execution for prompt metadata %s",
  async (digest) => {
    const h = await runtimeHost();
    cleanups.push(h.close);
    const { runtime } = await h.mount();
    const { runId } = runtime.runs.open(
      h.outside.agent.id,
      {
        definition: {
          scope: h.scope,
          mode: "quick",
          tasks: [
            {
              id: "source",
              executor: { kind: "role", role: "analyst", specialty: "market" },
              dependsOn: [],
              inputTasks: [],
              outputKinds: ["analysis"],
              dataRequirements: [],
              instructionVersion: 1,
            },
            {
              id: "handoff",
              executor: { kind: "service", service: "digest" },
              dependsOn: ["source"],
              inputTasks: ["source"],
              outputKinds: ["digest"],
              dataRequirements: [],
              instructionVersion: 1,
            },
          ],
        },
        versions: {
          plugin: "1",
          mode: "fixture",
          prompts: { digest },
          skills: {},
          adapters: {},
          normalization: {},
        },
        inputs: [],
      },
      "open",
    );
    const operation = { runId, identity: h.outside.agent.id };
    const claim = runtime.runs.claim(operation, "source", "source");
    const upstream = runtime.runs.commitArtifact(
      { ...claim, identity: "analyst", sessionId: null },
      [
        {
          kind: "analysis",
          title: "Fixed source",
          body: "Full report",
          inputRefs: [],
          claims: [],
          payload: {
            schemaVersion: 3,
            report: agentAnalysisReport(),
            stageHandoff: {
              keyPoints: ["Fixed conclusion"],
              disagreements: [],
              risks: [],
              openQuestions: [],
            },
          },
        },
      ],
      "save",
    );
    const create = vi.spyOn(h.ctx.agents, "create");
    const result = await runtime.dispatch.makeDigest(
      operation,
      "handoff",
      "digest",
    );
    expect(runtime.runs.readArtifact(result.refs[0]!).content).toMatchObject({
      inputRefs: upstream.refs,
      payload: {
        report: { content: { keyPoints: ["[source] Fixed conclusion"] } },
      },
    });
    expect(
      await runtime.dispatch.makeDigest(operation, "handoff", "digest"),
    ).toEqual(result);
    expect(create).not.toHaveBeenCalled();
    expect(h.adapter.requests).toEqual([]);
  },
);
