import { describe, expect, it } from "vitest";
import type {
  RunDefinition,
  TaskDefinition,
} from "../../src/contracts/workflow.js";
import { RunDispatchPlanner } from "../../src/services/run-dispatch.js";
import { CN_SECURITY } from "../fixtures/market.js";

function definition(together = true): RunDefinition {
  return {
    scope: {
      security: CN_SECURITY,
      date: "2026-10-30",
      cutoff: "2026-10-30T23:59:59.999Z",
    },
    mode: "quick",
    tasks: ["first", "second"].map((id): TaskDefinition => ({
      id,
      executor: { kind: "role", role: "analyst", specialty: id },
      dependsOn: [],
      inputTasks: [],
      outputKinds: ["analysis"],
      dataRequirements: [],
      instructionVersion: 1,
    })),
    stages: [
      {
        id: "analysis",
        taskIds: ["second", "first"],
        beforeTasks: [],
        ...(together ? { dispatch: "together" as const } : {}),
      },
    ],
  };
}

const operation = { runId: "run", identity: "owner" };

function planner(
  saved: RunDefinition,
  readyTasks = ["first", "second"],
  claimedRequests: readonly string[] = [],
) {
  const receipts = new Set(
    claimedRequests.map((requestId) => JSON.stringify(["dispatch", requestId])),
  );
  return new RunDispatchPlanner({
    hasClaimReceipt: (_operation, requestId) => receipts.has(requestId),
    readDefinition: () => saved,
    view: () => ({
      runId: "run",
      lineage: null,
      scope: saved.scope,
      mode: saved.mode,
      status: "active",
      readyTasks,
      tasks: [],
      currentDigest: null,
      blockReasons: [],
    }),
  });
}

describe("workflow dispatch eligibility", () => {
  it("rejects individual dispatch for multiple ready together members without changing the definition", () => {
    const saved = definition();
    const original = structuredClone(saved);
    expect(() =>
      planner(saved).assertIndividual(operation, "first", "new"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(saved).toEqual(original);
  });

  it("allows a single ready revision and stages without the together policy", () => {
    expect(() =>
      planner(definition(), ["first"]).assertIndividual(
        operation,
        "first",
        "new",
      ),
    ).not.toThrow();
    expect(() =>
      planner(definition(false)).assertIndividual(operation, "first", "new"),
    ).not.toThrow();
    const unstaged = definition();
    delete unstaged.stages;
    expect(() =>
      planner(unstaged).assertIndividual(operation, "first", "new"),
    ).not.toThrow();
  });

  it("selects all role members in the saved stage order", () => {
    expect(planner(definition()).stageTasks("run", "analysis")).toEqual([
      "second",
      "first",
    ]);
  });

  it("rejects an unknown stage or a stage containing service tasks", () => {
    expect(() =>
      planner(definition()).stageTasks("run", "missing"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const saved = definition(false);
    saved.tasks[1]!.executor = { kind: "service", service: "digest" };
    saved.tasks[1]!.outputKinds = ["digest"];
    expect(() => planner(saved).stageTasks("run", "analysis")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("requires every member to be ready for a new stage dispatch", () => {
    expect(() =>
      planner(definition(), ["first"]).stageRequests(
        operation,
        "analysis",
        ["second", "first"],
        "pair",
      ),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    expect(
      planner(definition()).stageRequests(
        operation,
        "analysis",
        ["second", "first"],
        "pair",
      ),
    ).toEqual([
      { taskId: "second", requestId: '["stage","analysis","pair","second"]' },
      { taskId: "first", requestId: '["stage","analysis","pair","first"]' },
    ]);
  });

  it("replays an individual receipt before checking current together eligibility", () => {
    const dispatch = planner(definition(), ["first", "second"], ["old"]);
    expect(() =>
      dispatch.assertIndividual(operation, "first", "old"),
    ).not.toThrow();
    expect(() =>
      dispatch.assertIndividual(operation, "first", "new"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects a partially claimed batch without selecting its remaining members", () => {
    const saved = definition();
    const original = structuredClone(saved);
    const dispatch = planner(
      saved,
      ["second"],
      ['["stage","analysis","pair","first"]'],
    );
    expect(() =>
      dispatch.stageRequests(
        operation,
        "analysis",
        ["second", "first"],
        "pair",
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(saved).toEqual(original);
  });

  it("selects fully claimed historical batches without requiring current readiness", () => {
    const dispatch = planner(
      definition(),
      [],
      [
        '["stage","analysis","pair","first"]',
        '["stage","analysis","pair","second"]',
      ],
    );
    expect(
      dispatch.stageRequests(
        operation,
        "analysis",
        ["second", "first"],
        "pair",
      ),
    ).toEqual([
      { taskId: "second", requestId: '["stage","analysis","pair","second"]' },
      { taskId: "first", requestId: '["stage","analysis","pair","first"]' },
    ]);
    expect(() =>
      dispatch.stageRequests(operation, "analysis", ["second", "first"], "new"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
  });
});
