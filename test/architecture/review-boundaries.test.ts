import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function boundaryErrors(source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: "src/app/review-session.ts",
  });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "no-restricted-imports",
  );
}
it.each([
  "@deepseek-ai/cordis",
  "../host/runtime.js",
  "../host/tool-protocol/parameters.js",
  "../runs/store.js",
  "../services/memory/index.js",
])(
  "keeps review business state independent of runtime dependency %s",
  async (dependency) => {
    expect(
      await boundaryErrors(`import { value } from "${dependency}";`),
    ).toHaveLength(1);
  },
);
it.each([
  'import type { MemoryService } from "../services/memory/index.js";',
  'import { renderAgentReport } from "../report/agent-report.js";',
  'import type { QueryMemoryReturns } from "../contracts/memory-service.js";',
])("allows a declared review capability or pure dependency", async (source) => {
  expect(await boundaryErrors(source)).toEqual([]);
});
