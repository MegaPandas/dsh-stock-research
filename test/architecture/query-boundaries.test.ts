import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(
  filePath: string,
  source: string,
  rule = "no-restricted-syntax",
) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(({ ruleId }) => ruleId === rule);
}

describe("query module boundaries", () => {
  it.each([
    "src/app/research-application.ts",
    "src/tools/read.ts",
    "src/services/numbers.ts",
    "src/host/runtime.ts",
    "src/client/index.ts",
    "src/core.ts",
  ])("rejects access to source execution internals from %s", async (file) => {
    const errors = await boundaryErrors(
      file,
      'import { SourceQueries } from "../services/query/source-queries.js";',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("source execution internals");
  });

  it.each([
    'export { selectSource } from "./services/query/source-selection.js";',
    'export * from "./services/query/source-queries.js";',
  ])("rejects re-exporting private query capabilities", async (source) => {
    expect(await boundaryErrors("src/core.ts", source)).toHaveLength(1);
  });

  it.each([
    [
      "src/host/runtime.ts",
      'import { QueryService } from "../services/query/index.js";',
    ],
    [
      "src/services/query-snapshot.ts",
      'import { withPriceReturn } from "./query/calculations.js";',
    ],
    [
      "src/services/query/source-queries.ts",
      'import { selectSource } from "./source-selection.js";',
    ],
  ])("allows the declared query entry from %s", async (file, source) => {
    expect(await boundaryErrors(file, source)).toEqual([]);
  });

  it.each(["./source-queries.js", "./index.js", "../shared-queries.js"])(
    "rejects the stateful dependency %s from pure calculations",
    async (dependency) => {
      const errors = await boundaryErrors(
        "src/services/query/calculations.ts",
        `import { value } from "${dependency}";`,
        "no-restricted-imports",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("pure computations");
    },
  );

  it.each(["../../contracts/data.js", "../../indicators/index.js"])(
    "allows the pure calculation dependency %s",
    async (dependency) => {
      expect(
        await boundaryErrors(
          "src/services/query/calculations.ts",
          `import { value } from "${dependency}";`,
          "no-restricted-imports",
        ),
      ).toEqual([]);
    },
  );
});
