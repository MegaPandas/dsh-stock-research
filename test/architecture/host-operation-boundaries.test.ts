import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function errors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-syntax",
  );
}

it.each([
  ["bindings", "../tools/parameters.js"],
  ["run-reading", "../tools/read.js"],
  ["research-operations", "@megapandas/dsh-stock-research/tools"],
  ["valuation-operations", "../tools/errors.js"],
  ["run-reading", "./tool-protocol/parameters.js"],
  ["research-operations", "./tool-protocol/errors.js"],
  ["scheduled-operations", "./tool-protocol/parameters.js"],
])("keeps host %s independent of %s", async (file, dependency) => {
  for (const source of [
    `import type { Value } from "${dependency}";`,
    `export { Value } from "${dependency}";`,
    `export * from "${dependency}";`,
    `const value = import("${dependency}");`,
  ]) {
    const found = await errors(`src/host/${file}.ts`, source);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("Host identity and operations");
  }
});

it.each([
  ["src/host/run-reading.ts", "../contracts/data.js"],
  ["src/host/run-reading.ts", "./bindings.js"],
  ["src/host/research-operations.ts", "./dispatch/index.js"],
  ["src/host/research-operations.ts", "../services/decisions.js"],
  ["src/host/scheduled-operations.ts", "../services/scheduler/index.js"],
  ["src/host/scheduled-operations.ts", "./dispatch/index.js"],
  ["src/host/valuation-operations.ts", "../services/valuation/calculate.js"],
  ["src/host/runtime/index.ts", "../../tools/read.js"],
])("allows %s → %s", async (file, dependency) => {
  expect(await errors(file, `import { Value } from "${dependency}";`)).toEqual(
    [],
  );
});
