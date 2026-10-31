import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "architecture/module-entry-points" ||
      ruleId === "no-restricted-imports",
  );
}

describe("digest boundaries", () => {
  it.each([
    [
      "src/app/role-preparation/role.ts",
      'import { digestNumbers } from "../../services/digest/inputs.js";',
    ],
    ["src/core.ts", 'export * from "./services/digest/draft.js";'],
    [
      "src/services/decisions.ts",
      'import { digestNumbers } from "./digest/inputs.js";',
    ],
    ["src/services/numbers.ts", 'export * from "./digest/draft.js";'],
    [
      "src/host/runtime.ts",
      'const value = import("../services/digest/nested/new-internal.js");',
    ],
  ])("keeps digest implementation private from %s", async (file, source) => {
    const errors = await boundaryErrors(file, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/core.ts", "./services/digest/index.js"],
    ["src/core.ts", "./services/digest/handoff.js"],
    ["src/host/runtime.ts", "../services/digest/handoff.js"],
    ["src/host/dispatch/index.ts", "../../services/digest/index.js"],
    ["src/services/digest/index.ts", "./inputs.js"],
    ["src/services/digest/index.ts", "./draft.js"],
    ["src/services/digest/inputs.ts", "../artifact-inputs.js"],
    ["src/services/digest/draft.ts", "../../artifacts/schema.js"],
    ["src/services/digest/handoff.ts", "../../artifacts/agent-reports.js"],
  ])(
    "allows the declared digest dependency from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    ["src/services/digest/draft.ts", "./index.js"],
    ["src/services/digest/handoff.ts", "../artifact-inputs.js"],
    ["src/services/digest/draft.ts", "../../runs/store.js"],
    ["src/services/digest/handoff.ts", "../../host/runtime.js"],
    ["src/services/digest/handoff.ts", "node:fs"],
  ])(
    "keeps digest computations in %s independent of %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `import { Value } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("pure computations");
    },
  );
});
