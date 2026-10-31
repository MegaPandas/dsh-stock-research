import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "architecture/module-entry-points",
  );
}

describe("tool adapter entries", () => {
  it.each([
    [
      "src/app/review-preparation/index.ts",
      'import { rememberInput } from "../../tools/write-inputs.js";',
    ],
    [
      "src/host/report-draft.ts",
      'import { saveReportParameters } from "../tools/artifact-inputs.js";',
    ],
    ["src/core.ts", 'export * from "./tools/write-inputs.js";'],
    [
      "src/host/runtime.ts",
      'const tool = import("../tools/nested/new-internal.js");',
    ],
  ])("keeps tool input assembly private from %s", async (file, source) => {
    const errors = await boundaryErrors(file, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/host/runtime.ts", "../tools/data.js"],
    ["src/host/runtime.ts", "../tools/write.js"],
    ["src/host/runtime.ts", "../tools/read.js"],
    ["src/host/runtime.ts", "../tools/control.js"],
    ["src/host/report-draft.ts", "../tools/parameters.js"],
    ["src/app/report-reader.ts", "../tools/errors.js"],
    ["src/app/role-preparation/role.ts", "../../tools/valuation.js"],
    ["src/app/review-preparation/tools.ts", "../../tools/query-inputs.js"],
    ["src/app/review-preparation/tools.ts", "../../tools/query-scope.js"],
    ["src/tools/write.ts", "./write-inputs.js"],
    ["src/tools/write.ts", "./artifact-inputs.js"],
    ["src/tools/read.ts", "./artifact-inputs.js"],
  ])(
    "allows the tool factory or shared adapter entry from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );
});
