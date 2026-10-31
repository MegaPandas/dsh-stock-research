import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function violations(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-imports",
  );
}

it.each([
  ["src/contracts/settings.ts", "node:fs"],
  ["src/contracts/settings.ts", "../services/query/index.js"],
  ["src/storage/cleanup.ts", "../services/run/index.js"],
  ["src/data/http.ts", "../host/runtime.js"],
  ["src/services/query/index.ts", "../../app/quick.js"],
  ["src/services/memory.ts", "../tools/read.js"],
  ["src/host/runtime.ts", "../app/quick.js"],
  ["src/host/runtime.ts", "../application.js"],
  ["src/host/nested/adapter.ts", "../../application.js"],
  ["src/host/runtime.ts", "../index.js"],
  ["src/host/runtime.ts", "@megapandas/dsh-stock-research"],
  ["src/host/runtime.ts", "@megapandas/dsh-stock-research/application"],
  ["src/client/index.ts", "../services/memory.js"],
  ["src/client/index.ts", "../core.js"],
  ["src/client/index.ts", "../runtime.js"],
  ["src/client/index.ts", "../tools.js"],
  ["src/client/nested/adapter.ts", "../../runtime.js"],
  ["src/client/index.ts", "@megapandas/dsh-stock-research"],
  ["src/client/index.ts", "@megapandas/dsh-stock-research/core"],
])("enforces %s → %s", async (filePath, dependency) => {
  for (const source of [
    `import type { Value } from "${dependency}";`,
    `export { Value } from "${dependency}";`,
    `export * from "${dependency}";`,
  ])
    expect(await violations(filePath, source)).toHaveLength(1);
});

it.each([
  ["src/contracts/settings.ts", "./http.js"],
  ["src/storage/cleanup.ts", "./data-root.js"],
  ["src/services/memory.ts", "../contracts/run-access.js"],
  ["src/host/runtime.ts", "../services/query/index.js"],
  ["src/host/run-reading.ts", "../contracts/run-access.js"],
  ["src/client/index.ts", "../contracts/settings.js"],
  ["src/client/index.ts", "@deepseek-ai/dsh-api-remotes/client"],
])("allows %s → %s", async (filePath, dependency) => {
  expect(
    await violations(filePath, `import type { Value } from "${dependency}";`),
  ).toEqual([]);
});
