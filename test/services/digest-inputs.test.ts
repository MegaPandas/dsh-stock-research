import { afterEach, describe, expect, it } from "vitest";
import type {
  ReportedGap,
  ResearchArtifactInput,
  RiskIssue,
} from "../../src/contracts/artifact-payloads.js";
import type {
  ArtifactRef,
  DataGap,
  SourceRef,
} from "../../src/contracts/data.js";
import type { TaskDefinition } from "../../src/contracts/workflow.js";
import { aggregateArtifactGaps } from "../../src/services/artifact-gaps.js";
import {
  ArtifactInputs,
  type ResearchArtifactVersion,
} from "../../src/services/artifact-inputs.js";
import {
  digestNumbers,
  digestRisks,
} from "../../src/services/digest-inputs.js";
import {
  decisionFixture,
  type DecisionFixtureOptions,
} from "../fixtures/decision.js";

type Fixture = ReturnType<typeof decisionFixture>;
const fixtures: Fixture[] = [];
function setup(options: DecisionFixtureOptions = {}): Fixture {
  const fixture = decisionFixture(options);
  fixtures.push(fixture);
  return fixture;
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function riskTask(id: string): TaskDefinition {
  return {
    id,
    executor: { kind: "role", role: "discussion", specialty: "fixture" },
    dependsOn: [],
    inputTasks: [],
    outputKinds: ["risk"],
    dataRequirements: [],
    instructionVersion: 1,
  };
}
function commitRisk(
  fixture: Fixture,
  taskId: string,
  recommendation = "Monitor liquidity",
  numbers: RiskIssue["numbers"] = [{ kind: "local", claimId: "exposure" }],
): ResearchArtifactVersion {
  const operation = {
    ...fixture.runs.claim(fixture.operation, taskId, `claim-${taskId}`),
    identity: "worker",
    sessionId: null,
  };
  const issue: RiskIssue = {
    issueId: "liquidity",
    description: "Liquidity uncertainty",
    impact: "Execution impact",
    trigger: "Volume declines",
    constraint: "Position restraint",
    recommendation,
    evidence: [fixture.source],
    numbers,
  };
  const content: ResearchArtifactInput = {
    kind: "risk",
    title: "Fixed risk input",
    body: "Observed {{number:exposure}}.",
    inputRefs: numbers.flatMap((input) =>
      input.kind === "artifact" ? [input.artifact] : [],
    ),
    claims: [
      {
        id: "exposure",
        kind: "observed",
        value: 100,
        unit: "USD/share",
        source: fixture.source,
      },
    ],
    payload: { issues: [issue] },
  };
  const result = fixture.artifacts.submitArtifact(
    operation,
    [content],
    `submit-${taskId}`,
  );
  return new ArtifactInputs(fixture.runs).artifact(result.refs[0]!);
}

describe("fixed digest number inputs", () => {
  it("preserves committed references, original claims and estimate labels", () => {
    const fixture = setup();
    const inputs = new ArtifactInputs(fixture.runs);
    const versions = inputs.closure([fixture.draftRef]);
    const before = structuredClone(versions);
    const calls = fixture.numbers.calls;
    const candidates = digestNumbers(versions, inputs);
    expect(candidates).toHaveLength(2);
    const base = candidates.find(({ input }) => input.claimId === "base")!;
    const target = candidates.find(({ input }) => input.claimId === "target")!;
    expect(base.input).toEqual({
      kind: "artifact",
      artifact: fixture.analysisRef,
      claimId: "base",
    });
    expect(base.claim).toEqual({
      id: "base",
      kind: "observed",
      value: 100,
      unit: "USD/share",
      source: fixture.source,
    });
    expect(base.estimated).toBe(false);
    expect(target.input).toEqual({
      kind: "artifact",
      artifact: fixture.draftRef,
      claimId: "target",
    });
    expect(target.claim).toEqual(fixture.draft.claims[0]);
    expect(target.estimated).toBe(true);
    expect(new Set(candidates.map(({ candidateId }) => candidateId)).size).toBe(
      2,
    );
    expect(versions).toEqual(before);
    expect(fixture.numbers.calls).toBe(calls);
  });

  it("binds calculated local inputs to their owning version and retains the stored result", () => {
    const fixture = setup({
      draft: (draft) => {
        draft.claims.push({
          id: "upside",
          kind: "calculated",
          value: 0.2,
          unit: "ratio",
          operation: "simple_return",
          inputs: [
            draft.payload.basePrice!,
            { kind: "local", claimId: "target" },
          ],
        });
      },
    });
    const inputs = new ArtifactInputs(fixture.runs);
    const calls = fixture.numbers.calls;
    const candidates = digestNumbers(
      inputs.closure([fixture.draftRef]),
      inputs,
    );
    const calculation = candidates.find(
      ({ input }) => input.claimId === "upside",
    )!;
    expect(calculation.input).toEqual({
      kind: "artifact",
      artifact: fixture.draftRef,
      claimId: "upside",
    });
    expect(calculation.claim).toEqual({
      id: "upside",
      kind: "calculated",
      value: 0.2,
      unit: "ratio",
      operation: "simple_return",
      inputs: [
        { kind: "artifact", artifact: fixture.analysisRef, claimId: "base" },
        { kind: "local", claimId: "target" },
      ],
    });
    expect(calculation.estimated).toBe(true);
    expect(
      candidates.find(({ input }) => input.claimId === "target")!.input
        .artifact,
    ).toEqual(fixture.draftRef);
    expect(
      candidates.find(({ input }) => input.claimId === "base")!.input.artifact,
    ).toEqual(fixture.analysisRef);
    expect(candidates).toHaveLength(3);
    expect(fixture.numbers.calls).toBe(calls);
  });

  it("deduplicates fixed inputs and reads their old facts after a later redo", () => {
    const fixture = setup();
    const inputs = new ArtifactInputs(fixture.runs);
    const versions = inputs.closure([fixture.draftRef]);
    fixture.runs.redo(fixture.operation, "analysis", "later-redo");
    const calls = fixture.numbers.calls;
    const candidates = digestNumbers([...versions, ...versions], inputs);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(({ input }) => input)).toEqual(
      expect.arrayContaining([
        { kind: "artifact", artifact: fixture.draftRef, claimId: "target" },
        { kind: "artifact", artifact: fixture.analysisRef, claimId: "base" },
      ]),
    );
    expect(candidates.map(({ claim }) => claim.value)).toEqual(
      expect.arrayContaining([120, 100]),
    );
    expect(fixture.numbers.calls).toBe(calls);
  });
});

