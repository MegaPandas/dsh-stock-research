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

describe("review preparation boundaries", () => {
  it.each([
    ["src/app/review.ts", "./review-preparation/tools.js"],
    ["src/app/ask-request.ts", "./review-preparation/nested/new-internal.js"],
  ])("keeps review tool assembly private from %s", async (file, dependency) => {
    const errors = await boundaryErrors(file, `export * from "${dependency}";`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/app/review.ts", "./review-preparation/index.js"],
    ["src/app/review-preparation/index.ts", "./tools.js"],
    ["src/app/review-preparation/index.ts", "../review-session.js"],
    ["src/app/review-preparation/tools.ts", "../review-session.js"],
    ["src/app/review-preparation/index.ts", "../report-reader.js"],
    [
      "src/app/review-preparation/index.ts",
      "../../services/artifact-inputs.js",
    ],
  ])(
    "allows the review entry or shared capability from %s",
    async (file, dependency) => {
      expect(
        await boundaryErrors(file, `import { Value } from "${dependency}";`),
      ).toEqual([]);
    },
  );

  it.each([
    ["src/app/review-preparation/tools.ts", "@deepseek-ai/cordis"],
    ["src/app/review-preparation/index.ts", "../../runtime.js"],
    ["src/app/review-preparation/tools.ts", "../settings.js"],
  ])(
    "keeps review preparation in %s independent of %s",
    async (file, dependency) => {
      const errors = await boundaryErrors(
        file,
        `import { Value } from "${dependency}";`,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain("Request preparation");
    },
  );
});
