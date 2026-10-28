import fs from "node:fs";
import { join } from "node:path";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickInput } from "../../src/app/quick-plan.js";
import { createReplayInput } from "../../src/app/replay-input.js";
import type { ReportPayload } from "../../src/contracts/artifact-payloads.js";
import type {
  ResearchRun,
  TaskInstructionSnapshot,
} from "../../src/contracts/runs.js";
import { quickHost, lastToolText, toolCall } from "../fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
} from "../fixtures/research-workflow.js";

const cleanups: (() => Promise<void>)[] = [];
// Each case executes both the source and replay through full Agent/tool/review loops.
const REPLAY_TEST_TIMEOUT_MS = 15_000;
async function marketResponse() {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        sz002594: {
          day: [["2024-01-03", "190", "192", "193", "189", "100"]],
        },
      },
    }),
  );
}
const fetch = vi.fn<typeof globalThis.fetch>(marketResponse);
const scope = {
  security: {
    id: "CN:002594.SZ",
    market: "CN" as const,
    symbol: "002594.SZ",
    exchange: "SZ",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2024-01-03",
  cutoff: "2024-01-03T08:00:00.000Z",
};

beforeEach(() => {
  fetch.mockReset();
  fetch.mockImplementation(marketResponse);
  vi.stubGlobal("fetch", fetch);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(scope.cutoff));
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

function manifest(h: Awaited<ReturnType<typeof quickHost>>, runId: string) {
  const relative = h
    .runFiles()
    .find((path) => path.endsWith(join(runId, "manifest.json")))!;
  const text = fs.readFileSync(join(h.directory, "runs", relative), "utf8");
  return { text, content: JSON.parse(text) as ResearchRun };
}

function savedInputs(h: Awaited<ReturnType<typeof quickHost>>, runId: string) {
  const catalog = h.runtime.runs.inputCatalog(runId);
  return {
    static: catalog.inputs
      .filter(
        (input) =>
          input.instruction === undefined && input.memory === undefined,
      )
      .map((input) => ({
        name: input.name,
        content: h.runtime.runs.readInput(runId, input.ref),
      })),
    instructions: catalog.inputs
      .filter((input) => input.instruction !== undefined)
      .map((input) => {
        const saved = h.runtime.runs.readInput<TaskInstructionSnapshot>(
          runId,
          input.ref,
        );
        return {
          taskId: saved.taskId,
          version: saved.version,
          instruction: saved.instruction,
        };
      }),
  };
}

describe("stock-replay command", () => {
  it.each([
    { mode: "quick", nodes: 12 },
    { mode: "deep", nodes: 22 },
  ] as const)(
    "replays all $mode tasks offline without changing the source run",
    async ({ mode, nodes }) => {
      const originalModel = workflowModel();
      const replayModel = workflowModel();
      let current = originalModel;
      let replaying = false;
      let attemptedSourceRead = false;
      let sourceReadFeedback: string | undefined;
      const h = await quickHost(async function* (
        request: GenerateOptions,
      ): AsyncIterable<StreamChunk> {
        if (replaying && isMainResearchRequest(request)) {
          if (!attemptedSourceRead) {
            attemptedSourceRead = true;
            yield* toolCall(
              "stock_read_run",
              { runId: sourceRunId },
              "source-read",
            );
            return;
          }
          sourceReadFeedback ??= lastToolText(request);
        }
        yield* current.respond(request);
      });
      cleanups.push(h.close);
      const first = await h.executeAndWait(
        `/stock-${mode} SZ.002594 2024-01-03`,
      );
      expect(first?.result.kind).toBe("success");
      const sourceRunId = originalModel.state.runId!;
      const source = h.runtime.runs.view({ runId: sourceRunId });
      const originalManifest = manifest(h, sourceRunId);
      const originalInputs = savedInputs(h, sourceRunId);
      const originalArtifacts = structuredClone(
        source.tasks.flatMap((task) =>
          task.outputRefs.map((ref) => h.runtime.runs.readArtifact(ref)),
        ),
      );
      const originalMarket = h.runtime.runs.readArtifact(
        originalModel.state.marketRef!,
      ).content.claims[0]!;
      if (originalMarket.kind !== "observed")
        throw new Error("Expected market observation");
      const originalEvidence = h.runtime.runs.readEvidence(
        originalMarket.source,
      );
      expect(fetch).toHaveBeenCalledTimes(3);
      fetch.mockImplementation(async () => {
        throw new Error(
          "Replay must use stored evidence, never a data request",
        );
      });
      vi.setSystemTime(new Date("2024-01-04T08:00:00.000Z"));
      current = replayModel;
      replaying = true;
      const result = await h.executeAndWait(`/stock-replay ${sourceRunId}`);
      expect(result?.result.kind).toBe("success");
      expect(sourceReadFeedback).toContain(sourceRunId);
      const replayId = replayModel.state.runId!;
      expect(replayId).not.toBe(sourceRunId);
      const replay = h.runtime.runs.view({ runId: replayId });
      expect(replay).toMatchObject({
        mode,
        scope: source.scope,
        status: "completed",
        lineage: {
          sourceRunId,
          sourceRevision: originalManifest.content.revision,
        },
      });
      expect(replay.tasks).toHaveLength(nodes);
      expect(
        replay.tasks.every(
          (task) => task.status === "succeeded" && task.attempt === 1,
        ),
      ).toBe(true);
      expect(replayModel.state.taskIds).toHaveLength(nodes);
      expect(
        replay.tasks
          .flatMap((task) => task.outputRefs)
          .every((ref) => ref.runId === replayId),
      ).toBe(true);
      expect(h.runtime.runs.readDefinition(replayId)).toEqual(
        h.runtime.runs.readDefinition(sourceRunId),
      );
      expect(h.runtime.runs.inputCatalog(replayId).versions).toEqual(
        originalManifest.content.versions,
      );
      expect(savedInputs(h, replayId)).toEqual(originalInputs);
      expect(manifest(h, replayId).content.createdAt).toBe(
        "2024-01-04T08:00:00.000Z",
      );
      const replayMarket = h.runtime.runs.readArtifact(
        replayModel.state.marketRef!,
      ).content.claims[0]!;
      if (replayMarket.kind !== "observed")
        throw new Error("Expected replayed observation");
      expect(replayMarket.source.runId).toBe(replayId);
      expect(replayMarket.source.evidenceId).not.toBe(
        originalMarket.source.evidenceId,
      );
      const replayEvidence = h.runtime.runs.readEvidence(replayMarket.source);
      const { candidateClaims: originalCandidates, ...originalEnvelope } =
        originalEvidence.envelope;
      const { candidateClaims: replayCandidates, ...replayEnvelope } =
        replayEvidence.envelope;
      expect(replayEnvelope).toEqual(originalEnvelope);
      expect(replayEvidence.replayedFrom).toEqual({
        ...originalMarket.source,
        selector: "/data",
      });
      expect(replayCandidates).toEqual(
        originalCandidates.map((candidate) => ({
          ...candidate,
          source: {
            ...candidate.source,
            runId: replayId,
            evidenceId: replayMarket.source.evidenceId,
          },
        })),
      );
      const report = replay.tasks
        .find((task) => task.taskId === "finalize")!
        .outputRefs.map((ref) => h.runtime.runs.readArtifact(ref).content)
        .find((content) => content.kind === "report")!.payload as ReportPayload;
      expect(report.gaps).toContainEqual(
        expect.objectContaining({
          kind: "source",
          source: expect.objectContaining({
            runId: replayId,
            evidenceId: replayMarket.source.evidenceId,
          }),
          gap: expect.objectContaining({
            code: "unverified_time",
            field: "/data/rows",
          }),
        }),
      );
      expect(h.runtime.runs.view({ runId: sourceRunId })).toEqual(source);
      expect(manifest(h, sourceRunId).text).toBe(originalManifest.text);
      expect(
        source.tasks.flatMap((task) =>
          task.outputRefs.map((ref) => h.runtime.runs.readArtifact(ref)),
        ),
      ).toEqual(originalArtifacts);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
      for (const agent of h.created)
        expect(h.ctx.sessions.get(agent.id)).toBeUndefined();
    },
    REPLAY_TEST_TIMEOUT_MS,
  );

  it("rejects an unavailable version before opening a replay or calling a model", async () => {
    const model = workflowModel();
    const h = await quickHost(model.respond);
    cleanups.push(h.close);
    const input = createQuickInput(scope, h.runtime.policy, []);
    input.versions.prompts.digest = "unavailable";
    const { runId } = h.runtime.runs.open(h.outside.agent.id, input, "source");
    const before = manifest(h, runId);
    const files = h.runFiles();
    await expect(h.execute(`/stock-replay ${runId}`)).rejects.toMatchObject({
      code: "VERSION_UNAVAILABLE",
    });
    expect(h.runFiles()).toEqual(files);
    expect(manifest(h, runId).text).toBe(before.text);
    expect(h.adapter.requests).toEqual([]);
    expect(h.created).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays supported saved role and digest protocols after a protocol upgrade", async () => {
    const h = await quickHost(workflowModel().respond);
    cleanups.push(h.close);
    const input = createQuickInput(scope, h.runtime.policy, []);
    input.versions.prompts.roles = "21";
    input.versions.prompts.digest = "11";
    input.versions.prompts.coordinator = "10";
    const { runId } = h.runtime.runs.open(
      h.outside.agent.id,
      input,
      "old-source",
    );
    const replay = createReplayInput(h.runtime.runs, runId);
    expect(replay.versions.prompts).toMatchObject({
      roles: "21",
      digest: "11",
      coordinator: "10",
    });
    expect(
      h.runtime.runs.open(h.outside.agent.id, replay, "old-replay").runId,
    ).toBeTruthy();
  });

  it("opens an offline replay whose installed SEC code is disabled and unconfigured", async () => {
    const h = await quickHost(workflowModel().respond);
    cleanups.push(h.close);
    const input = createQuickInput(scope, h.runtime.policy, []);
    input.versions.adapters["fundamentals/sec"] = "1";
    input.versions.normalization["fundamentals/sec"] = "1";
    const { runId } = h.runtime.runs.open(h.outside.agent.id, input, "source");
    const before = manifest(h, runId);
    expect(h.runtime.policy.secCiks).toEqual({});
    expect(
      h.runtime.queries
        .health(scope)
        .sources.find((source) => source.provider === "sec")?.capability,
    ).toBeNull();
    const replay = createReplayInput(h.runtime.runs, runId);
    const opened = h.runtime.runs.open(h.outside.agent.id, replay, "replay");
    expect(h.runtime.runs.view(opened)).toMatchObject({
      status: "active",
      lineage: { sourceRunId: runId },
    });
    expect(
      h.runtime.runs
        .view(opened)
        .tasks.every(
          (task) =>
            task.status === "pending" &&
            task.attempt === 0 &&
            task.outputRefs.length === 0,
        ),
    ).toBe(true);
    expect(manifest(h, runId).text).toBe(before.text);
    expect(h.adapter.requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
