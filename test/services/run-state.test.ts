import { describe, expect, it } from "vitest";
import { assertStoredRun } from "../../src/services/run-state.js";

function fixture() {
  const scope = {
    security: {
      id: "US:NVDA",
      market: "US",
      symbol: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      timeZone: "America/New_York",
    },
    date: "2024-01-02",
    cutoff: "2024-01-02T21:00:00.000Z",
  };
  const ref = { runId: "run-one", artifactId: "artifact-one", revision: 1 };
  return {
    schemaVersion: 1,
    runId: "run-one",
    revision: 3,
    contents: [],
    stateVersion: 3,
    lineage: null,
    scope,
    mode: "quick",
    definition: {
      scope,
      mode: "quick",
      tasks: [
        {
          id: "analysis",
          executor: { kind: "role", role: "analyst", specialty: "market" },
          dependsOn: [] as string[],
          inputTasks: [] as string[],
          outputKinds: ["analysis"],
          dataRequirements: [
            { dataset: "market", fields: ["close"], requiredForDecision: true },
          ],
          instructionVersion: 1,
        },
      ],
    },
    definitionRef: { kind: "input", id: "definition" },
    inputs: [{ name: "prompt", ref: { kind: "input", id: "prompt" } }],
    status: "active",
    tasks: [
      {
        taskId: "analysis",
        status: "succeeded",
        attempts: [
          {
            number: 1,
            status: "succeeded",
            inputRefs: [],
            outputRefs: [ref],
            instructionVersion: 1,
            sessionId: "session-one",
            startedAt: "2024-01-02T21:01:00.000Z",
            endedAt: "2024-01-02T21:02:00.000Z",
            failure: null,
          },
        ],
        outputRefs: [ref],
      },
    ],
    artifacts: [
      {
        ref,
        kind: "analysis",
        taskId: "analysis",
        attempt: 1,
        createdAt: "2024-01-02T21:02:00.000Z",
      },
    ],
    evidence: [],
    receipts: [
      {
        scope: "coordinator",
        action: "open",
        requestId: "open-one",
        request: { kind: "input", id: "request-one" },
        result: { runId: "run-one" },
      },
      {
        scope: "coordinator",
        action: "claim",
        requestId: "claim-one",
        request: { kind: "input", id: "request-two" },
        result: {
          runId: "run-one",
          taskId: "analysis",
          attempt: 1,
          inputRefs: [],
          instructionVersion: 1,
        },
      },
      {
        scope: "task",
        action: "commit_artifact",
        requestId: "commit-one",
        request: { kind: "input", id: "request-three" },
        result: {
          runId: "run-one",
          taskId: "analysis",
          attempt: 1,
          refs: [ref],
        },
      },
    ],
    versions: {
      plugin: "1",
      mode: "quick-1",
      prompts: { analyst: "1" },
      skills: {},
      adapters: {},
      normalization: {},
    },
    createdAt: "2024-01-02T21:00:00.000Z",
    updatedAt: "2024-01-02T21:02:00.000Z",
    completedAt: null,
    blockReasons: [],
  };
}
function damaged(change: (value: ReturnType<typeof fixture>) => void): void {
  const value = fixture();
  change(value);
  const before = structuredClone(value);
  expect(() => assertStoredRun(value)).toThrowError(
    expect.objectContaining({ code: "STORAGE_FAILED" }),
  );
  expect(value).toEqual(before);
}
function controlReceipt(action: string, result: Record<string, unknown>) {
  return {
    scope: "coordinator",
    action,
    requestId: `${action}-one`,
    request: { kind: "input", id: `request-${action}` },
    result: { runId: "run-one", ...result },
  };
}
function instructionFixture() {
  const value = fixture();
  const instructionRef = { kind: "input", id: "instruction-two" };
  return {
    ...value,
    definition: {
      ...value.definition,
      tasks: value.definition.tasks.map((task) => ({
        ...task,
        instructionVersion: 2,
      })),
    },
    inputs: [
      {
        name: "instruction:analysis",
        ref: instructionRef,
        instruction: { taskId: "analysis", version: 2 },
      },
    ],
    tasks: value.tasks.map((task) => ({
      ...task,
      attempts: task.attempts.map((attempt) => ({
        ...attempt,
        instructionVersion: 2,
        instructionRef,
      })),
    })),
    receipts: value.receipts.map((receipt) =>
      receipt.action === "claim"
        ? {
            ...receipt,
            result: {
              ...receipt.result,
              instructionVersion: 2,
              instructionRef,
            },
          }
        : receipt,
    ),
  };
}
function taskDataFixture() {
  const value = fixture();
  const inputRef = { kind: "input", id: "memory-one" };
  return {
    ...value,
    evidence: [
      {
        evidenceId: "evidence-one",
        taskId: "analysis",
        attempt: 1,
        callId: "query-one",
      },
    ],
    inputs: [
      {
        name: "memory:analysis",
        ref: inputRef,
        memory: { taskId: "analysis", attempt: 1, callId: "recall-one" },
      },
    ],
    receipts: [
      ...value.receipts,
      controlReceipt("record_evidence", {
        evidenceId: "evidence-one",
        selector: "/data",
      }),
      controlReceipt("record_memory_input", { inputRef }),
    ],
  };
}

