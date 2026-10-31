import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "architecture/module-entry-points",
  );
}

describe("dispatch execution boundaries", () => {
  it.each([
    [
      "src/host/runtime.ts",
      'import { continueChild } from "./dispatch/child-continuation.js";',
    ],
    [
      "src/tools/index.ts",
      'export * from "../host/dispatch/child-continuation.js";',
    ],
    [
      "src/host/sessions.ts",
      'const helper = import("./dispatch/nested/new-internal.js");',
    ],
  ])(
    "keeps dispatch continuation implementation private from %s",
    async (file, source) => {
      const errors = await boundaryErrors(file, source);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.messageId).toBe("privateEntry");
    },
  );

  it.each([
    ["src/host/runtime.ts", "./dispatch/index.js"],
    ["src/host/research-operations.ts", "./dispatch/index.js"],
    ["src/tools/index.ts", "../host/dispatch/index.js"],
    ["src/app/role.ts", "../host/dispatch/index.js"],
    ["src/app/role-preparation/index.ts", "../../host/dispatch/index.js"],
    ["src/host/dispatch/index.ts", "./child-continuation.js"],
    ["src/host/dispatch/index.ts", "../sessions.js"],
    ["src/host/dispatch/index.ts", "../../services/run-dispatch.js"],
  ])(
    "allows the public dispatch or shared capability from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );
});
