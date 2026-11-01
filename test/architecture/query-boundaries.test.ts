import { ESLint } from "eslint";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(
  filePath: string,
  source: string,
  rule = "architecture/module-entry-points",
) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(({ ruleId }) => ruleId === rule);
}

describe("query module boundaries", () => {
  it.each([
    [
      "src/app/research-control/index.ts",
      "../../services/query/source-queries.js",
    ],
    ["src/tools/read.ts", "../services/query/source-queries.js"],
    ["src/services/numbers/session.ts", "../query/source-queries.js"],
    ["src/host/runtime/index.ts", "../../services/query/source-queries.js"],
    ["src/client/index.ts", "../services/query/source-queries.js"],
    ["src/core.ts", "./services/query/source-queries.js"],
  ])(
    "rejects access to source execution internals from %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `import { SourceQueries } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.messageId).toBe("privateEntry");
      expect(errors[0]!.message).toContain("src/services/query");
    },
  );

  it.each([
    'export { selectSource } from "./services/query/source-selection.js";',
    'export * from "./services/query/source-queries.js";',
  ])("rejects re-exporting private query capabilities", async (source) => {
    expect(await boundaryErrors("src/core.ts", source)).toHaveLength(1);
  });

  it.each([
    'import type { Value } from "../services/query/new-internal.js";',
    'export { Value } from "../services/query/new-internal.js";',
    'export * from "../services/query/nested/new-internal.js";',
    'const value = import("../services/query/nested/new-internal.js");',
    'type Value = import("../services/query/new-internal.js").Value;',
    'import Value = require("../services/query/new-internal.js");',
  ])("keeps newly added query files private: %s", async (source) => {
    expect(
      await boundaryErrors("src/app/new-use-case.ts", source),
    ).toHaveLength(1);
  });

  it("resolves parent paths when checking nested consumers", async () => {
    expect(
      await boundaryErrors(
        "src/host/nested/adapter.ts",
        'import { Value } from "../../services/query/nested/../new-internal.js";',
      ),
    ).toHaveLength(1);
  });

  it("applies module privacy to absolute local imports", async () => {
    const target = resolve("src/services/query/new-internal.js");
    expect(
      await boundaryErrors(
        "src/app/new-use-case.ts",
        `import type { Value } from ${JSON.stringify(target)};`,
      ),
    ).toHaveLength(1);
  });

  it("distinguishes similarly named sibling directories", async () => {
    expect(
      await boundaryErrors(
        "src/services/new-service.ts",
        'import { Value } from "./query-extra/new-internal.js";',
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "src/host/runtime/index.ts",
      'import { QueryService } from "../../services/query/index.js";',
    ],
    [
      "src/services/query-snapshot.ts",
      'import { withPriceReturn } from "./query/calculations.js";',
    ],
    [
      "src/services/query/source-queries.ts",
      'import { selectSource } from "./source-selection.js";',
    ],
    [
      "src/services/query/nested/new-internal.ts",
      'import { SourceQueries } from "../../query/source-queries.js";',
    ],
    [
      "src/app/new-use-case.ts",
      'type Value = import("../services/query/calculations.js").Value;',
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