describe("stored run restoration boundary", () => {
  it("preserves explicit workflow policy and rejects malformed policy at the storage boundary", () => {
    const base = fixture();
    const value = {
      ...base,
      definition: {
        ...base.definition,
        tasks: base.definition.tasks.map((task) => ({
          ...task,
          valuation: "research",
        })),
        stages: [
          {
            id: "analysis",
            taskIds: ["analysis"],
            beforeTasks: [],
            dispatch: "together",
          },
        ],
      },
      stageReviews: [],
    };
    const before = structuredClone(value);
    expect(() => assertStoredRun(value)).not.toThrow();
    expect(value).toEqual(before);
    for (const field of ["valuation", "dispatch"] as const) {
      const damaged = structuredClone(value);
      if (field === "valuation")
        damaged.definition.tasks[0]!.valuation = "unknown";
      else damaged.definition.stages[0]!.dispatch = "unknown";
      expect(() => assertStoredRun(damaged)).toThrowError(
        expect.objectContaining({ code: "STORAGE_FAILED" }),
      );
    }
  });

  it("accepts a complete stored state without changing it", () => {
    const value = fixture();
    const before = structuredClone(value);
    expect(assertStoredRun(value)).toBeUndefined();
    expect(value).toEqual(before);
  });

  it("preserves numeric instruction versions accepted by the definition contract", () => {
    const value = fixture();
    value.definition.tasks[0]!.instructionVersion = 0;
    value.tasks[0]!.attempts[0]!.instructionVersion = 0;
    value.receipts[1]!.result.instructionVersion = 0;
    expect(assertStoredRun(value)).toBeUndefined();
  });

  it.each([1, 2])(
    "rejects prior business version %i without implicitly upgrading it",
    (version) => {
      const value: Partial<ReturnType<typeof fixture>> = {
        ...fixture(),
        stateVersion: version,
      };
      delete value.evidence;
      const before = structuredClone(value);
      expect(() => assertStoredRun(value)).toThrowError(
        expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
      );
      expect(value).toEqual(before);
      expect(value.stateVersion).toBe(version);
    },
  );

  it("rejects a missing required collection", () => {
    const value: Partial<ReturnType<typeof fixture>> = fixture();
    delete value.receipts;
    expect(() => assertStoredRun(value)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("rejects task states missing from the saved definition", () => {
    damaged((value) => {
      value.tasks[0]!.taskId = "unknown";
    });
  });

  it("rejects unsafe attempt numbers and artifact revisions", () => {
    damaged((value) => {
      value.tasks[0]!.attempts[0]!.number = Number.MAX_SAFE_INTEGER + 1;
    });
    damaged((value) => {
      value.artifacts[0]!.ref.revision = 0;
    });
  });

  it("rejects a receipt result with the wrong action shape", () => {
    damaged((value) => {
      value.receipts[0]!.action = "finalize";
    });
  });

  it("rejects an unknown executor and a graph whose dependency is missing", () => {
    damaged((value) => {
      value.definition.tasks[0]!.executor.kind = "unknown";
    });
    const value = fixture();
    value.definition.tasks[0]!.dependsOn = ["missing"];
    expect(() => assertStoredRun(value)).toThrowError(
      expect.objectContaining({
        code: "STORAGE_FAILED",
        cause: expect.objectContaining({ code: "INVALID_INPUT" }),
      }),
    );
  });

  it("rejects scope and mode drift from the saved definition", () => {
    damaged((value) => {
      value.mode = "deep";
    });
    damaged((value) => {
      value.scope = { ...value.scope, date: "2024-01-03" };
    });
  });

  it("rejects attempt order and current task status drift", () => {
    damaged((value) => {
      value.tasks[0]!.attempts[0]!.number = 2;
    });
    damaged((value) => {
      value.tasks[0]!.status = "running";
    });
  });

  it("requires exactly one creation receipt for this run", () => {
    damaged((value) => {
      value.receipts = value.receipts.slice(1);
    });
    damaged((value) => {
      value.receipts.push({ ...value.receipts[0]! });
    });
    damaged((value) => {
      value.receipts[0]!.result.runId = "another-run";
    });
  });

  it("requires receipt request snapshots to be input references", () => {
    damaged((value) => {
      value.receipts[0]!.request.kind = "evidence";
    });
  });

  it("accepts each control receipt result without requiring a task attempt on run controls", () => {
    const value = fixture();
    const ref = value.artifacts[0]!.ref;
    const cases = [
      controlReceipt("cancel", {
        status: "cancelled",
        stopAttempts: [{ taskId: "analysis", attempt: 1 }],
      }),
      controlReceipt("block", {
        status: "blocked",
        reasonIds: ["source-down"],
      }),
      controlReceipt("resume", {
        status: "active",
        revisedTasks: ["analysis"],
        remainingReasonIds: [],
      }),
      controlReceipt("redo", {
        taskId: "analysis",
        status: "blocked",
        affectedTasks: ["analysis"],
        stopAttempts: [],
        invalidatedRefs: [ref],
      }),
      controlReceipt("recover_attempts", {
        failedAttempts: [{ taskId: "analysis", attempt: 1 }],
      }),
    ];
    for (const receipt of cases) {
      expect(
        assertStoredRun({ ...value, receipts: [...value.receipts, receipt] }),
      ).toBeUndefined();
    }
  });

  it("accepts persisted instruction metadata and fixed instruction references", () => {
    const value = instructionFixture();
    const before = structuredClone(value);
    expect(assertStoredRun(value)).toBeUndefined();
    expect(value).toEqual(before);
  });

  it.each(["succeeded", "failed", "invalidated"])(
    "accepts a cancelled task retaining a historical %s attempt",
    (status) => {
      const value = fixture();
      value.status = "cancelled";
      value.tasks[0]!.status = "cancelled";
      value.tasks[0]!.outputRefs = [];
      value.tasks[0]!.attempts[0]!.status = status;
      expect(assertStoredRun(value)).toBeUndefined();
    },
  );

  it("rejects malformed control targets, invalidated references and result statuses", () => {
    const value = fixture();
    const receipts = [
      controlReceipt("cancel", {
        status: "cancelled",
        stopAttempts: [{ taskId: "analysis", attempt: 0 }],
      }),
      controlReceipt("redo", {
        taskId: "analysis",
        status: "active",
        affectedTasks: ["analysis"],
        stopAttempts: [],
        invalidatedRefs: [
          { runId: "run-one", artifactId: "artifact-one", revision: 0 },
        ],
      }),
      controlReceipt("resume", {
        status: "completed",
        revisedTasks: [],
        remainingReasonIds: [],
      }),
    ];
    for (const receipt of receipts)
      expect(() =>
        assertStoredRun({ ...value, receipts: [...value.receipts, receipt] }),
      ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
  });

  it("rejects a cancelled task that still retains a running attempt", () => {
    const value = fixture();
    value.status = "cancelled";
    value.tasks[0]!.status = "cancelled";
    value.tasks[0]!.outputRefs = [];
    value.tasks[0]!.attempts[0]!.status = "running";
    expect(() => assertStoredRun(value)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("rejects malformed optional instruction fields without adding defaults", () => {
    const value = instructionFixture();
    const input = value.inputs[0]!;
    expect(() =>
      assertStoredRun({
        ...value,
        inputs: [{ ...input, instruction: { taskId: 7, version: 2 } }],
      }),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    value.tasks[0]!.attempts[0]!.instructionRef.kind = "evidence";
    expect(() => assertStoredRun(value)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("accepts identified block reasons and rejects missing identifiers or invalid attempts", () => {
    const value = fixture();
    const reason = {
      id: "source-down",
      taskId: "analysis",
      attempt: 1,
      code: "SOURCE_UNAVAILABLE",
      message: "Provider unavailable",
    };
    expect(
      assertStoredRun({
        ...value,
        status: "blocked",
        blockReasons: [
          reason,
          { ...reason, id: "run-wide", taskId: null, attempt: null },
        ],
      }),
    ).toBeUndefined();
    for (const malformed of [
      { ...reason, id: null },
      { ...reason, attempt: "1" },
    ])
      expect(() =>
        assertStoredRun({ ...value, blockReasons: [malformed] }),
      ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
  });

  it("accepts evidence and memory registration receipts with their index metadata", () => {
    const value = taskDataFixture();
    const before = structuredClone(value);
    expect(assertStoredRun(value)).toBeUndefined();
    expect(value).toEqual(before);
  });

  it("accepts copied evidence and memory receipt results", () => {
    const value = taskDataFixture();
    const receipts = value.receipts.map((entry) => ({
      ...entry,
      action:
        entry.action === "record_evidence"
          ? "replay_evidence"
          : entry.action === "record_memory_input"
            ? "replay_memory_input"
            : entry.action,
    }));
    expect(assertStoredRun({ ...value, receipts })).toBeUndefined();
  });

  it("requires the evidence index and rejects malformed entries", () => {
    const value: Partial<ReturnType<typeof fixture>> = fixture();
    delete value.evidence;
    expect(() => assertStoredRun(value)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    const indexed = taskDataFixture();
    expect(() =>
      assertStoredRun({
        ...indexed,
        evidence: [{ ...indexed.evidence[0]!, attempt: 0 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
  });

  it("rejects a damaged evidence source or memory input receipt result", () => {
    const value = fixture();
    const receipts = [
      controlReceipt("record_evidence", {
        evidenceId: "evidence-one",
        selector: null,
      }),
      controlReceipt("record_memory_input", {
        inputRef: { kind: "evidence", id: "memory-one" },
      }),
      controlReceipt("replay_evidence", {
        evidenceId: "evidence-one",
        selector: null,
      }),
      controlReceipt("replay_memory_input", {
        inputRef: { kind: "evidence", id: "memory-one" },
      }),
    ];
    for (const receipt of receipts)
      expect(() =>
        assertStoredRun({ ...value, receipts: [...value.receipts, receipt] }),
      ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
  });

  it("requires memory snapshot call metadata and an input reference", () => {
    const value = taskDataFixture();
    const input = value.inputs[0]!;
    const inputs = [
      { ...input, memory: { ...input.memory, callId: null } },
      { ...input, ref: { kind: "evidence", id: "memory-one" } },
    ];
    for (const malformed of inputs)
      expect(() =>
        assertStoredRun({ ...value, inputs: [malformed] }),
      ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
  });

  it("accepts a pinned parent lineage without changing the stored value", () => {
    const value = {
      ...fixture(),
      lineage: {
        sourceRunId: "parent-run",
        sourceRevision: 7,
        snapshotRef: { kind: "input", id: "replay-inputs" },
      },
    };
    const before = structuredClone(value);
    expect(assertStoredRun(value)).toBeUndefined();
    expect(value).toEqual(before);
  });

  it.each([
    undefined,
    {
      sourceRunId: "run-one",
      sourceRevision: 1,
      snapshotRef: { kind: "input", id: "snapshot" },
    },
    {
      sourceRunId: "parent",
      sourceRevision: 0,
      snapshotRef: { kind: "input", id: "snapshot" },
    },
    {
      sourceRunId: "parent",
      sourceRevision: 1,
      snapshotRef: { kind: "evidence", id: "snapshot" },
    },
  ])("rejects invalid or absent lineage: %j", (lineage) => {
    expect(() => assertStoredRun({ ...fixture(), lineage })).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });
});
