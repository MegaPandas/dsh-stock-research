import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function errors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(({ ruleId }) =>
    ["architecture/module-entry-points", "no-restricted-syntax"].includes(
      ruleId ?? "",
    ),
  );
}

it.each([
  ["src/plugin.ts", "./host/runtime/instance.js"],
  ["src/runtime.ts", "./host/runtime/lifecycle.js"],
  ["src/app/ask.ts", "../host/runtime/nested/new-internal.js"],
])("keeps runtime internals private from %s", async (file, dependency) => {
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
  "../host/bindings.js",
  "../host/dispatch/index.js",
  "../runtime.js",
  "@megapandas/dsh-stock-research/runtime",
])("keeps host ownership out of the tools entry: %s", async (dependency) => {
  for (const source of [
    `import { Value } from "${dependency}";`,
    `export { Value } from "${dependency}";`,
    `export * from "${dependency}";`,
    `const value = import("${dependency}");`,
  ]) {
    const found = await errors("src/tools/index.ts", source);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("tools entry");
  }
});

it.each([
  ["src/plugin.ts", "./host/runtime/index.js"],
  ["src/runtime.ts", "./host/runtime/index.js"],
  ["src/runtime.ts", "./host/bindings.js"],
  ["src/host/runtime/index.ts", "./instance.js"],
  ["src/host/runtime/instance.ts", "./lifecycle.js"],
  ["src/host/runtime/instance.ts", "../../tools/read.js"],
  ["src/tools/index.ts", "./read.js"],
  ["src/tools/index.ts", "../contracts/query.js"],
])("allows the runtime dependency %s → %s", async (file, dependency) => {
  expect(await errors(file, `export { Value } from "${dependency}";`)).toEqual(
    [],
  );
});
