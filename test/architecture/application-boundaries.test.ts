import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function boundaryErrors(
  source: string,
  filePath = "src/app/research-control/index.ts",
) {
  const [result] = await eslint.lintText(source, {
    filePath,
  });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-imports",
  );
}
it.each([
  "@deepseek-ai/cordis",
  "../../host/runtime.js",
  "../../runtime.js",
  "@megapandas/dsh-stock-research/runtime",
  "../settings.js",
  "../activity.js",
  "../../tools/read.js",
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
  'import type { RunReader, RunLifecycle } from "../../contracts/run-access.js";',
  'import type { ResearchExecutionPorts } from "../research-executions.js";',
  'import type { ResearchCaller } from "../../host/bindings.js";',
])("allows an explicit research capability", async (source) => {
  expect(await boundaryErrors(source)).toEqual([]);
});

it.each([
  "./plan/quick.js",
  "./plan/deep.js",
  "./plan/versions.js",
  "./research-control/index.js",
])(
  "keeps execution ownership independent of research policy or control %s",
  async (dependency) => {
    const errors = await boundaryErrors(
      `import type { Value } from "${dependency}";`,
      "src/app/research-executions.ts",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Execution ownership");
  },
);

it.each([
  ["src/app/ask-request.ts", ".."],
  ["src/app/review-preparation/index.ts", "../.."],
])("keeps %s independent of Context and commands", async (filePath, root) => {
  for (const dependency of [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-commands",
    `${root}/host/runtime.js`,
    `${root}/runtime.js`,
    "@megapandas/dsh-stock-research/runtime",
  ]) {
    const [result] = await eslint.lintText(
      `import type { Value } from "${dependency}";`,
      { filePath },
    );
    expect(
      result!.messages.filter(
        ({ ruleId }) => ruleId === "no-restricted-imports",
      ),
    ).toHaveLength(1);
  }
});

it.each(["../host/runtime.js", "../runtime.js", "../storage/cleanup.js"])(
  "keeps activity tracking independent of resource owner %s",
  async (dependency) => {
    const [result] = await eslint.lintText(
      `import type { Value } from "${dependency}";`,
      { filePath: "src/app/activity.ts" },
    );
    expect(
      result!.messages.filter(
        ({ ruleId }) => ruleId === "no-restricted-imports",
      ),
    ).toHaveLength(1);
  },
);
