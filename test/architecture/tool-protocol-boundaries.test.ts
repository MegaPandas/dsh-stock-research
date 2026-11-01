import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function errors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(({ ruleId }) =>
    [
      "architecture/module-entry-points",
      "no-restricted-imports",
      "no-restricted-syntax",
    ].includes(ruleId ?? ""),
  );
}

it.each([
  ["src/tools/read.ts", "../host/tool-protocol/nested/new-internal.js"],
  ["src/app/report-reader.ts", "../host/tool-protocol/new-internal.js"],
])("keeps protocol internals private from %s", async (file, dependency) => {
  for (const source of [
    `import { Value } from "${dependency}";`,
    `export * from "${dependency}";`,
    `const value = import("${dependency}");`,
  ]) {
    const found = await errors(file, source);
    expect(found).toHaveLength(1);
    expect(found[0]!.messageId).toBe("privateEntry");
  }
});

it.each([
  ["src/host/report-draft.ts", "../tools/read.js"],
  ["src/host/agent-protocol/submission.ts", "../../tools/index.js"],
  ["src/host/tool-protocol/errors.ts", "@megapandas/dsh-stock-research/tools"],
])(
  "keeps host execution in %s independent of tool adapters",
  async (file, dependency) => {
    for (const source of [
      `import { Value } from "${dependency}";`,
      `export { Value } from "${dependency}";`,
      `export * from "${dependency}";`,
      `const value = import("${dependency}");`,
    ]) {
      const found = await errors(file, source);
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain("Host execution");
    }
  },
);

it.each([
  "./errors.js",
  "../../services/artifact-submission/index.js",
  "../sessions/index.js",
  "@deepseek-ai/dsh-llm",
  "node:fs",
])("keeps parameter helpers independent of %s", async (dependency) => {
  expect(
    await errors(
      "src/host/tool-protocol/parameters.ts",
      `import { Value } from "${dependency}";`,
    ),
  ).toHaveLength(1);
});

it.each([
  ["src/tools/read.ts", "../host/tool-protocol/parameters.js"],
  ["src/app/run-command-input.ts", "../host/tool-protocol/parameters.js"],
  ["src/host/report-draft.ts", "./tool-protocol/errors.js"],
  ["src/host/agent-protocol/submission.ts", "../tool-protocol/parameters.js"],
  ["src/host/tool-protocol/parameters.ts", "../../contracts/errors.js"],
  ["src/host/tool-protocol/parameters.ts", "@deepseek-ai/dsh-tools"],
  [
    "src/host/tool-protocol/errors.ts",
    "../../services/artifact-submission/index.js",
  ],
  ["src/host/runtime.ts", "../tools/read.js"],
])("allows the protocol dependency %s → %s", async (file, dependency) => {
  expect(
    await errors(file, `import type { Value } from "${dependency}";`),
  ).toEqual([]);
});
