import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function errors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "architecture/module-entry-points" ||
      ruleId === "no-restricted-syntax",
  );
}

it.each([
  "../run/index.js",
  "../../host/dispatch/index.js",
  "../../storage/data-root.js",
  "node:fs",
  "@deepseek-ai/dsh-agent",
])(
  "keeps scheduler dependent on neutral capabilities instead of %s",
  async (dependency) => {
    for (const source of [
      `import type { Value } from "${dependency}";`,
      `export { Value } from "${dependency}";`,
      `export * from "${dependency}";`,
      `const value = import("${dependency}");`,
      `type Value = import("${dependency}").Value;`,
    ])
      expect(
        (await errors("src/services/scheduler/index.ts", source)).some(
          ({ ruleId }) => ruleId === "no-restricted-syntax",
        ),
      ).toBe(true);
  },
);

it.each([
  ["src/app/research-control/index.ts", "../../services/scheduler/plan.js"],
  ["src/host/runtime/index.ts", "../../services/scheduler/types.js"],
  ["src/core.ts", "./services/scheduler/nested/internal.js"],
])("keeps scheduler internals private from %s", async (file, dependency) => {
  expect(await errors(file, `export * from "${dependency}";`)).toEqual([
    expect.objectContaining({ messageId: "privateEntry" }),
  ]);
});

it.each([
  ["src/services/scheduler/index.ts", "./plan.js"],
  ["src/services/scheduler/plan.ts", "./types.js"],
  ["src/services/scheduler/index.ts", "../../contracts/run-access.js"],
  ["src/services/scheduler/types.ts", "../../contracts/workflow.js"],
  ["src/core.ts", "./services/scheduler/index.js"],
  ["src/app/research-control/index.ts", "../../services/scheduler/index.js"],
])(
  "allows the scheduler capability boundary from %s",
  async (file, dependency) => {
    expect(
      await errors(file, `import type { Value } from "${dependency}";`),
    ).toEqual([]);
  },
);
