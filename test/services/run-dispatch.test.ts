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

function planner(saved: RunDefinition, readyTasks = ["first", "second"]) {
  return new RunDispatchPlanner({
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
    expect(() => planner(saved).assertIndividual("run", "first")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(saved).toEqual(original);
  });

  it("allows a single ready revision and stages without the together policy", () => {
    expect(() =>
      planner(definition(), ["first"]).assertIndividual("run", "first"),
    ).not.toThrow();
    expect(() =>
      planner(definition(false)).assertIndividual("run", "first"),
    ).not.toThrow();
    const unstaged = definition();
    delete unstaged.stages;
    expect(() =>
      planner(unstaged).assertIndividual("run", "first"),
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
    const dispatch = planner(definition());
    expect(() =>
      dispatch.assertStageReady(["second", "first"], ["first"]),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    expect(() =>
      dispatch.assertStageReady(["second", "first"], ["first", "second"]),
    ).not.toThrow();
  });
});
