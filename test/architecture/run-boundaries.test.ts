import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-syntax",
  );
}

describe("run capability boundaries", () => {
  it.each([
    "src/app/research-application.ts",
    "src/tools/read.ts",
    "src/services/numbers.ts",
    "src/host/runtime.ts",
    "src/host/dispatch.ts",
  ])("rejects a concrete run implementation import from %s", async (file) => {
    const errors = await boundaryErrors(
      file,
      'import type { RunService } from "../services/runs.js";',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("run capabilities");
  });

  it.each([
    ["src/core.ts", 'export { RunService } from "./services/runs.js";'],
    ["src/core.ts", 'export * from "./services/runs.js";'],
    ["src/runtime.ts", 'export { RunService } from "./services/runs.js";'],
  ])(
    "rejects publishing the run implementation from %s",
    async (file, source) => {
      expect(await boundaryErrors(file, source)).toHaveLength(1);
    },
  );

  it.each([
    [
      "src/host/dispatch.ts",
      'import type { RunAccess } from "../contracts/run-access.js";',
    ],
    [
      "src/services/numbers.ts",
      'import type { RunReader } from "../contracts/run-access.js";',
    ],
    [
      "src/core.ts",
      'export { createRunService } from "./services/create-run-service.js";',
    ],
    [
      "src/services/create-run-service.ts",
      'import { RunService } from "./runs.js";',
    ],
  ])(
    "allows the declared capability boundary from %s",
    async (file, source) => {
      expect(await boundaryErrors(file, source)).toEqual([]);
    },
  );
});
