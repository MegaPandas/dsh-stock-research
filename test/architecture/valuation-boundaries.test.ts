import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "no-restricted-imports" ||
      ruleId === "no-restricted-syntax" ||
      ruleId === "architecture/module-entry-points",
  );
}

describe("valuation module boundaries", () => {
  it.each([
    [
      "src/services/numbers.ts",
      'import { calculateValuation } from "./valuation/calculate.js";',
    ],
    [
      "src/services/valuation/records.ts",
      'export { calculateValuation } from "./calculate.js";',
    ],
    ["src/services/valuation/reports.ts", 'export * from "./calculate.js";'],
    [
      "src/services/valuation/reports.ts",
      'const value = import("./calculate.js");',
    ],
  ])(
    "keeps calculation registration out of the reader %s",
    async (file, source) => {
      const errors = await boundaryErrors(file, source);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("calculation registration");
    },
  );

  it.each(["./reports.js", "../../report/render.js"])(
    "keeps report dependency %s out of fixed record access",
    async (dependency) => {
      for (const source of [
        `export * from "${dependency}";`,
        `const value = import("${dependency}");`,
      ]) {
        const errors = await boundaryErrors(
          "src/services/valuation/records.ts",
          source,
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain("Fixed valuation records");
      }
    },
  );

  it.each([
    ["src/valuation/requests.ts", "../services/valuation/records.js"],
    ["src/valuation/report-policy.ts", "../runs/store.js"],
    ["src/valuation/report-policy.ts", "node:fs"],
    ["src/valuation/rating-policy.ts", "../services/decision-basics.js"],
  ])("keeps %s independent of %s", async (file, dependency) => {
    const errors = await boundaryErrors(
      file,
      `import { value } from "${dependency}";`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Pure modules");
  });

  it.each([
    ["src/valuation/requests.ts", "../json/schema.js"],
    ["src/valuation/report-policy.ts", "./rating-policy.js"],
    ["src/valuation/rating-policy.ts", "../contracts/rating-policy.js"],
    ["src/services/numbers.ts", "./valuation/records.js"],
    ["src/services/valuation/reports.ts", "../../valuation/report-policy.js"],
    ["src/services/valuation/calculate.ts", "./records.js"],
  ])(
    "allows the declared dependency from %s to %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    [
      "src/host/valuation-operations.ts",
      'import { value } from "../services/valuation/internal.js";',
    ],
    [
      "src/services/numbers.ts",
      'const value = import("./valuation/nested/internal.js");',
    ],
    ["src/core.ts", 'export * from "./services/valuation/internal.js";'],
  ])("keeps valuation internals private from %s", async (file, source) => {
    const errors = await boundaryErrors(file, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("private to src/services/valuation");
  });

  it.each(["records", "calculate", "reports"])(
    "allows the declared valuation %s entry",
    async (entry) => {
      expect(
        await boundaryErrors(
          "src/host/valuation-operations.ts",
          `import { value } from "../services/valuation/${entry}.js";`,
        ),
      ).toEqual([]);
    },
  );
});
