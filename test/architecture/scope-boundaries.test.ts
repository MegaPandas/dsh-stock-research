import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, dependency: string) {
  const [result] = await eslint.lintText(
    `import { Value } from "${dependency}";`,
    { filePath },
  );
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-imports",
  );
}

describe("shared research scope boundaries", () => {
  it.each([
    "./ask-input.js",
    "./review-input.js",
    "./research-tools.js",
    "./research-control/index.js",
    "../services/collection/index.js",
    "node:fs",
    "@deepseek-ai/cordis",
  ])("keeps scope rules independent of %s", async (dependency) => {
    const errors = await boundaryErrors(
      "src/app/research-scope.ts",
      dependency,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Research scope rules");
  });

  it.each([
    ["src/app/research-scope.ts", "../contracts/data.js"],
    ["src/app/research-scope.ts", "../contracts/time.js"],
    ["src/app/ask-input.ts", "./research-scope.js"],
    ["src/app/ask-request.ts", "./research-scope.js"],
    ["src/app/review-input.ts", "./research-scope.js"],
    ["src/app/research-tools.ts", "./research-scope.js"],
    ["src/app/research-control/open.ts", "../research-scope.js"],
  ])(
    "allows %s to consume the scope contract or rule %s",
    async (file, dependency) => {
      expect(await boundaryErrors(file, dependency)).toEqual([]);
    },
  );
});
