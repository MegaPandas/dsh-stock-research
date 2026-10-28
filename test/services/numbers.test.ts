import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArtifactInput,
  NumericClaim,
} from "../../src/contracts/artifacts.js";
import type { MarketData, SourceRef } from "../../src/contracts/data.js";
import type { NumberTarget } from "../../src/contracts/numbers.js";
import type { RunState } from "../../src/contracts/runs.js";
import type { EvidenceInput } from "../../src/contracts/task-data.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import {
  withIndicators,
  withPriceReturn,
} from "../../src/services/derived-queries.js";
import { US_SECURITY } from "../fixtures/market.js";

// Synthetic availability witnesses exercise the gate; they do not describe a live vendor.
const cleanups: (() => void)[] = [];
const sourceQuery = {
  dataset: "market" as const,
  provider: "fixture",
  parameters: { maxAgeMs: 86_400_000 },
};
function content(claims: NumericClaim[]): ArtifactInput {
  return {
    kind: "analysis",
    title: "Numeric fixture",
    body: "Fixture",
    inputRefs: [],
    claims,
    payload: {},
  };
}
function observed(
  source: SourceRef,
  value = 100,
  id = "base",
  unit = "USD/share",
): NumericClaim {
  return { id, kind: "observed", value, unit, source };
}
function estimated(
  source: SourceRef,
  value = 120,
  id = "target",
): Extract<NumericClaim, { kind: "estimated" }> {
  return {
    id,
    kind: "estimated",
    value,
    unit: "USD/share",
    method: "Fixture scenario",
    assumptions: ["Fixture assumption"],
    evidence: [{ ...source, selector: "/data" }],
  };
}
function gain(
  start = "base",
  end = "target",
  value = 0.2,
): Extract<NumericClaim, { kind: "calculated" }> {
  return {
    id: "gain",
    kind: "calculated",
    value,
    unit: "ratio",
    operation: "simple_return",
    inputs: [
      { kind: "local", claimId: start },
      { kind: "local", claimId: end },
    ],
  };
}
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-numbers-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const store = new RunStore<RunState>(root);
  const runs = new RunService(store, () => "2024-01-05T00:00:00.000Z");
  const scope = {
    security: US_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-03T22:00:00.000Z",
  };
  const { runId } = runs.open(
    "owner",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: ["a", "b"].map((id) => ({
          id,
          executor: { kind: "role", role: "analyst", specialty: "market" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        })),
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
  const claim = (id = "a", request = `claim-${id}`) => ({
    ...runs.claim({ runId, identity: "owner" }, id, request),
    identity: "worker",
    sessionId: null,
  });
  const operation = claim();
  const numbers = new NumberService(runs);
  function frame(): EvidenceInput<MarketData> {
    return {
      envelope: {
        dataset: "market",
        data: {
          currency: "USD",
          adjustment: "split_adjusted",
          bars: [100, 120].map((close, index) => ({
            date: `2024-01-0${index + 2}`,
            asOf: `2024-01-0${index + 2}T21:00:00.000Z`,
            availableAt: `2024-01-0${index + 2}T21:00:00.000Z`,
            sessionComplete: true,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000,
          })),
        },
        source: {
          provider: "fixture",
          url: "https://example.com/numeric-fixture",
          adapterVersion: "1",
          normalizationVersion: "1",
        },
        asOf: "2024-01-03T21:00:00.000Z",
        availableAt: null,
        retrievedAt: "2024-01-04T00:00:00.000Z",
        cutoff: scope.cutoff,
        ageMs: 3_600_000,
        stale: false,
        historicalKnowledge: "verified",
        gaps: [],
      },
      candidates: [],
    };
  }
  const record = (data = frame(), callId = "data", query = sourceQuery) => {
    const ref = runs.recordEvidence(operation, query, data, callId);
    return { ...ref, selector: "/data/bars/0/close" };
  };
  const check = (claims: NumericClaim[]) =>
    numbers.checkNumbers(operation, {
      kind: "pending",
      contentId: "candidate",
      content: content(claims),
    });
  function returns(comparable = true) {
    const data = frame();
    return withPriceReturn(data.envelope, {
      historyStartDate: "2024-01-02",
      startDate: "2024-01-02",
      endDate: "2024-01-03",
      maxAgeMs: 86_400_000,
      comparable,
    });
  }
  return {
    directory,
    root,
    store,
    runs,
    runId,
    scope,
    claim,
    operation,
    numbers,
    frame,
    record,
    check,
    returns,
  };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("numeric claim gate", () => {
  it("checks manual historical selectors without candidate whitelist and leaves state unchanged", () => {
    const c = setup();
    const ref = c.record();
    const before = c.store.read(c.runId);
    const target: NumberTarget = {
      kind: "pending",
      contentId: "original-id",
      content: content([observed(ref)]),
    };
    const result = c.numbers.checkNumbers(c.operation, target);
    expect(result).toMatchObject({
      checkerVersion: "1",
      target: { kind: "pending", contentId: "original-id" },
      scope: c.scope,
      passed: true,
    });
    target.content.claims[0]!.value = 999;
    expect(result.claims[0]!.claim.value).toBe(100);
    expect(c.store.read(c.runId)).toEqual(before);
  });

  it.each([
    { value: 100.000001, unit: "USD/share", code: "value" },
    { value: 100, unit: "CNY/share", code: "unit" },
  ])(
    "rejects $code mismatch without display rounding",
    ({ value, unit, code }) => {
      const c = setup();
      const result = c.check([observed(c.record(), value, "p", unit)]);
      expect(result.passed).toBe(false);
      expect(result.claims[0]!.issues[0]!.code).toBe(code);
    },
  );

  it("reports multiple failed claims while retaining successful ones", () => {
    const c = setup();
    const ref = c.record();
    const result = c.check([
      observed(ref),
      observed({ ...ref, selector: "/ageMs" }, 3_600_000, "metadata", "ms"),
      observed({ ...ref, selector: "/data/__proto__/value" }, 1, "prototype"),
    ]);
    expect(result.claims.map(({ passed }) => passed)).toEqual([
      true,
      false,
      false,
    ]);
    expect(result.claims.slice(1).map(({ issues }) => issues[0]!.code)).toEqual(
      ["selector", "selector"],
    );
  });

  it("rejects an unregistered or foreign evidence reference without writing", () => {
    const c = setup();
    const ref = c.record();
    const result = c.check([
      observed({ ...ref, evidenceId: "missing" }),
      observed({ ...ref, runId: "foreign" }, 100, "foreign"),
    ]);
    expect(
      result.claims.every(({ issues }) => issues[0]!.code === "reference"),
    ).toBe(true);
  });

  it.each([
    { runId: "foreign", code: "ACCESS_DENIED" },
    { runId: null, code: "INVALID_ARTIFACT" },
  ])("rejects inaccessible artifact targets: $code", ({ runId, code }) => {
    const c = setup();
    expect(() =>
      c.numbers.checkNumbers(c.operation, {
        kind: "artifact",
        ref: { runId: runId ?? c.runId, artifactId: "missing", revision: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("keeps a missing observation distinct from zero", () => {
    const c = setup();
    const frame = c.frame();
    frame.envelope.data.bars[0]!.close = null;
    frame.envelope.gaps.push({
      code: "missing",
      field: "/data/bars/0/close",
      detail: "Fixture missing close.",
    });
    const result = c.check([observed(c.record(frame), 0)]);
    expect(result.claims[0]!.issues[0]!.code).toBe("value");
    expect(result.claims[0]!.warnings[0]!.gap?.code).toBe("missing");
  });

  it("accepts an early captured snapshot without inventing publication time or clearing gaps", () => {
    const c = setup();
    const frame = c.frame();
    frame.envelope.historicalKnowledge = "unverified";
    frame.envelope.retrievedAt = "2024-01-03T21:30:00.000Z";
    for (const bar of frame.envelope.data.bars) bar.availableAt = null;
    frame.envelope.gaps.push({
      code: "unverified_time",
      field: "/data/bars",
      detail: "Earliest publication is unknown.",
    });
    const ref = c.record(frame);
    const before = c.runs.readEvidence(ref);
    const result = c.check([observed(ref)]);
    expect(result.passed).toBe(true);
    expect(result.claims[0]!.warnings[0]!.gap?.code).toBe("unverified_time");
    expect(c.runs.readEvidence(ref)).toEqual(before);
  });

  it("rejects late unverified captures and explicitly late publication", () => {
    const c = setup();
    const first = c.frame();
    first.envelope.historicalKnowledge = "unverified";
    first.envelope.data.bars[0]!.availableAt = null;
    first.envelope.gaps.push({
      code: "unverified_time",
      field: "/data/bars/0/close",
      detail: "Version is unverified.",
    });
    const a = c.record(first, "first");
    const second = c.frame();
    second.envelope.retrievedAt = "2024-01-03T21:30:00.000Z";
    second.envelope.data.bars[0]!.availableAt = "2024-01-04T00:00:00.000Z";
    const b = c.record(second, "second");
    const result = c.check([observed(a), observed(b, 100, "late")]);
    expect(
      result.claims.every(({ issues }) => issues[0]!.code === "time"),
    ).toBe(true);
  });

  it("checks a field's own availability and gap instead of another field's qualification", () => {
    const c = setup();
    const frame = c.frame();
    frame.envelope.historicalKnowledge = "unverified";
    frame.envelope.data.bars[1]!.availableAt = null;
    frame.envelope.gaps.push({
      code: "unverified_time",
      field: "/data/bars/1/close",
      detail: "Second point unverified.",
    });
    const ref = c.record(frame);
    const result = c.check([
      observed(ref),
      observed({ ...ref, selector: "/data/bars/1/close" }, 120, "second"),
    ]);
    expect(result.claims.map(({ passed }) => passed)).toEqual([true, false]);
    expect(result.claims[0]!.warnings).toEqual([]);
  });

  it("keeps global stale metadata as a warning without changing a valid number", () => {
    const c = setup();
    const frame = c.frame();
    frame.envelope.stale = true;
    frame.envelope.gaps.push({
      code: "stale",
      field: "/asOf",
      detail: "Fixture freshness limit exceeded.",
    });
    const result = c.check([
      observed(
        c.record(frame, "stale", {
          ...sourceQuery,
          parameters: { maxAgeMs: 60_000 },
        }),
      ),
    ]);
    expect(result.passed).toBe(true);
    expect(result.claims[0]!.warnings).toContainEqual(
      expect.objectContaining({
        gap: expect.objectContaining({ code: "stale" }),
      }),
    );
  });

  it("checks forward local inputs and preserves explicit estimate warnings", () => {
    const c = setup();
    const ref = c.record();
    const result = c.check([gain(), estimated(ref), observed(ref)]);
    expect(result.passed).toBe(true);
    expect(result.claims.map(({ claim }) => claim.id)).toEqual([
      "gain",
      "target",
      "base",
    ]);
    expect(result.claims[0]!.warnings).toContainEqual(
      expect.objectContaining({ code: "estimate" }),
    );
  });

  it.each(["method", "assumptions"])(
    "rejects estimates missing $0",
    (field) => {
      const c = setup();
      const claim = estimated(c.record());
      if (field === "method") claim.method = " ";
      else claim.assumptions = [];
      expect(c.check([claim]).claims[0]!.issues[0]!.code).toBe("estimate");
    },
  );

  it("checks an estimate's method and assumptions without fabricating source references", () => {
    const c = setup();
    const claim = { ...estimated(c.record()), evidence: [] };
    const result = c.check([claim]);
    expect(result.passed).toBe(true);
    expect(result.claims[0]!.claim).toEqual(claim);
    expect(result.claims[0]!.warnings).toContainEqual(
      expect.objectContaining({ code: "estimate" }),
    );
  });

  it("accepts binary calculation rounding but rejects a business-sized deviation", () => {
    const c = setup();
    const ref = c.record();
    expect(c.check([observed(ref), estimated(ref), gain()]).passed).toBe(true);
    const result = c.check([
      observed(ref),
      estimated(ref),
      gain("base", "target", 0.200001),
    ]);
    expect(result.claims[2]!.issues[0]!.code).toBe("calculation");
  });

  it.each([
    { start: 0, end: 120, passed: false },
    { start: 100, end: -1, passed: false },
    { start: 100, end: 0, passed: true },
  ])("enforces price-return bounds $start → $end", ({ start, end, passed }) => {
    const c = setup();
    const ref = c.record();
    const result = c.check([
      estimated(ref, start, "base"),
      estimated(ref, end),
      gain("base", "target", -1),
    ]);
    expect(result.passed).toBe(passed);
    if (!passed) expect(result.claims[2]!.issues[0]!.code).toBe("calculation");
  });

  it("rejects local cycles, duplicate ids and nonfinite values", () => {
    const c = setup();
    const ref = c.record();
    const loop = gain("gain", "target");
    expect(c.check([loop, estimated(ref)]).claims[0]!.issues[0]!.code).toBe(
      "cycle",
    );
    expect(
      c
        .check([observed(ref), observed(ref, 100)])
        .claims.every(({ passed }) => !passed),
    ).toBe(true);
    expect(c.check([estimated(ref, Infinity)]).claims[0]!.issues[0]!.code).toBe(
      "value",
    );
  });

  it("requires actual common price basis across observations", () => {
    const c = setup();
    const ref = c.record();
    expect(
      c.check([
        observed(ref),
        observed({ ...ref, selector: "/data/bars/1/close" }, 120, "end"),
        gain("base", "end"),
      ]).claims[2]!.issues[0]!.code,
    ).toBe("calculation");
    const frame = c.returns();
    const saved = c.runs.recordEvidence(
      c.operation,
      { ...sourceQuery, dataset: "returns" },
      { envelope: frame, candidates: [] },
      "returns",
    );
    const a = observed({ ...saved, selector: "/data/start/price" });
    const b = observed({ ...saved, selector: "/data/end/price" }, 120, "end");
    expect(c.check([a, b, gain("base", "end")]).passed).toBe(true);
    expect(
      c.check([a, b, gain("end", "base", -1 / 6)]).claims[2]!.issues[0]!.code,
    ).toBe("calculation");
  });

  it("does not treat total-return prices as price-only inputs even with an estimated target", () => {
    const c = setup();
    const frame = c.frame();
    frame.envelope.data.adjustment = "total_return_adjusted";
    const ref = c.record(frame);
    expect(
      c.check([observed(ref), estimated(ref), gain()]).claims[2]!.issues[0]!
        .code,
    ).toBe("calculation");
  });

  it("accepts an indicator observation but does not treat it as an observed price", () => {
    const c = setup();
    const envelope = withIndicators(c.frame().envelope, [
      { kind: "sma", period: 1 },
    ]);
    const ref = c.record({ envelope, candidates: [] });
    const result = c.check([
      observed({ ...ref, selector: "/data/indicators/series/0/values/0" }),
      estimated(ref),
      gain(),
    ]);
    expect(result.claims[0]!.passed).toBe(true);
    expect(result.claims[2]!.issues[0]!.code).toBe("calculation");
  });

  it("propagates unavailable algorithm versions rather than reducing them to claim warnings", () => {
    const c = setup();
    const envelope = withIndicators(c.frame().envelope, [
      { kind: "sma", period: 1 },
    ]);
    envelope.data.indicators.algorithmVersion = "future";
    const ref = c.record({ envelope, candidates: [] });
    expect(() =>
      c.check([
        observed({ ...ref, selector: "/data/indicators/series/0/values/0" }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
  });

  it("includes original market gaps when checking aliased returns and estimate evidence", () => {
    const c = setup();
    const frame = c.returns();
    frame.gaps.push({
      code: "unverified_time",
      field: "/data/market",
      detail: "Original price versions unverified.",
    });
    const ref = c.runs.recordEvidence(
      c.operation,
      { ...sourceQuery, dataset: "returns" },
      { envelope: frame, candidates: [] },
      "returns",
    );
    const result = c.check([
      observed({ ...ref, selector: "/data/start/price" }),
      observed(
        { ...ref, selector: "/data/value" },
        frame.data.value!,
        "return",
        "ratio",
      ),
      { ...estimated(ref), evidence: [{ ...ref, selector: "/data/value" }] },
    ]);
    expect(
      result.claims.every(({ issues }) => issues[0]!.code === "time"),
    ).toBe(true);
    expect(
      result.claims.every(({ warnings }) =>
        warnings.some(({ gap }) => gap?.field === "/data/market"),
      ),
    ).toBe(true);
  });

  it("checks endpoint availability for estimates citing a return value", () => {
    const c = setup();
    const frame = c.returns();
    frame.retrievedAt = "2024-01-03T21:30:00.000Z";
    frame.data.end!.availableAt = "2024-01-04T00:00:00.000Z";
    const ref = c.runs.recordEvidence(
      c.operation,
      { ...sourceQuery, dataset: "returns" },
      { envelope: frame, candidates: [] },
      "returns",
    );
    const result = c.check([
      { ...estimated(ref), evidence: [{ ...ref, selector: "/data/value" }] },
    ]);
    expect(result.claims[0]!.issues[0]!.code).toBe("time");
  });

  it("checks all selected observations in a collection citation", () => {
    const c = setup();
    const frame = c.frame();
    frame.envelope.data.bars[1]!.sessionComplete = false;
    const ref = c.record(frame);
    const result = c.check([
      { ...estimated(ref), evidence: [{ ...ref, selector: "/data/bars" }] },
    ]);
    expect(result.claims[0]!.issues[0]!.code).toBe("time");
  });

  it("distinguishes superseded direct evidence from fixed historical artifact inputs", () => {
    const c = setup();
    const ref = c.record();
    const original = content([observed(ref)]);
    expect(
      c.numbers.checkNumbers(c.operation, {
        kind: "pending",
        contentId: "original",
        content: original,
      }).passed,
    ).toBe(true);
    const saved = c.runs.commitArtifact(c.operation, [original], "submit")
      .refs[0]!;
    c.runs.redo({ runId: c.runId, identity: "owner" }, "a", "redo");
    const next = c.claim("a", "claim-2");
    const current = c.runs.recordEvidence(
      next,
      sourceQuery,
      c.frame(),
      "new-data",
    );
    expect(c.check([observed(ref)]).claims[0]!.issues[0]!.code).toBe(
      "reference",
    );
    const candidate = content([
      estimated(current),
      {
        ...gain(),
        inputs: [
          { kind: "artifact", artifact: saved, claimId: "base" },
          { kind: "local", claimId: "target" },
        ],
      },
    ]);
    candidate.inputRefs = [saved];
    expect(
      c.numbers.checkNumbers(next, {
        kind: "pending",
        contentId: "next",
        content: candidate,
      }).passed,
    ).toBe(true);
    expect(
      c.numbers.checkNumbers(next, { kind: "artifact", ref: saved }).passed,
    ).toBe(true);
    candidate.inputRefs = [];
    expect(
      c.numbers.checkNumbers(next, {
        kind: "pending",
        contentId: "undeclared",
        content: candidate,
      }).claims[1]!.issues[0]!.code,
    ).toBe("reference");
  });

  it("propagates actual missing-file failures instead of creating a successful check", () => {
    const c = setup();
    const ref = c.record();
    fs.unlinkSync(
      join(
        c.directory,
        "runs",
        c.scope.date,
        `US_NVDA-quick-${c.runId}`,
        "evidence",
        `${ref.evidenceId}.json`,
      ),
    );
    expect(() => c.check([observed(ref)])).toThrowError(
      expect.objectContaining({
        code: "STORAGE_FAILED",
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
  });
});
