import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
async function errors(
  filePath: string,
  dependency: string,
  rule = "architecture/module-entry-points",
) {
  const [result] = await eslint.lintText(
    `import { Value } from "${dependency}";`,
    { filePath },
  );
  return result!.messages.filter(({ ruleId }) => ruleId === rule);
}

describe("research execution boundaries", () => {
  it("keeps new execution helpers independent of research policy", async () => {
    const found = await errors(
      "src/app/research-execution/nested/new-internal.ts",
      "../../plan/quick.js",
      "no-restricted-imports",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("Execution ownership");
  });
  it.each([
    ["src/app/research-control/index.ts", "../research-execution/view.js"],
    ["src/app/quick.ts", "./research-execution/output.js"],
    ["src/client/research-log.ts", "../app/research-execution/progress.js"],
    ["src/app/research-control/index.ts", "../research-execution/job.js"],
    ["src/app/quick.ts", "./research-execution/nested/new-internal.js"],
  ])(
    "keeps execution implementation private from %s",
    async (file, dependency) => {
      const found = await errors(file, dependency);
      expect(found).toHaveLength(1);
      expect(found[0]!.messageId).toBe("privateEntry");
    },
  );
  it.each([
    ["src/app/research-control/index.ts", "../research-execution/index.js"],
    ["src/app/research-control/index.ts", "../research-execution/labels.js"],
    ["src/app/research-execution/index.ts", "./view.js"],
    ["src/app/research-execution/index.ts", "./output.js"],
    ["src/client/research-log.ts", "../contracts/research-progress.js"],
  ])(
    "allows the public capability or owned helper from %s",
    async (file, dependency) => {
      expect(await errors(file, dependency)).toEqual([]);
    },
  );
  it.each(["view", "progress", "labels"])(
    "keeps %s independent of execution and I/O",
    async (file) => {
      for (const dependency of [
        "./index.js",
        "./output.js",
        "../research-control/index.js",
        "node:fs",
        "@deepseek-ai/dsh-jobs",
      ]) {
        const found = await errors(
          `src/app/research-execution/${file}.ts`,
          dependency,
          "no-restricted-imports",
        );
        expect(found).toHaveLength(1);
        expect(found[0]!.message).toContain("Job presentation");
      }
    },
  );
});
