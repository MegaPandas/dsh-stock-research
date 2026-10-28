import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import {
  parseRunCommand,
  parseRunControl,
  runControlParameters,
} from "../../src/app/run-command-input.js";

const base = { runId: "run", requestId: "request" };
const input = {
  resolvedReasonIds: ["review-reason"],
  instructions: [
    { taskId: "risk.finance", instruction: "Reconcile position limits." },
  ],
};

describe("model-facing research control", () => {
  it.each([
    { action: "resume", input },
    { action: "resume", input: { resolvedReasonIds: [], instructions: [] } },
    { action: "recover", attempts: [{ taskId: "risk.finance", attempt: 2 }] },
    { action: "cancel" },
    { action: "replay" },
  ] as const)(
    "exposes the complete supported $action contract",
    ({ action, ...args }) => {
      assertSupportedJsonSchema(runControlParameters[action]);
      expect(
        validateJsonSchemaValue(runControlParameters[action], {
          ...base,
          ...args,
        }),
      ).toEqual([]);
      expect(parseRunControl(action, { ...base, ...args })).toMatchObject({
        command: { kind: action, runId: base.runId },
        requestId: base.requestId,
      });
    },
  );

  it.each([
    {},
    { input: { taskNotes: [] } },
    { input: { resolvedReasonIds: [], taskIds: [] } },
    { input: { resolvedReasonIds: {}, instructions: [] } },
    { input: { resolvedReasonIds: [], instructions: {} } },
    {
      input: {
        resolvedReasonIds: [],
        instructions: [{ taskId: "risk.finance" }],
      },
    },
    { input, attempts: [] },
  ])("rejects observed resume argument errors: %j", (args) => {
    const value = { ...base, ...args };
    expect(
      validateJsonSchemaValue(runControlParameters.resume, value).length,
    ).toBeGreaterThan(0);
    expect(() => parseRunControl("resume", value)).toThrowError();
  });

  it("shares structured resume and recovery parsing with CLI commands", () => {
    expect(parseRunControl("resume", { ...base, input }).command).toEqual(
      parseRunCommand("resume", `run ${JSON.stringify(input)}`),
    );
    const attempts = [{ taskId: "risk.finance", attempt: 2 }];
    expect(parseRunControl("recover", { ...base, attempts }).command).toEqual(
      parseRunCommand("recover", `run ${JSON.stringify(attempts)}`),
    );
  });
});
