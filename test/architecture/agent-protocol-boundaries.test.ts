import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function boundaryErrors(filePath: string, dependency: string) {
  const [result] = await eslint.lintText(
    `import { Value } from "${dependency}";`,
    { filePath },
  );
  return result!.messages.filter(
    ({ ruleId }) => ruleId === "architecture/module-entry-points",
  );
}

describe("Agent business protocol boundaries", () => {
  it("keeps new protocol implementation private", async () => {
    const errors = await boundaryErrors(
      "src/app/ask-request.ts",
      "../host/agent-protocol/new-internal.js",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.messageId).toBe("privateEntry");
  });

  it.each([
    ["src/app/ask-request.ts", "../host/agent-protocol/input.js"],
    ["src/app/ask-request.ts", "../host/agent-protocol/submission.js"],
    [
      "src/app/review-preparation/index.ts",
      "../../host/agent-protocol/input.js",
    ],
    [
      "src/app/review-preparation/index.ts",
      "../../host/agent-protocol/submission.js",
    ],
    ["src/app/role-preparation/role.ts", "../../host/agent-protocol/input.js"],
    ["src/host/report-draft.ts", "./agent-protocol/submission.js"],
    ["src/host/agent-protocol/submission.ts", "./new-internal.js"],
  ])(
    "allows public protocols and owned helpers from %s",
    async (file, dependency) => {
      expect(await boundaryErrors(file, dependency)).toEqual([]);
    },
  );
});
