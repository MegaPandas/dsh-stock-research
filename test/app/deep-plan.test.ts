import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createDeepInput, DEEP_MODE_VERSION } from "../../src/app/deep-plan.js";
import { APPLICATION_INPUT_NAME } from "../../src/app/research-input.js";
import { validateRunDefinition } from "../../src/services/definition.js";
import { US_SECURITY } from "../fixtures/market.js";

const scope = {
  security: US_SECURITY,
  date: "2024-01-03",
  cutoff: "2024-01-03T22:00:00.000Z",
};
const policy = () => ({
  freshness: { market: 0, fundamentals: 0, macro: 0 },
  secCiks: {},
});

describe("deep application plan", () => {
  it("matches the expected graph, stages and mandatory close contract", () => {
    const input = createDeepInput(scope, policy(), []);
    const documented = JSON.parse(
      fs.readFileSync(
        new URL("../fixtures/deep-workflow.json", import.meta.url),
        "utf8",
      ),
    ) as { tasks: unknown[] };
    expect(input.definition.mode).toBe("deep");
    expect(
      input.definition.tasks.map(({ id, dependsOn, inputTasks }) => ({
        id,
        dependsOn,
        inputTasks,
      })),
    ).toEqual(documented.tasks);
    expect(input.definition.tasks).toHaveLength(22);
    expect(
      input.definition.tasks.find((task) => task.id === "analysis.public"),
    ).toMatchObject({
      executor: { kind: "role", role: "analyst", specialty: "public" },
      outputKinds: ["analysis"],
    });
    expect(
      input.definition.tasks.filter((task) => task.executor.kind === "role"),
    ).toHaveLength(16);
    expect(input.definition.tasks.map((task) => task.id)).not.toContain(
      "analysis.news",
    );
    expect(
      input.definition.tasks.filter(
        (task) =>
          task.executor.kind === "service" &&
          task.executor.service === "digest",
      ),
    ).toHaveLength(5);
    expect(
      input.definition.tasks.filter(
        (task) =>
          task.executor.kind === "service" &&
          task.executor.service === "finalize",
      ),
    ).toHaveLength(1);
    expect(
      input.definition.tasks.find((task) => task.id === "manager.research"),
    ).toMatchObject({
      executor: { kind: "role", role: "manager" },
      outputKinds: ["plan"],
    });
    expect(
      input.definition.tasks.flatMap((task) =>
        task.dataRequirements.map((requirement) => ({
          taskId: task.id,
          ...requirement,
        })),
      ),
    ).toEqual([
      {
        taskId: "analysis.market",
        dataset: "market",
        fields: ["close"],
        requiredForDecision: true,
      },
    ]);
    expect(input.instructions?.map((item) => item.taskId).sort()).toEqual(
      input.definition.tasks.map((task) => task.id).sort(),
    );
    expect(
      input.instructions?.every((item) => item.instruction.trim().length > 0),
    ).toBe(true);
    expect(input.versions.mode).toBe(DEEP_MODE_VERSION);
    expect(DEEP_MODE_VERSION).toBe("deep/5");
    validateRunDefinition(input.definition);
  });

  it("captures independent scope, policy and task inputs for each deep run", () => {
    const callerScope = structuredClone(scope);
    const callerPolicy = policy();
    const input = createDeepInput(callerScope, callerPolicy, []);
    const saved = structuredClone(input);
    callerScope.security.id = "changed";
    callerPolicy.freshness.market = 999;
    expect(input).toEqual(saved);
    expect(
      input.inputs.find((item) => item.name === APPLICATION_INPUT_NAME)
        ?.content,
    ).toMatchObject({
      schemaVersion: 1,
      policy: policy(),
    });
    const another = createDeepInput(scope, policy(), []);
    input.definition.tasks[0]!.dependsOn.push("changed");
    input.instructions![0]!.instruction = "changed";
    expect(another).toEqual(saved);
  });
});
