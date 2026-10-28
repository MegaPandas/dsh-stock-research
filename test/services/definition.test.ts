import { describe, expect, it } from "vitest";
import type { ArtifactKind } from "../../src/contracts/artifacts.js";
import type {
  RunDefinition,
  TaskDefinition,
} from "../../src/contracts/workflow.js";
import { validateRunDefinition } from "../../src/services/definition.js";

function task(
  id: string,
  dependsOn: string[] = [],
  inputTasks = dependsOn,
): TaskDefinition {
  return {
    id,
    executor: { kind: "role", role: "analyst", specialty: "market" },
    dependsOn,
    inputTasks,
    outputKinds: ["analysis"],
    dataRequirements: [],
    instructionVersion: 1,
  };
}
function definition(tasks: TaskDefinition[]): RunDefinition {
  return {
    scope: {
      security: {
        id: "US:NVDA",
        market: "US",
        symbol: "NVDA",
        exchange: "NASDAQ",
        currency: "USD",
        timeZone: "America/New_York",
      },
      date: "2024-01-02",
      cutoff: "2024-01-02T21:00:00.000Z",
    },
    mode: "quick",
    tasks,
  };
}
function invalid(value: RunDefinition, detail: string): void {
  expect(() => validateRunDefinition(value)).toThrowError(
    expect.objectContaining({
      code: "INVALID_INPUT",
      message: expect.stringContaining(detail),
    }),
  );
}

describe("run definition semantics", () => {
  it("accepts an unsorted diamond graph and a subset of dependency inputs without modifying it", () => {
    const value = definition([
      task("join", ["left", "right"], ["right"]),
      task("right", ["root"]),
      task("root"),
      task("left", ["root"]),
      task("independent"),
    ]);
    const before = structuredClone(value);
    expect(validateRunDefinition(value)).toBeUndefined();
    expect(value).toEqual(before);
  });

  it("rejects repeated task identifiers", () => {
    invalid(definition([task("same"), task("same")]), "duplicate identifier");
  });

  it("rejects missing dependencies even when they are not default inputs", () => {
    invalid(
      definition([task("child", ["missing"], [])]),
      "dependency missing does not exist",
    );
  });

  it("rejects default inputs outside the declared dependencies", () => {
    invalid(
      definition([task("root"), task("child", [], ["root"])]),
      "input root is not a dependency",
    );
  });

  it("rejects self dependency", () => {
    invalid(definition([task("self", ["self"])]), "dependency cycle");
  });

  it("rejects a cycle in a disconnected part of the graph", () => {
    invalid(
      definition([
        task("independent"),
        task("a", ["b"]),
        task("b", ["c"]),
        task("c", ["a"]),
      ]),
      "dependency cycle",
    );
  });

  it.each(["dependsOn", "inputTasks"] as const)(
    "rejects duplicate %s edges",
    (field) => {
      const child = task("child", ["root"]);
      child[field] = ["root", "root"];
      invalid(
        definition([task("root"), child]),
        field === "dependsOn"
          ? "dependencies must be unique"
          : "input tasks must be unique",
      );
    },
  );

  const executors: {
    executor: TaskDefinition["executor"];
    outputs: ArtifactKind[];
    rejected: ArtifactKind;
  }[] = [
    {
      executor: { kind: "role", role: "analyst", specialty: "market" },
      outputs: ["analysis"],
      rejected: "decision_draft",
    },
    {
      executor: { kind: "role", role: "discussion", specialty: "risk" },
      outputs: ["risk", "debate"],
      rejected: "analysis",
    },
    {
      executor: { kind: "role", role: "manager", specialty: "portfolio" },
      outputs: ["plan", "decision_draft"],
      rejected: "decision",
    },
    {
      executor: { kind: "service", service: "digest" },
      outputs: ["digest"],
      rejected: "report",
    },
    {
      executor: { kind: "service", service: "finalize" },
      outputs: ["report", "decision"],
      rejected: "decision_draft",
    },
  ];
  it.each(executors)(
    "accepts the output set of $executor",
    ({ executor, outputs }) => {
      const value = task("producer");
      value.executor = executor;
      value.outputKinds = outputs;
      expect(validateRunDefinition(definition([value]))).toBeUndefined();
    },
  );
  it.each(executors)(
    "rejects a foreign output kind for $executor",
    ({ executor, outputs, rejected }) => {
      const value = task("producer");
      value.executor = executor;
      value.outputKinds = [...outputs, rejected];
      invalid(definition([value]), `output kind ${rejected} does not match`);
    },
  );

  it.each([
    { outputKinds: [] as ArtifactKind[] },
    { outputKinds: ["analysis", "analysis"] as ArtifactKind[] },
  ])(
    "rejects empty or duplicate output kinds $outputKinds",
    ({ outputKinds }) => {
      const value = task("producer");
      value.outputKinds = outputKinds;
      invalid(
        definition([value]),
        outputKinds.length === 0
          ? "at least one output kind"
          : "output kinds must be unique",
      );
    },
  );

  it.each(["decision", "report"] as const)(
    "rejects finalize without the companion of %s",
    (kind) => {
      const value = task("finalize");
      value.executor = { kind: "service", service: "finalize" };
      value.outputKinds = [kind];
      invalid(definition([value]), "both decision and report");
    },
  );
});