describe("fixed digest risk inputs", () => {
  it("retains stable risk metadata while binding numbers and consuming sources through the checked artifact", () => {
    const fixture = setup({ additionalTasks: [riskTask("risk-extra")] });
    const version = commitRisk(fixture, "risk-extra");
    const before = structuredClone(version);
    const calls = fixture.numbers.calls;
    expect(digestRisks([version])).toEqual([
      {
        issueId: "liquidity",
        description: "Liquidity uncertainty",
        impact: "Execution impact",
        trigger: "Volume declines",
        constraint: "Position restraint",
        recommendation: "Monitor liquidity",
        evidence: [version.ref],
        numbers: [
          { kind: "artifact", artifact: version.ref, claimId: "exposure" },
        ],
      },
    ]);
    expect(version).toEqual(before);
    expect(fixture.numbers.calls).toBe(calls);
  });

  it("merges identical risk cores without losing or duplicating their fixed references", () => {
    const fixture = setup({
      additionalTasks: [riskTask("risk-a"), riskTask("risk-b")],
    });
    const first = commitRisk(fixture, "risk-a", "Monitor liquidity", [
      { kind: "artifact", artifact: fixture.analysisRef, claimId: "base" },
    ]);
    const second = commitRisk(fixture, "risk-b", "Monitor liquidity", [
      {
        claimId: "base",
        artifact: {
          revision: fixture.analysisRef.revision,
          artifactId: fixture.analysisRef.artifactId,
          runId: fixture.analysisRef.runId,
        },
        kind: "artifact",
      },
    ]);
    const risks = digestRisks([first, second, first]);
    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      issueId: "liquidity",
      recommendation: "Monitor liquidity",
    });
    expect(risks[0]!.evidence).toEqual([first.ref, second.ref]);
    expect(risks[0]!.numbers).toEqual([
      { kind: "artifact", artifact: fixture.analysisRef, claimId: "base" },
    ]);
  });

  it("rejects conflicting core content under the same stable issue id", () => {
    const fixture = setup({
      additionalTasks: [riskTask("risk-a"), riskTask("risk-b")],
    });
    const first = commitRisk(fixture, "risk-a");
    const second = commitRisk(fixture, "risk-b", "Avoid the position");
    expect(() => digestRisks([first, second])).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: "Conflicting inherited risk issue liquidity.",
      }),
    );
  });
});

