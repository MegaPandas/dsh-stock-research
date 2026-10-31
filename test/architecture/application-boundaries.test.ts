import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function boundaryErrors(source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: "src/app/research-application.ts",
  });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-imports",
  );
}
it.each([
  "@deepseek-ai/cordis",
  "../host/runtime.js",
  "../runtime.js",
  "@megapandas/dsh-stock-research/runtime",
  "./settings.js",
  "./activity.js",
  "../tools/read.js",
  "@deepseek-ai/dsh-commands",
])(
  "keeps research actions independent of Context or adapter %s",
  async (dependency) => {
    expect(
      await boundaryErrors(`import type { Value } from "${dependency}";`),
    ).toHaveLength(1);
  },
);
it.each([
  'import type { RunReader, RunLifecycle } from "../contracts/run-access.js";',
  'import type { ResearchExecutionPorts } from "./research-executions.js";',
  'import type { ResearchCaller } from "../host/bindings.js";',
])("allows an explicit research capability", async (source) => {
  expect(await boundaryErrors(source)).toEqual([]);
});
