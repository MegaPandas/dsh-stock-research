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

describe("research control boundaries", () => {
  it.each([
    "@deepseek-ai/cordis",
    "../../host/runtime.js",
    "../../tools/read.js",
  ])("keeps the opening workflow independent of %s", async (dependency) => {
    const errors = await boundaryErrors(
      "src/app/research-control/open.ts",
      `import { Value } from "${dependency}";`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Research plans");
  });

  it.each([
    ["src/app/quick.ts", "./research-control/open.js"],
    ["src/application.ts", "./app/research-control/open.js"],
    ["src/app/ask-request.ts", "./research-control/nested/new-internal.js"],
  ])(
    "keeps the research opening implementation private from %s",
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
    ["src/app/quick.ts", "./research-control/index.js"],
    ["src/app/research-control/index.ts", "./open.js"],
    ["src/app/research-control/index.ts", "../research-actions.js"],
    ["src/app/research-control/index.ts", "../research-executions.js"],
    ["src/app/research-control/open.ts", "../plan/quick.js"],
    ["src/app/research-control/open.ts", "../research-stages.js"],
    ["src/app/role-preparation/role.ts", "../research-stages.js"],
    ["src/app/research-tools.ts", "./research-actions.js"],
  ])(
    "allows the declared control or shared dependency from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each(["research-tools", "research-commands", "research-read-tools"])(
    "keeps %s on action and read contracts",
    async (adapter) => {
      const errors = await boundaryErrors(
        `src/app/${adapter}.ts`,
        'import { ResearchApplication } from "./research-control/index.js";',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Application adapters");
    },
  );
});
