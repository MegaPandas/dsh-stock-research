import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createQuickInput,
  QUICK_MODE_VERSION,
} from "../../src/app/quick-plan.js";
import { APPLICATION_INPUT_NAME } from "../../src/app/research-input.js";
import { ROLE_PROMPTS } from "../../src/app/research-prompts.js";
import { marketCapability } from "../../src/data/market.js";
import type { SourceDescription } from "../../src/services/query-sources.js";
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

describe("quick application plan", () => {
  it("matches the expected graph, role counts and mandatory close contract", () => {
    const input = createQuickInput(scope, policy(), []);
    const documented = JSON.parse(
      fs.readFileSync(
        new URL("../fixtures/quick-workflow.json", import.meta.url),
        "utf8",
      ),
    ) as { tasks: unknown[] };
    expect(
      input.definition.tasks.map(({ id, dependsOn, inputTasks }) => ({
        id,
        dependsOn,
        inputTasks,
      })),
    ).toEqual(documented.tasks);
    expect(input.definition.tasks).toHaveLength(12);
    expect(
      input.definition.tasks.find((task) => task.id === "analysis.public"),
    ).toMatchObject({
      executor: { kind: "role", role: "analyst", specialty: "public" },
      outputKinds: ["analysis"],
    });
    expect(
      input.definition.tasks.filter((task) => task.executor.kind === "role"),
    ).toHaveLength(8);
    expect(input.definition.tasks.map((task) => task.id)).not.toContain(
      "analysis.news",
    );
    expect(
      input.definition.tasks.filter(
        (task) =>
          task.executor.kind === "service" &&
          task.executor.service === "digest",
      ),
    ).toHaveLength(3);
    expect(
      input.definition.tasks.filter(
        (task) =>
          task.executor.kind === "service" &&
          task.executor.service === "finalize",
      ),
    ).toHaveLength(1);
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
    expect(input.instructions?.map((item) => item.taskId)).toEqual(
      input.definition.tasks.map((task) => task.id),
    );
    expect(
      input.instructions?.every((item) => item.instruction.trim().length > 0),
    ).toBe(true);
    expect(
      input.instructions?.find((item) => item.taskId === "analysis.market")
        ?.instruction,
    ).toContain("最新已完成日线");
    expect(input.versions.mode).toBe(QUICK_MODE_VERSION);
    expect(QUICK_MODE_VERSION).toBe("quick/7");
    expect(
      input.definition.tasks
        .filter((task) => task.id.startsWith("digest."))
        .map((task) => task.instructionVersion),
    ).toEqual([3, 3, 3]);
    validateRunDefinition(input.definition);
  });

  it("binds analysis to collected data and source-reported indicators", () => {
    const input = createQuickInput(scope, policy(), []);
    const instructions = new Map(
      input.instructions!.map((item) => [item.taskId, item.instruction]),
    );
    expect(instructions.get("analysis.market")).toContain("60根日线");
    expect(instructions.get("analysis.market")).toContain("52根周线");
    expect(instructions.get("analysis.market")).toContain("36根月线");
    expect(instructions.get("analysis.fundamentals")).toContain("12个报告期");
    expect(instructions.get("analysis.macro")).toContain("中国GDP");
    expect(ROLE_PROMPTS.analyst).toContain("数据目录");
    expect(ROLE_PROMPTS.analyst).toContain("stock_read_collection");
    expect(ROLE_PROMPTS.analyst).toContain("采用快照已有值");
    expect(ROLE_PROMPTS.analyst).not.toContain("fixedQueries");
    for (const [role, prompt] of Object.entries(ROLE_PROMPTS)) {
      if (role === "analyst") continue;
      expect(prompt).toContain("固定原始报告");
      expect(prompt).toContain("stock_submit");
      expect(prompt).toContain("业务JSON");
      expect(prompt).not.toContain("collectionSources");
      expect(prompt).not.toContain("inputRefs");
      expect(prompt).not.toContain("fixedQueries");
    }
  });

  it("captures independent scope, policy and prompt snapshots for each run", () => {
    const callerScope = structuredClone(scope);
    const callerPolicy = policy();
    const input = createQuickInput(callerScope, callerPolicy, []);
    const saved = structuredClone(input);
    callerScope.security.id = "changed";
    callerPolicy.freshness.market = 999;
    expect(input).toEqual(saved);
    expect(input.inputs[0]?.name).toBe(APPLICATION_INPUT_NAME);
    expect(input.inputs[0]?.content).toMatchObject({
      schemaVersion: 1,
      policy: policy(),
      prompts: ROLE_PROMPTS,
    });
    const another = createQuickInput(scope, policy(), []);
    input.definition.tasks[0]!.dependsOn.push("changed");
    input.versions.prompts.roles = "changed";
    expect(another).toEqual(saved);
  });

  it("pins enabled adapter versions and isolates the source catalogue", () => {
    const capability = marketCapability("tencent", "CN");
    const sources: SourceDescription[] = [
      { dataset: "market", provider: "tencent", capability },
      { dataset: "market", provider: "yahoo", capability: null },
    ];
    const input = createQuickInput(scope, policy(), sources);
    const saved = structuredClone(input);
    expect(input.versions.adapters).toEqual({
      "market/tencent": capability.adapterVersion,
    });
    expect(input.versions.normalization).toEqual({
      "market/tencent": capability.normalizationVersion,
    });
    expect(input.inputs[0]!.content).toMatchObject({
      sourceCatalogue: [sources[0]],
    });
    capability.adapterVersion = "changed";
    sources.pop();
    expect(input).toEqual(saved);
  });
});
