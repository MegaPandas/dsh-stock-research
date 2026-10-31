import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "no-restricted-imports" || ruleId === "no-restricted-syntax",
  );
}

describe("artifact rule boundaries", () => {
  it.each([
    ["src/artifacts/references.ts", "../services/artifact-inputs.js"],
    ["src/artifacts/risks.ts", "../services/digest-inputs.js"],
    ["src/artifacts/gaps.ts", "../runs/store.js"],
    ["src/artifacts/risks.ts", "node:fs"],
    ["src/artifacts/references.ts", "../host/runtime.js"],
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
  ])(
    "allows the declared dependency from %s to %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

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
