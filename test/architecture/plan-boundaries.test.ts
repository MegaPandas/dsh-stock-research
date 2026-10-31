import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "architecture/module-entry-points" ||
      ruleId === "no-restricted-imports",
  );
}

describe("research plan boundaries", () => {
  it.each([
    ["src/application.ts", "./app/plan/inputs.js"],
    ["src/app/research-input.ts", "./plan/capture.js"],
    ["src/app/quick-snapshots.ts", "./plan/snapshots.js"],
    ["src/app/research-control/open.ts", "../plan/nested/new-internal.js"],
  ])("keeps plan implementation private from %s", async (file, dependency) => {
    const errors = await boundaryErrors(file, `export * from "${dependency}";`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/application.ts", "./app/plan/quick.js"],
    ["src/application.ts", "./app/plan/deep.js"],
    ["src/app/research-control/open.ts", "../plan/quick.js"],
    ["src/app/replay-input.ts", "./plan/versions.js"],
    ["src/app/research-input.ts", "./plan/protocol.js"],
    ["src/app/quick-snapshots.ts", "./plan/protocol.js"],
    ["src/app/plan/quick.ts", "./inputs.js"],
    ["src/app/plan/inputs.ts", "./capture.js"],
    ["src/app/plan/inputs.ts", "./snapshots.js"],
    ["src/app/plan/inputs.ts", "./versions.js"],
    ["src/app/plan/inputs.ts", "./protocol.js"],
    ["src/app/plan/capture.ts", "../research-prompts.js"],
  ])(
    "allows the declared plan dependency from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    ["src/app/plan/quick.ts", "../../services/query/index.js"],
    ["src/app/plan/deep.ts", "../../host/runtime.js"],
    ["src/app/plan/inputs.ts", "../../tools/query-inputs.js"],
    ["src/app/plan/versions.ts", "../../runs/store.js"],
    ["src/app/plan/protocol.ts", "node:fs"],
    ["src/app/plan/nested/internal.ts", "@deepseek-ai/cordis"],
  ])(
    "keeps plan computation in %s independent of %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `import { Value } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Pure modules");
    },
  );
});
