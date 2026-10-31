import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "architecture/module-entry-points",
  );
}

describe("research session boundaries", () => {
  it.each([
    [
      "src/host/runtime.ts",
      'import { setupResearchTools } from "./sessions/tool-policy.js";',
    ],
    [
      "src/tools/index.ts",
      'export * from "../host/sessions/tool-arguments.js";',
    ],
    [
      "src/host/dispatch/index.ts",
      'const helper = import("../sessions/nested/new-internal.js");',
    ],
  ])("keeps session policies private from %s", async (file, source) => {
    const errors = await boundaryErrors(file, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/host/runtime.ts", "./sessions/index.js"],
    ["src/host/dispatch/index.ts", "../sessions/index.js"],
    ["src/tools/index.ts", "../host/sessions/index.js"],
    ["src/host/sessions/index.ts", "./tool-policy.js"],
    ["src/host/sessions/tool-policy.ts", "./tool-arguments.js"],
    ["src/host/sessions/index.ts", "../bindings.js"],
  ])(
    "allows the public session or owned helper from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );
});
