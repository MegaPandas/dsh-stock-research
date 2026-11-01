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

describe("role preparation boundaries", () => {
  it.each([
    ["src/application.ts", "./app/role-preparation/role.js"],
    ["src/application.ts", "./app/role-preparation/services.js"],
    ["src/plugin.ts", "./app/role-preparation/valuation-draft.js"],
    ["src/application.ts", "./app/role-preparation/public-search.js"],
    ["src/application.ts", "./app/role-preparation/report.js"],
    ["src/plugin.ts", "./app/role-preparation/valuation.js"],
    ["src/app/ask-request.ts", "./role-preparation/nested/new-internal.js"],
  ])(
    "keeps role preparation implementation private from %s",
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
    ["src/application.ts", "./app/role-preparation/index.js"],
    ["src/plugin.ts", "./app/role-preparation/index.js"],
    ["src/app/role-preparation/index.ts", "./role.js"],
    ["src/app/role-preparation/role.ts", "./valuation-draft.js"],
    ["src/app/role-preparation/role.ts", "./public-search.js"],
    ["src/app/role-preparation/role.ts", "./report.js"],
    ["src/app/role-preparation/role.ts", "./valuation.js"],
    ["src/app/role-preparation/role.ts", "../collection-input.js"],
    ["src/app/role-preparation/role.ts", "../collection-tools.js"],
    ["src/app/role-preparation/role.ts", "../report-reader.js"],
    ["src/app/ask-request.ts", "./collection-tools.js"],
    ["src/app/review-preparation/index.ts", "../report-reader.js"],
    ["src/app/ask-prompt.ts", "./agent-prompt.js"],
    ["src/app/review-prompt.ts", "./agent-prompt.js"],
  ])(
    "allows the role entry or shared capability from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );
});