function gapVersion(
  ref: ArtifactRef,
  content: ResearchArtifactInput,
): ResearchArtifactVersion {
  return {
    ref,
    taskId: ref.artifactId,
    attempt: 1,
    producerSessionId: null,
    createdAt: "2024-01-04T00:00:00.000Z",
    schemaVersion: 1,
    content,
  };
}
const missingClose: DataGap = {
  code: "missing",
  field: "/data/bars/0/close",
  detail: "Artificial closing price gap.",
};
const analysisOrigin: ArtifactRef = {
  runId: "artificial-run",
  artifactId: "analysis",
  revision: 1,
};
const sourceOrigin: SourceRef = {
  runId: "artificial-run",
  evidenceId: "source-a",
  selector: "/data/bars/0/close",
};
function digestGapVersion(
  ref: ArtifactRef,
  gaps: ReportedGap[],
): ResearchArtifactVersion {
  return gapVersion(ref, {
    kind: "digest",
    title: "Artificial inherited gaps",
    body: "Stored gaps retain their original attribution.",
    inputRefs: [],
    claims: [],
    payload: {
      facts: [],
      disagreements: [],
      risks: [],
      gaps,
      numbers: [],
      upstreamRefs: [],
    },
  });
}

describe("origin-preserving digest gaps", () => {
  it("keeps distinct artifact and source origins while deduplicating exact repeated gaps", () => {
    const analysis = gapVersion(analysisOrigin, {
      kind: "analysis",
      title: "Artificial analysis gap",
      body: "The selected closing price is missing.",
      inputRefs: [],
      claims: [],
      payload: {
        findings: [
          { text: "Closing price is missing", evidence: [], numbers: [] },
        ],
        risks: [],
        gaps: [missingClose],
      },
    });
    const sources = [
      { source: sourceOrigin, gaps: [missingClose] },
      { source: sourceOrigin, gaps: [missingClose] },
      {
        source: { ...sourceOrigin, evidenceId: "source-b" },
        gaps: [missingClose],
      },
    ];
    const versions = [analysis, analysis];
    const before = structuredClone({ versions, sources });
    expect(aggregateArtifactGaps(versions, sources)).toEqual([
      { kind: "artifact", artifact: analysisOrigin, gap: missingClose },
      {
        kind: "source",
        source: { ...sourceOrigin, selector: "" },
        gap: missingClose,
      },
      {
        kind: "source",
        source: { ...sourceOrigin, evidenceId: "source-b", selector: "" },
        gap: missingClose,
      },
    ]);
    expect({ versions, sources }).toEqual(before);
  });

  it("does not reassign gaps already carried through multiple digest levels", () => {
    const original: ReportedGap[] = [
      { kind: "artifact", artifact: analysisOrigin, gap: missingClose },
      {
        kind: "source",
        source: { ...sourceOrigin, selector: "" },
        gap: missingClose,
      },
    ];
    const first = digestGapVersion(
      { ...analysisOrigin, artifactId: "digest-one" },
      original,
    );
    const second = digestGapVersion(
      { ...analysisOrigin, artifactId: "digest-two" },
      structuredClone(original),
    );
    const before = structuredClone([first, second]);
    expect(aggregateArtifactGaps([first, second], [])).toEqual(original);
    expect([first, second]).toEqual(before);
  });
});
