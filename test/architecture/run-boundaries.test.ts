import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(
  filePath: string,
  source: string,
  rule = "architecture/module-entry-points",
) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(({ ruleId }) => ruleId === rule);
}

describe("run capability boundaries", () => {
  it.each([
    ["src/app/research-control/index.ts", "../../services/run/service.js"],
    ["src/tools/read.ts", "../services/run/service.js"],
    ["src/services/numbers/session.ts", "../run/service.js"],
    ["src/host/runtime.ts", "../services/run/service.js"],
    ["src/host/dispatch/index.ts", "../../services/run/service.js"],
    ["src/client/index.ts", "../services/run/service.js"],
  ])(
    "rejects a concrete run implementation import from %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `import type { RunService } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.messageId).toBe("privateEntry");
      expect(errors[0]!.message).toContain("src/services/run");
    },
  );

  it.each([
    ["src/core.ts", 'export { RunService } from "./services/run/service.js";'],
    ["src/core.ts", 'export * from "./services/run/control.js";'],
    [
      "src/runtime.ts",
      'export { RunService } from "./services/run/service.js";',
    ],
  ])(
    "rejects publishing the run implementation from %s",
    async (file, source) => {
      expect(await boundaryErrors(file, source)).toHaveLength(1);
    },
  );

  it.each([
    'import type { Value } from "../services/run/new-internal.js";',
    'const value = import("../services/run/nested/new-internal.js");',
  ])("keeps new run implementation files private", async (source) => {
    expect(
      await boundaryErrors("src/app/new-use-case.ts", source),
    ).toHaveLength(1);
  });

  it.each([
    [
      "src/host/dispatch/index.ts",
      'import type { RunAccess } from "../../contracts/run-access.js";',
    ],
    [
      "src/services/numbers/session.ts",
      'import type { RunReader } from "../../contracts/run-access.js";',
    ],
    [
      "src/core.ts",
      'export { createRunService } from "./services/run/index.js";',
    ],
    ["src/services/run/index.ts", 'import { RunService } from "./service.js";'],
    [
      "src/services/run/index.ts",
      'import { createRunProjector } from "./projections.js";',
    ],
    [
      "src/services/run/service.ts",
      'import { persistEvidence } from "./data.js";',
    ],
    ["src/host/runtime.ts", 'import { RunStore } from "../runs/store.js";'],
  ])(
    "allows the declared capability boundary from %s",
    async (file, source) => {
      expect(await boundaryErrors(file, source)).toEqual([]);
    },
  );

  it.each([
    "./projections.js",
    "../run/projections.js",
    "../../report/projections.js",
    "../../host/runtime.js",
  ])("keeps run transactions independent of %s", async (dependency) => {
    expect(
      await boundaryErrors(
        "src/services/run/service.ts",
        `import { Value } from "${dependency}";`,
        "no-restricted-imports",
      ),
    ).toHaveLength(1);
  });
});
