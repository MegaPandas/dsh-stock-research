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
    ["src/artifacts/risks.ts", "../services/digest/index.js"],
    ["src/artifacts/gaps.ts", "../runs/store.js"],
    ["src/artifacts/risks.ts", "node:fs"],
    ["src/artifacts/references.ts", "../host/runtime.js"],
    ["src/artifacts/schema.ts", "../services/artifact-submission/index.js"],
    ["src/artifacts/agent-reports.ts", "../storage/data-root.js"],
    ["src/artifacts/stage-handoff.ts", "@deepseek-ai/dsh-agent"],
    ["src/artifacts/agent-reports.ts", "../report/agent-report.js"],
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
    [
      "src/services/artifact-submission/index.ts",
      "../../artifacts/references.js",
    ],
    ["src/app/role-preparation/role.ts", "../../artifacts/risks.js"],
    ["src/services/digest/index.ts", "./inputs.js"],
    ["src/tools/read.ts", "../artifacts/schema.js"],
    ["src/host/report-draft.ts", "../artifacts/agent-reports.js"],
    ["src/host/report-draft.ts", "../artifacts/stage-handoff.js"],
    ["src/services/artifact-inputs.ts", "../artifacts/analysis-report.js"],
    ["src/services/digest/draft.ts", "../../artifacts/schema.js"],
    ["src/artifacts/schema.ts", "./shape.js"],
    ["src/artifacts/agent-reports.ts", "../valuation/report-policy.js"],
    ["src/app/role-preparation/role.ts", "../../services/agent-artifacts.js"],
    ["src/services/agent-artifacts.ts", "../report/agent-report.js"],
    ["src/services/agent-artifacts.ts", "../valuation/rating-policy.js"],
  ])(
    "allows the declared dependency from %s to %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    'import { object } from "../../artifacts/shape.js";',
    'const parser = import("../../artifacts/nested/new-parser.js");',
  ])("keeps parsing implementation files private", async (source) => {
    const errors = await boundaryErrors(
      "src/services/numbers/session.ts",
      source,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each(["../artifacts/schema.js", "../services/agent-artifacts.js"])(
    "keeps report rendering independent of %s",
    async (dependency) => {
      const errors = await boundaryErrors(
        "src/report/agent-report.ts",
        `import { Value } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Report rendering");
    },
  );

  it.each([
    "../artifacts/schema.js",
    "./artifact-submission/index.js",
    "node:fs",
  ])(
    "keeps parsing and I/O out of validated report assembly: %s",
    async (dependency) => {
      const errors = await boundaryErrors(
        "src/services/agent-artifacts.ts",
        `import { value } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Report assembly");
    },
  );

  it.each([
    [
      "src/app/new-use-case.ts",
      "../services/artifact-submission/requirements.js",
    ],
    ["src/services/decisions.ts", "./artifact-submission/nested/new-rule.js"],
  ])("keeps submission rules private from %s", async (file, dependency) => {
    const errors = await boundaryErrors(file, `export * from "${dependency}";`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/core.ts", "./services/artifact-submission/index.js"],
    [
      "src/host/tool-protocol/errors.ts",
      "../../services/artifact-submission/index.js",
    ],
    ["src/services/digest/index.ts", "../artifact-submission/index.js"],
    ["src/services/artifact-submission/index.ts", "./requirements.js"],
    ["src/services/artifact-submission/index.ts", "../decision-basics.js"],
  ])("allows the submission boundary from %s", async (file, dependency) => {
    expect(
      await boundaryErrors(file, `import { Value } from "${dependency}";`),
    ).toEqual([]);
  });

  it.each([
    ["src/core.ts", "./services/numbers/session.js"],
    ["src/services/artifact-submission/index.ts", "../numbers/session.js"],
    ["src/tools/read.ts", "../services/numbers/nested/internal.js"],
  ])(
    "keeps numeric check sessions private from %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `export * from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.messageId).toBe("privateEntry");
    },
  );

  it.each([
    ["src/core.ts", "./services/numbers/index.js"],
    ["src/services/artifact-submission/index.ts", "../numbers/index.js"],
  ])("allows the numeric checker entry from %s", async (file, dependency) => {
    expect(
      await boundaryErrors(
        file,
        `import { NumberService } from "${dependency}";`,
      ),
    ).toEqual([]);
  });
});
