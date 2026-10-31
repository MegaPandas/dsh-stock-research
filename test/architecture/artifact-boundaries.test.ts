import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "no-restricted-imports" ||
      ruleId === "no-restricted-syntax" ||
      ruleId === "architecture/module-entry-points",
  );
}

describe("artifact rule boundaries", () => {
  it.each([
    ["src/artifacts/references.ts", "../services/artifact-inputs.js"],
    ["src/artifacts/risks.ts", "../services/digest-inputs.js"],
    ["src/artifacts/gaps.ts", "../runs/store.js"],
    ["src/artifacts/risks.ts", "node:fs"],
    ["src/artifacts/references.ts", "../host/runtime.js"],
    ["src/artifacts/schema.ts", "../services/artifacts.js"],
    ["src/artifacts/agent-reports.ts", "../storage/data-root.js"],
    ["src/artifacts/stage-handoff.ts", "@deepseek-ai/dsh-agent"],
  ])(
    "rejects an upper or I/O dependency from %s to %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `export * from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Artifact rules");
    },
  );

  it.each([
    ["src/artifacts/risks.ts", "node:util"],
    ["src/artifacts/gaps.ts", "../contracts/artifact-payloads.js"],
    ["src/services/artifacts.ts", "../artifacts/references.js"],
    ["src/app/agent-role.ts", "../artifacts/risks.js"],
    ["src/services/digests.ts", "./digest-inputs.js"],
    ["src/tools/read.ts", "../artifacts/schema.js"],
    ["src/host/report-draft.ts", "../artifacts/agent-reports.js"],
    ["src/host/report-draft.ts", "../artifacts/stage-handoff.js"],
    ["src/services/artifact-inputs.ts", "../artifacts/analysis-report.js"],
    ["src/services/digest-draft.ts", "../artifacts/schema.js"],
    ["src/artifacts/schema.ts", "./shape.js"],
    ["src/artifacts/agent-reports.ts", "../valuation/report-policy.js"],
  ])(
    "allows the declared dependency from %s to %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    'import { object } from "../artifacts/shape.js";',
    'const parser = import("../artifacts/nested/new-parser.js");',
  ])("keeps parsing implementation files private", async (source) => {
    const errors = await boundaryErrors(
      "src/services/business-reports.ts",
      source,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    [
      "src/app/agent-role.ts",
      'import { digestNumbers } from "../services/digest-inputs.js";',
    ],
    ["src/core.ts", 'export * from "./services/digest-draft.js";'],
    [
      "src/services/decisions.ts",
      'import { digestNumbers } from "./digest-inputs.js";',
    ],
    ["src/services/numbers.ts", 'export * from "./digest-draft.js";'],
  ])(
    "keeps digest assembly internal to its service from %s",
    async (file, source) => {
      const errors = await boundaryErrors(file, source);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("digest assembly internals");
    },
  );
});
