import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AnalysisPayload,
  ResearchArtifactInput,
} from "../../src/contracts/artifact-payloads.js";
import type { NumberTarget } from "../../src/contracts/numbers.js";
import type {
  RunOperation,
  RunState,
  TaskOperation,
} from "../../src/contracts/runs.js";
import type { TaskDefinition } from "../../src/contracts/workflow.js";
import {
  ArtifactNumberError,
  ArtifactService,
} from "../../src/services/artifacts.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

class CountedNumbers extends NumberService {
  calls = 0;
  override checkNumbers(operation: RunOperation, target: NumberTarget) {
    this.calls++;
    return super.checkNumbers(operation, target);
  }
}
const cleanups: (() => void)[] = [];
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-artifacts-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const store = new RunStore<RunState>(root);
  const runs = new RunService(store, () => "2024-01-03T00:00:00.000Z");
  const scope = {
    security: US_SECURITY,
    date: "2024-01-02",
    cutoff: "2024-01-02T21:00:00.000Z",
  };
  const task = (id: string, dependsOn: string[] = []): TaskDefinition => ({
    id,
    executor: { kind: "role", role: "analyst", specialty: "fixture" },
    dependsOn,
    inputTasks: dependsOn,
    outputKinds: ["analysis"],
    dataRequirements: [],
    instructionVersion: 1,
  });
  const { runId } = runs.open(
    "owner",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          task("a"),
          task("b", ["a"]),
          {
            ...task("review", ["a"]),
            executor: {
              kind: "role",
              role: "discussion",
              specialty: "fixture",
            },
            outputKinds: ["debate", "risk"],
          },
          {
            ...task("digest", ["a"]),
            executor: { kind: "service", service: "digest" },
            outputKinds: ["digest"],
          },
        ],
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
    },
    "open",
  );
  const operation = { runId, identity: "owner" };
  const claim = (
    taskId = "a",
    requestId = `claim-${taskId}`,
  ): TaskOperation => ({
    ...runs.claim(operation, taskId, requestId),
    identity: "worker",
    sessionId: null,
  });
  const current = claim();
  // Artificial early capture, no source/HTTP adapter is used.
  const frame = () => ({
    envelope: {
      dataset: "market" as const,
      data: {
        currency: "USD",
        adjustment: "split_adjusted" as const,
        bars: [
          {
            date: scope.date,
            asOf: scope.cutoff,
            availableAt: scope.cutoff,
            sessionComplete: true,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
          },
        ],
      },
      source: {
        provider: "fixture",
        url: "https://example.com/artifact-fixture",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: scope.cutoff,
      availableAt: null,
      retrievedAt: scope.cutoff,
      cutoff: scope.cutoff,
      ageMs: 0,
      stale: false,
      historicalKnowledge: "verified" as const,
      gaps: [],
    },
    candidates: [],
  });
  const evidence = runs.recordEvidence(
    current,
    {
      dataset: "market",
      provider: "fixture",
      parameters: { maxAgeMs: 60_000 },
    },
    frame(),
    "data",
  );
  const source = { ...evidence, selector: "/data/bars/0/close" };
  const numbers = new CountedNumbers(runs);
  const artifacts = new ArtifactService(runs, numbers);
  const analysis = (): Extract<ResearchArtifactInput, { kind: "analysis" }> & {
    payload: AnalysisPayload;
  } => ({
    kind: "analysis",
    title: "Fixture",
    body: "Price {{number:base}}.",
    inputRefs: [],
    claims: [
      { id: "base", kind: "observed", value: 100, unit: "USD/share", source },
    ],
    payload: {
      findings: [
        {
          text: "Price observation",
          evidence: [],
          numbers: [{ kind: "local", claimId: "base" }],
        },
      ],
      risks: [],
      gaps: [],
    },
  });
  const parent = () =>
    artifacts.submitArtifact(current, [analysis()], "parent").refs[0]!;
  return {
    directory,
    store,
    runs,
    operation,
    current,
    runId,
    scope,
    source,
    frame,
    numbers,
    artifacts,
    analysis,
    parent,
    claim,
  };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("artifact submission boundary", () => {
  it("checks once, atomically publishes a fixed version and renders its numeric body", () => {
    const c = setup();
    const content = c.analysis();
    const result = c.artifacts.submitArtifact(c.current, [content], "submit");
    expect(c.numbers.calls).toBe(1);
    expect(c.runs.view(c.operation).tasks[0]!.status).toBe("succeeded");
    expect(c.runs.readArtifact(result.refs[0]!).content).toEqual(content);
    content.claims[0]!.value = 999;
    expect(c.runs.readArtifact(result.refs[0]!).content.claims[0]!.value).toBe(
      100,
    );
    expect(
      fs.readFileSync(
        join(
          c.directory,
          "runs",
          c.scope.date,
          `US_NVDA-quick-${c.runId}`,
          "reports",
          "a.md",
        ),
        "utf8",
      ),
    ).toContain("Price 100 USD/share.");
  });

  it("returns detailed numeric failures without publishing or changing task state", () => {
    const c = setup();
    const content = c.analysis();
    content.claims[0]!.value = 101;
    const before = c.store.read(c.runId);
    let failure: unknown;
    try {
      c.artifacts.submitArtifact(c.current, [content], "submit");
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ArtifactNumberError);
    expect(failure).toMatchObject({
      code: "NUMBER_MISMATCH",
      checks: [
        expect.objectContaining({
          passed: false,
          claims: [
            expect.objectContaining({
              issues: [expect.objectContaining({ code: "value" })],
            }),
          ],
        }),
      ],
    });
    expect(c.store.read(c.runId)).toEqual(before);
    content.claims[0]!.value = 100;
    expect(
      c.artifacts.submitArtifact(c.current, [content], "submit").refs,
    ).toHaveLength(1);
  });

  it("does not repeat numeric validation for a persisted request, including after redo and cancel", () => {
    const c = setup();
    const content = c.analysis();
    const first = c.artifacts.submitArtifact(c.current, [content], "submit");
    c.runs.redo(c.operation, "a", "redo");
    c.runs.cancel(c.operation, "cancel");
    expect(
      c.artifacts.submitArtifact(
        c.current,
        [
          {
            ...content,
            payload: {
              gaps: [],
              risks: [],
              findings: content.payload.findings,
            },
          },
        ],
        "submit",
      ),
    ).toEqual(first);
    expect(c.numbers.calls).toBe(1);
    expect(() =>
      c.artifacts.submitArtifact(
        c.current,
        [{ ...content, title: "changed" }],
        "submit",
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(c.numbers.calls).toBe(1);
  });

  it("replays after service reconstruction and repairs a missing projection without rechecking", () => {
    const c = setup();
    const content = c.analysis();
    const committed = c.artifacts.submitArtifact(
      c.current,
      [content],
      "submit",
    );
    const projection = join(
      c.directory,
      "runs",
      c.scope.date,
      `US_NVDA-quick-${c.runId}`,
      "reports",
      "a.md",
    );
    fs.unlinkSync(projection);
    const runs = new RunService(c.store, () => "2024-01-04T00:00:00.000Z");
    const numbers = new CountedNumbers(runs);
    expect(
      new ArtifactService(runs, numbers).submitArtifact(
        c.current,
        [content],
        "submit",
      ),
    ).toEqual(committed);
    expect(numbers.calls).toBe(0);
    expect(fs.readFileSync(projection, "utf8")).toContain(
      "Price 100 USD/share.",
    );
  });

  it.each(["{{number:missing}}", "{{number:}}", "{{number:base", "{{number}}"])(
    "rejects invalid body placeholder %s before publication",
    (body) => {
      const c = setup();
      const content = { ...c.analysis(), body };
      expect(() =>
        c.artifacts.submitArtifact(c.current, [content], "submit"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
      expect(c.numbers.calls).toBe(0);
      expect(c.store.read(c.runId).artifacts).toEqual([]);
    },
  );

  it("validates every payload before publishing any output in a complete set", () => {
    const c = setup();
    const ref = c.parent();
    const operation = c.claim("review");
    const debate: ResearchArtifactInput = {
      kind: "debate",
      title: "Bull",
      body: "Argument",
      inputRefs: [ref],
      claims: [],
      payload: {
        side: "bull",
        arguments: [{ text: "Fixture", evidence: [], numbers: [] }],
        rebuttals: [],
        unresolved: [],
      },
    };
    const risk: ResearchArtifactInput = {
      kind: "risk",
      title: "Risk",
      body: "None identified",
      inputRefs: [ref],
      claims: [],
      payload: { issues: [] },
    };
    const before = c.store.read(c.runId);
    expect(() =>
      c.artifacts.submitArtifact(
        operation,
        [debate, { ...risk, payload: { issues: [], rating: "buy" } }],
        "submit",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(c.store.read(c.runId)).toEqual(before);
    expect(() =>
      c.artifacts.submitArtifact(operation, [debate], "submit"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    const saved = c.artifacts.submitArtifact(
      operation,
      [debate, risk],
      "submit",
    );
    expect(saved.refs).toHaveLength(2);
    expect(
      c.runs.view(c.operation).tasks.find((task) => task.taskId === "review")!
        .status,
    ).toBe("succeeded");
  });

  it("requires the exact claimed default version while allowing declared historical inputs", () => {
    const c = setup();
    const ref = c.parent();
    const operation = c.claim("b");
    const content = c.analysis();
    expect(() =>
      c.artifacts.submitArtifact(operation, [content], "submit"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    content.inputRefs = [ref];
    content.claims = [];
    content.body = "Adopted value";
    content.payload.findings[0]!.numbers = [
      { kind: "artifact", artifact: ref, claimId: "base" },
    ];
    expect(
      c.artifacts.submitArtifact(operation, [content], "submit").refs,
    ).toHaveLength(1);
  });

  it("adopts a historical artifact number without rechecking its superseded source", () => {
    const c = setup();
    const old = c.parent();
    c.runs.redo(c.operation, "a", "redo");
    const next = c.claim("a", "claim-2");
    const replacement = c.analysis();
    replacement.claims = [];
    replacement.body = "New context";
    replacement.payload.findings[0]!.numbers = [];
    const current = c.artifacts.submitArtifact(
      next,
      [replacement],
      "new-parent",
    ).refs[0]!;
    const operation = c.claim("b");
    const content = c.analysis();
    content.body = "Historical comparison";
    content.claims = [];
    content.inputRefs = [current, old];
    content.payload.findings[0]!.numbers = [
      { kind: "artifact", artifact: old, claimId: "base" },
    ];
    expect(
      c.artifacts.submitArtifact(operation, [content], "submit").refs,
    ).toHaveLength(1);
    expect(c.numbers.calls).toBe(3);
    expect(c.runs.readArtifact(old).content.claims[0]!.value).toBe(100);
  });
  it("adopts qualitative evidence through a fixed historical artifact", () => {
    const c = setup();
    const old = c.parent();
    c.runs.redo(c.operation, "a", "redo");
    const next = c.claim("a", "claim-2");
    const content = c.analysis();
    content.body = "A fixed prior finding";
    content.claims = [];
    content.inputRefs = [old];
    content.payload.findings[0]!.evidence = [old];
    content.payload.findings[0]!.numbers = [];
    expect(
      c.artifacts.submitArtifact(next, [content], "submit").refs,
    ).toHaveLength(1);
    expect(c.numbers.calls).toBe(2);
    expect(c.runs.readArtifact(old).content.claims[0]!.value).toBe(100);
  });

  it.each(["foreign", "missing", "claim"])(
    "rejects invalid adopted artifact %s",
    (kind) => {
      const c = setup();
      const ref = c.parent();
      const operation = c.claim("b");
      const content = c.analysis();
      content.inputRefs = [ref];
      const adopted =
        kind === "foreign"
          ? { ...ref, runId: "other" }
          : kind === "missing"
            ? { ...ref, revision: 99 }
            : ref;
      content.payload.findings[0]!.numbers = [
        {
          kind: "artifact",
          artifact: adopted,
          claimId: kind === "claim" ? "absent" : "base",
        },
      ];
      expect(() =>
        c.artifacts.submitArtifact(operation, [content], "submit"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    },
  );

  it("rejects unknown local payload numbers", () => {
    const c = setup();
    const content = c.analysis();
    content.payload.findings[0]!.numbers = [
      { kind: "local", claimId: "missing" },
    ];
    expect(() =>
      c.artifacts.submitArtifact(c.current, [content], "submit"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
  });

  it("requires a declared input for an adopted registered rebuttal target", () => {
    const c = setup();
    const ref = c.parent();
    const b = c.claim("b");
    const analysis = c.analysis();
    analysis.inputRefs = [ref];
    const other = c.artifacts.submitArtifact(b, [analysis], "submit-b")
      .refs[0]!;
    const review = c.claim("review");
    const debate: ResearchArtifactInput = {
      kind: "debate",
      title: "Bull",
      body: "Argument",
      inputRefs: [ref],
      claims: [],
      payload: {
        side: "bull",
        arguments: [{ text: "Fixture", evidence: [], numbers: [] }],
        rebuttals: [
          { text: "Rebuttal", evidence: [], numbers: [], target: other },
        ],
        unresolved: [],
      },
    };
    const risk: ResearchArtifactInput = {
      kind: "risk",
      title: "Risk",
      body: "None identified",
      inputRefs: [ref],
      claims: [],
      payload: { issues: [] },
    };
    expect(() =>
      c.artifacts.submitArtifact(review, [debate, risk], "submit"),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        message: expect.stringContaining("inputRefs"),
      }),
    );
  });

  it("checks payload evidence scope, selector and known-by time even without numeric claims", () => {
    const c = setup();
    const content = c.analysis();
    content.claims = [];
    content.body = "Qualitative finding";
    content.payload.findings[0]!.numbers = [];
    for (const source of [
      { ...c.source, runId: "other" },
      { ...c.source, evidenceId: "missing" },
      { ...c.source, selector: "/ageMs" },
      { ...c.source, selector: "/data/bars/length" },
    ]) {
      content.payload.findings[0]!.evidence = [source];
      expect(() =>
        c.artifacts.submitArtifact(c.current, [content], "submit"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    }
    const frame = c.frame();
    frame.envelope.retrievedAt = "2024-01-03T00:00:00.000Z";
    frame.envelope.data.bars[0]!.availableAt = "2024-01-03T00:00:00.000Z";
    const late = c.runs.recordEvidence(
      c.current,
      { dataset: "market", provider: "fixture", parameters: {} },
      frame,
      "late",
    );
    content.payload.findings[0]!.evidence = [late];
    expect(() =>
      c.artifacts.submitArtifact(c.current, [content], "submit"),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        cause: expect.any(Error),
      }),
    );
    content.payload.findings[0]!.evidence = [c.source];
    expect(
      c.artifacts.submitArtifact(c.current, [content], "submit").refs,
    ).toHaveLength(1);
  });

  it("rejects superseded direct citations while retaining their immutable records", () => {
    const c = setup();
    c.runs.redo(c.operation, "a", "redo");
    const next = c.claim("a", "claim-2");
    const content = c.analysis();
    content.claims = [];
    content.body = "Old snapshot";
    content.payload.findings[0]!.numbers = [];
    content.payload.findings[0]!.evidence = [c.source];
    expect(() =>
      c.artifacts.submitArtifact(next, [content], "submit"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(c.runs.readEvidence(c.source).evidenceId).toBe(c.source.evidenceId);
  });

  it("requires digest upstream versions to match its declared inputs", () => {
    const c = setup();
    const ref = c.parent();
    const operation = c.claim("digest");
    const content: Extract<ResearchArtifactInput, { kind: "digest" }> = {
      kind: "digest",
      title: "Digest",
      body: "Summary",
      inputRefs: [ref],
      claims: [],
      payload: {
        facts: [],
        disagreements: [],
        risks: [],
        gaps: [],
        upstreamRefs: [],
        numbers: [],
      },
    };
    expect(() =>
      c.artifacts.submitArtifact(operation, [content], "submit"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    content.payload.upstreamRefs = [ref];
    expect(
      c.artifacts.submitArtifact(operation, [content], "submit").refs,
    ).toHaveLength(1);
  });

  it("propagates storage failures before publication", () => {
    const c = setup();
    const ref = c.parent();
    const operation = c.claim("b");
    const content = c.analysis();
    content.inputRefs = [ref];
    fs.unlinkSync(
      join(
        c.directory,
        "runs",
        c.scope.date,
        `US_NVDA-quick-${c.runId}`,
        "artifacts",
        ref.artifactId,
        `${ref.revision}.json`,
      ),
    );
    expect(() =>
      c.artifacts.submitArtifact(operation, [content], "submit"),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_FAILED",
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
    expect(
      c.runs.view(c.operation).tasks.find((task) => task.taskId === "b")!
        .status,
    ).toBe("running");
  });
});
