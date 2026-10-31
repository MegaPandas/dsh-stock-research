import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function boundaryErrors(
  filePath: string,
  source: string,
  rule = "architecture/module-entry-points",
) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(({ ruleId }) => ruleId === rule);
}

it.each([
  [
    "src/host/runtime.ts",
    'import { CollectionSourceRunner } from "../services/collection/source.js";',
  ],
  [
    "src/app/new-use-case.ts",
    'import type { CollectionCache } from "../services/collection/cache.js";',
  ],
  ["src/core.ts", 'export * from "./services/collection/new-internal.js";'],
  [
    "src/services/new-service.ts",
    'const value = import("./collection/nested/new-internal.js");',
  ],
])("keeps collection internals private from %s", async (file, source) => {
  expect(await boundaryErrors(file, source)).toHaveLength(1);
});

it.each([
  [
    "src/core.ts",
    'export { CollectionService } from "./services/collection/index.js";',
  ],
  [
    "src/app/ask-request.ts",
    'import type { CollectionService } from "../services/collection/index.js";',
  ],
  [
    "src/tools/read.ts",
    'import { collectionGaps, collectionRowSelectors } from "../services/collection/view.js";',
  ],
  [
    "src/app/collection-tools.ts",
    'import { readCollectionData, readCollectionTable, collectionSummary, isCollectionRowField } from "../services/collection/view.js";',
  ],
  [
    "src/services/collection/index.ts",
    'import { CollectionTableRunner } from "./table.js";',
  ],
  [
    "src/services/collection/nested/new-internal.ts",
    'import { CollectionSourceRunner } from "../source.js";',
  ],
])(
  "allows the declared collection capability from %s",
  async (file, source) => {
    expect(await boundaryErrors(file, source)).toEqual([]);
  },
);

it.each([
  ["plan", "node:fs"],
  ["quality", "./table.js"],
  ["view", "../shared-queries.js"],
  ["errors", "../../host/runtime.js"],
])("keeps collection %s independent of %s", async (file, dependency) => {
  expect(
    await boundaryErrors(
      `src/services/collection/${file}.ts`,
      `import { Value } from "${dependency}";`,
      "no-restricted-imports",
    ),
  ).toHaveLength(1);
});

it.each(["plan", "quality", "view", "errors"])(
  "allows collection %s to consume the shared contract",
  async (file) => {
    expect(
      await boundaryErrors(
        `src/services/collection/${file}.ts`,
        'import type { CollectionSnapshot } from "../../contracts/collection.js";',
        "no-restricted-imports",
      ),
    ).toEqual([]);
  },
);
