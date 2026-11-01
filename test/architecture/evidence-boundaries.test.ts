import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) =>
      ruleId === "no-restricted-imports" ||
      ruleId === "architecture/module-entry-points",
  );
}

describe("shared evidence boundaries", () => {
  it.each([
    ["src/evidence/fields.ts", "../services/numbers/index.js"],
    ["src/evidence/checks.ts", "../services/run/index.js"],
    ["src/evidence/price-basis.ts", "../storage/data-root.js"],
    ["src/evidence/fields.ts", "../runs/store.js"],
    ["src/evidence/checks.ts", "../cache/index.js"],
    ["src/evidence/checks.ts", "../data/http.js"],
    ["src/evidence/fields.ts", "../host/runtime/index.js"],
    ["src/evidence/checks.ts", "../app/reference-price.js"],
    ["src/evidence/price-basis.ts", "../tools/read.js"],
    ["src/evidence/fields.ts", "node:fs"],
    ["src/evidence/checks.ts", "@deepseek-ai/dsh-agent"],
    ["src/evidence/nested/internal.ts", "../../services/numbers/index.js"],
  ])("keeps %s independent of %s", async (file, dependency) => {
    const errors = await boundaryErrors(file, `export * from "${dependency}";`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Pure modules");
  });

  it.each([
    ["src/evidence/fields.ts", "../contracts/query.js"],
    ["src/evidence/fields.ts", "../indicators/returns.js"],
    ["src/evidence/fields.ts", "../json/pointer.js"],
    ["src/evidence/checks.ts", "./fields.js"],
    ["src/evidence/price-basis.ts", "./fields.js"],
    ["src/app/reference-price.ts", "../evidence/fields.js"],
    ["src/services/artifacts.ts", "../evidence/checks.js"],
    ["src/services/artifact-inputs.ts", "../evidence/fields.js"],
    ["src/services/numbers/session.ts", "../../evidence/price-basis.js"],
    ["src/services/decision-basics.ts", "../evidence/price-basis.js"],
    ["src/services/decision-requirements.ts", "../evidence/fields.js"],
  ])("allows %s to use the declared entry %s", async (file, dependency) => {
    expect(
      await boundaryErrors(file, `import { Value } from "${dependency}";`),
    ).toEqual([]);
  });

  it.each([
    'import type { Value } from "../../evidence/new-internal.js";',
    'const value = import("../../evidence/nested/new-internal.js");',
  ])("keeps new evidence implementation files private", async (source) => {
    const errors = await boundaryErrors(
      "src/services/numbers/session.ts",
      source,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });
});
