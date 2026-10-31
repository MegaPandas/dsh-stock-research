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

describe("memory service boundaries", () => {
  it.each([
    [
      "src/host/runtime.ts",
      'import { assertMemoryState } from "../services/memory/state.js";',
    ],
    ["src/core.ts", 'export * from "./services/memory/state.js";'],
    [
      "src/tools/recall.ts",
      'const value = import("../services/memory/nested/new-internal.js");',
    ],
  ])("keeps memory implementation private from %s", async (file, source) => {
    const errors = await boundaryErrors(file, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/core.ts", "./services/memory/index.js"],
    ["src/host/runtime.ts", "../services/memory/index.js"],
    ["src/tools/recall.ts", "../services/memory/index.js"],
    ["src/services/memory/index.ts", "./state.js"],
    ["src/services/memory/index.ts", "../../memory/store.js"],
    ["src/services/memory/index.ts", "../shared-queries.js"],
    ["src/services/memory/state.ts", "../../contracts/memory-service.js"],
  ])(
    "allows the declared memory dependency from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    "./index.js",
    "../shared-queries.js",
    "../../memory/store.js",
    "node:fs",
  ])("keeps stored state validation independent of %s", async (dependency) => {
    const errors = await boundaryErrors(
      "src/services/memory/state.ts",
      `import { Value } from "${dependency}";`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("pure computations");
  });
});
