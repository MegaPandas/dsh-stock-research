import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArtifactInput,
  ArtifactKind,
} from "../../src/contracts/artifacts.js";
import type { ArtifactRef } from "../../src/contracts/data.js";
import type {
  OpenRunInput,
  RunState,
  StageReviewInput,
} from "../../src/contracts/runs.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { validateRunDefinition } from "../../src/services/definition.js";
import { attachResearchStages } from "../../src/app/research-stages.js";
import { createQuickInput } from "../../src/app/quick-plan.js";
import { createDeepInput } from "../../src/app/deep-plan.js";
import { US_SECURITY } from "../fixtures/market.js";

const roots: DataRoot[] = [];
const directories: string[] = [];
const now = () => "2024-07-01T12:00:00.000Z";
const scope = {
  security: US_SECURITY,
  date: "2024-06-30",
  cutoff: "2024-06-30T20:00:00.000Z",
};
afterEach(() => {
  for (const root of roots.splice(0)) root.close();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function input(staged = true): OpenRunInput {
  return {
    definition: {
      scope,
      mode: "quick",
      tasks: [
        {
          id: "a",
          executor: { kind: "role", role: "analyst", specialty: "market" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
        {
          id: "b",
          executor: {
            kind: "role",
            role: "analyst",
            specialty: "fundamentals",
          },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
        {
          id: "digest",
          executor: { kind: "service", service: "digest" },
          dependsOn: ["a", "b"],
          inputTasks: ["a", "b"],
          outputKinds: ["digest"],
          dataRequirements: [],
          instructionVersion: 1,
        },
        {
          id: "manager",
          executor: { kind: "role", role: "manager", specialty: "research" },
          dependsOn: ["digest"],
          inputTasks: ["digest"],
          outputKinds: ["plan"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
      ...(staged
        ? {
            stages: [
              { id: "analysis", taskIds: ["a", "b"], beforeTasks: ["digest"] },
              { id: "digest", taskIds: ["digest"], beforeTasks: ["manager"] },
            ],
          }
        : {}),
    },
    versions: {
      plugin: "1",
      mode: "1",
      prompts: {},
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [],
  };
}
function reopen(directory: string) {
  const root = new DataRoot(directory);
  roots.push(root);
  const store = new RunStore<RunState>(root);
  return { root, store, service: new RunService(store, now) };
}
function setup(staged = true) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-stage-review-"));
  directories.push(directory);
  const context = reopen(directory);
  const { runId } = context.service.open("owner", input(staged), "open");
  return {
    ...context,
    directory,
    runId,
    operation: { runId, identity: "owner" },
  };
}
function complete(
  service: RunService,
  runId: string,
  taskId: string,
  kind: ArtifactKind = "analysis",
  requestId = taskId,
): ArtifactRef[] {
  const claim = service.claim(
    { runId, identity: "owner" },
    taskId,
    `claim-${requestId}`,
  );
  const content: ArtifactInput = {
    kind,
    title: taskId,
    body: taskId,
    inputRefs: claim.inputRefs,
    claims: [],
    payload: {},
  };
  return service.commitArtifact(
    { ...claim, identity: taskId, sessionId: null },
    [content],
    `submit-${requestId}`,
  ).refs;
}
function analyses(h: ReturnType<typeof setup>) {
  return [
    ...complete(h.service, h.runId, "a"),
    ...complete(h.service, h.runId, "b"),
  ];
}
function review(
  refs: ArtifactRef[],
  changes: Partial<StageReviewInput> = {},
): StageReviewInput {
  return {
    stageId: "analysis",
    verdict: "accepted",
    feedback: "覆盖两个分析方向，依据和缺口已核对。",
    refs,
    ...changes,
  };
}

describe("persistent stage acceptance", () => {
  it("blocks real service and role claims until the main Agent accepts their current inputs", () => {
    const h = setup();
    complete(h.service, h.runId, "a");
    expect(() =>
      h.service.reviewStage(
        h.operation,
        review(h.service.view(h.operation).tasks[0]!.outputRefs),
        "early",
      ),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    complete(h.service, h.runId, "b");
    const stage = h.service.view(h.operation).stages![0]!;
    expect(stage).toMatchObject({ readyForReview: true, accepted: false });
    expect(h.service.view(h.operation).readyTasks).toEqual([]);
    for (const claim of [
      () => h.service.claim(h.operation, "digest", "direct"),
      () => h.service.claimService(h.operation, "digest", "digest", "service"),
      () =>
        h.service.claimServiceForCall(
          h.operation,
          "digest",
          "digest",
          "service-call",
        ),
    ])
      expect(claim).toThrowError(
        expect.objectContaining({ code: "TASK_NOT_READY" }),
      );
    h.service.reviewStage(h.operation, review(stage.refs), "accept-analysis");
    expect(h.service.view(h.operation).readyTasks).toEqual(["digest"]);
    const digestRefs = complete(h.service, h.runId, "digest", "digest");
    expect(() =>
      h.service.dispatchForCall(h.operation, "manager", "dispatch"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    h.service.reviewStage(
      h.operation,
      review(digestRefs, { stageId: "digest" }),
      "accept-digest",
    );
    expect(
      h.service.dispatchForCall(h.operation, "manager", "dispatch").attempt
        .status,
    ).toBe("running");
  });

  it("records a rejection without advancing or automatically restarting tasks", () => {
    const h = setup();
    const refs = analyses(h);
    const result = h.service.reviewStage(
      h.operation,
      review(refs, {
        verdict: "rejected",
        feedback: "基本面未解释现金流变化，需要补充。",
      }),
      "reject",
    );
    expect(result.review).toMatchObject({
      identity: "owner",
      verdict: "rejected",
      feedback: "基本面未解释现金流变化，需要补充。",
      recordedAt: now(),
    });
    const view = h.service.view(h.operation);
    expect(view.stages![0]!.accepted).toBe(false);
    expect(view.stageReviews).toEqual([result.review]);
    expect(
      view.tasks.slice(0, 2).map((task) => [task.status, task.attempt]),
    ).toEqual([
      ["succeeded", 1],
      ["succeeded", 1],
    ]);
    expect(view.readyTasks).toEqual([]);
  });

  it("rejects missing, duplicate, foreign and stale output references", () => {
    const h = setup();
    const refs = analyses(h);
    for (const [index, invalid] of [
      refs.slice(0, 1),
      [refs[0]!, refs[0]!],
      [{ ...refs[0]!, runId: "foreign-run" }, refs[1]!],
      [{ ...refs[0]!, revision: refs[0]!.revision + 1 }, refs[1]!],
    ].entries())
      expect(() =>
        h.service.reviewStage(h.operation, review(invalid), `invalid-${index}`),
      ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(() =>
      h.service.reviewStage(
        h.operation,
        review(refs, { feedback: " " }),
        "no-feedback",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(h.service.view(h.operation).stageReviews).toEqual([]);
  });

  it("invalidates acceptance after redo and requires the new artifact versions", () => {
    const h = setup();
    const original = analyses(h);
    const accepted = h.service.reviewStage(
      h.operation,
      review(original),
      "accept-original",
    );
    complete(h.service, h.runId, "digest", "digest");
    h.service.redo(h.operation, "a", "redo-a", "补充依据");
    expect(h.service.view(h.operation).stages![0]).toMatchObject({
      accepted: false,
      readyForReview: false,
      latestReview: accepted.review,
    });
    const revised = complete(h.service, h.runId, "a", "analysis", "a-2");
    expect(() =>
      h.service.reviewStage(h.operation, review(original), "stale-review"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(h.service.view(h.operation).readyTasks).not.toContain("digest");
    h.service.reviewStage(
      h.operation,
      review([original[1]!, ...revised]),
      "accept-revised",
    );
    expect(h.service.view(h.operation).readyTasks).toContain("digest");
    expect(h.service.view(h.operation).stageReviews).toHaveLength(2);
  });

  it("locks a review once downstream work starts and permits revision only after redo", () => {
    const h = setup();
    const request = review(analyses(h));
    const accepted = h.service.reviewStage(h.operation, request, "accept");
    const claim = h.service.claimService(
      h.operation,
      "digest",
      "digest",
      "claim-digest",
    );
    expect(h.service.view(h.operation).stages![0]).toMatchObject({
      accepted: true,
      readyForReview: false,
    });
    const reject = {
      ...request,
      verdict: "rejected" as const,
      feedback: "发现需要补充的依据。",
    };
    expect(() =>
      h.service.reviewStage(h.operation, reject, "reject-running"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    expect(h.service.reviewStage(h.operation, request, "accept")).toEqual(
      accepted,
    );
    h.service.commitArtifact(
      { ...claim, identity: "digest", sessionId: null },
      [
        {
          kind: "digest",
          title: "摘要",
          body: "摘要",
          inputRefs: claim.inputRefs,
          claims: [],
          payload: {},
        },
      ],
      "submit-digest",
    );
    expect(() =>
      h.service.reviewStage(h.operation, reject, "reject-succeeded"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    h.service.redo(h.operation, "digest", "redo-digest", "重新检查上游验收。");
    expect(h.service.view(h.operation).stages![0]!.readyForReview).toBe(true);
    h.service.reviewStage(h.operation, reject, "reject-after-redo");
    expect(h.service.view(h.operation).readyTasks).not.toContain("digest");
  });

  it("retains reviews and idempotent receipts across reopening, and rejects terminal changes", () => {
    const h = setup();
    const request = review(analyses(h));
    const result = h.service.reviewStage(h.operation, request, "accept");
    const revision = h.store.read(h.runId).revision;
    expect(h.service.reviewStage(h.operation, request, "accept")).toEqual(
      result,
    );
    expect(h.store.read(h.runId).revision).toBe(revision);
    h.root.close();
    const reopened = reopen(h.directory);
    expect(reopened.service.view(h.operation).stageReviews).toEqual([
      result.review,
    ]);
    expect(reopened.service.view(h.operation).readyTasks).toEqual(["digest"]);
    expect(
      reopened.service.reviewStage(h.operation, request, "accept"),
    ).toEqual(result);
    expect(() =>
      reopened.service.reviewStage(
        h.operation,
        { ...request, feedback: "changed" },
        "accept",
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    reopened.service.cancel(h.operation, "cancel");
    expect(() =>
      reopened.service.reviewStage(h.operation, request, "after-cancel"),
    ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
  });

  it("preserves the readiness and view contract of an unstaged run", () => {
    const h = setup(false);
    analyses(h);
    const view = h.service.view(h.operation);
    expect(view.readyTasks).toEqual(["digest"]);
    expect(view).not.toHaveProperty("stages");
    expect(view).not.toHaveProperty("stageReviews");
    expect(() =>
      h.service.reviewStage(h.operation, review([]), "review-legacy"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

describe("interactive research stage plans", () => {
  it("reviews each role stage once while retaining portable task plans", () => {
    const policy = {
      freshness: { market: 1, fundamentals: 1, macro: 1 },
      secCiks: {},
    };
    const quick = createQuickInput(scope, policy, []);
    const deep = createDeepInput(scope, policy, []);
    const interactiveQuick = attachResearchStages(quick);
    const interactiveDeep = attachResearchStages(deep);
    expect(quick.definition).not.toHaveProperty("stages");
    expect(deep.definition).not.toHaveProperty("stages");
    expect(interactiveQuick.definition.tasks).toEqual(quick.definition.tasks);
    expect(interactiveDeep.definition.tasks).toEqual(deep.definition.tasks);
    expect(
      interactiveQuick.definition.stages!.map((stage) => stage.id),
    ).toEqual(["analysis", "debate.1", "risk", "manager.decision"]);
    expect(interactiveDeep.definition.stages).toHaveLength(6);
    expect(
      interactiveDeep.definition.stages!.find(
        (stage) => stage.id === "analysis",
      )!.taskIds,
    ).toHaveLength(7);
    expect(
      interactiveDeep.definition.stages!.find((stage) => stage.id === "risk")!
        .taskIds,
    ).toEqual(["risk.finance", "risk.valuation", "risk.events"]);
    expect(() =>
      validateRunDefinition(interactiveQuick.definition),
    ).not.toThrow();
    expect(() =>
      validateRunDefinition(interactiveDeep.definition),
    ).not.toThrow();
    quick.versions.prompts.digest = "11";
    expect(attachResearchStages(quick).definition.stages).toHaveLength(7);
  });

  it("rejects invalid membership and gates outside the existing dependency graph", () => {
    for (const stages of [
      [{ id: "missing", taskIds: ["unknown"], beforeTasks: ["digest"] }],
      [{ id: "duplicate", taskIds: ["a", "a"], beforeTasks: ["digest"] }],
      [{ id: "self", taskIds: ["a"], beforeTasks: ["a"] }],
      [{ id: "cycle", taskIds: ["manager"], beforeTasks: ["a"] }],
      [{ id: "missing-edge", taskIds: ["a", "b"], beforeTasks: ["manager"] }],
    ]) {
      const definition = input().definition;
      definition.stages = stages;
      expect(() => validateRunDefinition(definition)).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });
});
