import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
async function errors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "architecture/module-entry-points",
  );
}

describe("client entry boundaries", () => {
  it.each([
    'import { SettingsPage } from "./client/SettingsPage.js";',
    'export * from "./client/research-log.js";',
    'const helper = import("./client/nested/new-internal.js");',
  ])("keeps client implementation private: %s", async (source) => {
    const found = await errors("src/plugin.ts", source);
    expect(found).toHaveLength(1);
    expect(found[0]!.messageId).toBe("privateEntry");
  });
  it.each([
    ["src/index.ts", "./client/index.js"],
    ["src/client/index.ts", "./SettingsPage.js"],
    ["src/client/research-jobs.ts", "./research-log.js"],
    ["src/client/research-log.ts", "../contracts/research-progress.js"],
  ])(
    "allows the public entry or internal collaboration from %s",
    async (file, dependency) => {
      expect(
        await errors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );
});
