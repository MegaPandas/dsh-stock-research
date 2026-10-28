import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Rating,
  ResearchArtifactInput,
  RiskIssue,
} from "../../src/contracts/artifact-payloads.js";
import type { DataGap, MarketData } from "../../src/contracts/data.js";
import type { RunOperation, RunState } from "../../src/contracts/runs.js";
import type { NumberTarget } from "../../src/contracts/numbers.js";
import type { EvidenceInput } from "../../src/contracts/task-data.js";
import type { TaskDefinition } from "../../src/contracts/workflow.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "./market.js";

class CountedNumbers extends NumberService {
  calls = 0;
  override checkNumbers(operation: RunOperation, target: NumberTarget) {
    this.calls++;
    return super.checkNumbers(operation, target);
  }
}
export interface DecisionFixtureOptions {
  additionalTasks?: TaskDefinition[];
  required?: boolean;
  rating?: Rating;
  deferDraft?: boolean;
  unvalidatedDraft?: boolean;
  frame?: (frame: EvidenceInput<MarketData>) => void;
  observedIndex?: number;
  analysisGaps?: DataGap[];
  draft?: (
    content: Extract<ResearchArtifactInput, { kind: "decision_draft" }>,
  ) => void;
}
export function decisionFixture(options: DecisionFixtureOptions = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-decisions-"));
  const root = new DataRoot(directory);
  const store = new RunStore<RunState>(root);
  const clock = { value: "2024-01-04T00:00:00.000Z", calls: 0 };
  const runs = new RunService(store, () => clock.value);
  const numbers = new CountedNumbers(runs);
  const artifacts = new ArtifactService(runs, numbers);
  const scope = {
    security: US_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-03T22:00:00.000Z",
  };
  const task = (
    id: string,
    executor: TaskDefinition["executor"],
    inputTasks: string[],
    outputKinds: TaskDefinition["outputKinds"],
  ): TaskDefinition => ({
    id,
    executor,
    dependsOn: inputTasks,
    inputTasks,
    outputKinds,
    dataRequirements:
      id === "analysis" && options.required !== false
        ? [{ dataset: "market", fields: ["close"], requiredForDecision: true }]
        : [],
    instructionVersion: 1,
  });
  const { runId } = runs.open(
    "owner",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          task(
            "analysis",
            { kind: "role", role: "analyst", specialty: "fixture" },
            [],
            ["analysis"],
          ),
          task(
            "risk",
            { kind: "role", role: "discussion", specialty: "fixture" },
            ["analysis"],
            ["risk"],
          ),
          task(
            "digest",
            { kind: "service", service: "digest" },
            ["analysis", "risk"],
            ["digest"],
          ),
          task(
            "manager",
            { kind: "role", role: "manager", specialty: "fixture" },
            ["digest"],
            ["decision_draft"],
          ),
          task(
            "final",
            { kind: "service", service: "finalize" },
            ["digest", "manager"],
            ["decision", "report"],
          ),
          ...(options.additionalTasks ?? []),
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
  const claim = (taskId: string) => ({
    ...runs.claim(operation, taskId, `claim-${taskId}`),
    identity: "worker",
    sessionId: null,
  });
  try {
    const analysisOp = claim("analysis");
    // Artificial observations and availability, never a vendor coverage claim.
    const frame: EvidenceInput<MarketData> = {
      envelope: {
        dataset: "market",
        data: {
          currency: "USD",
          adjustment: "split_adjusted",
          bars: [90, 100].map((close, index) => ({
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
          url: "https://example.com/decision-fixture",
          adapterVersion: "1",
          normalizationVersion: "1",
        },
        asOf: "2024-01-03T21:00:00.000Z",
        availableAt: null,
        retrievedAt: "2024-01-03T21:30:00.000Z",
        cutoff: scope.cutoff,
        ageMs: 3_600_000,
        stale: false,
        historicalKnowledge: "verified",
        gaps: [],
      },
      candidates: [],
    };
    options.frame?.(frame);
    const index = options.observedIndex ?? 1;
    const source = {
      ...runs.recordEvidence(
        analysisOp,
        {
          dataset: "market",
          provider: "fixture",
          parameters: { maxAgeMs: 86_400_000 },
        },
        frame,
        "data",
      ),
      selector: `/data/bars/${index}/close`,
    };
    const analysis: ResearchArtifactInput = {
      kind: "analysis",
      title: "Market analysis",
      body: "Base {{number:base}}.",
      inputRefs: [],
      claims: [
        {
          id: "base",
          kind: "observed",
          value: frame.envelope.data.bars[index]!.close!,
          unit: "USD/share",
          source,
        },
      ],
      payload: {
        findings: [
          {
            text: "Observed price",
            evidence: [],
            numbers: [{ kind: "local", claimId: "base" }],
          },
        ],
        risks: [],
        gaps: options.analysisGaps ?? [],
      },
    };
    const analysisRef = artifacts.submitArtifact(
      analysisOp,
      [analysis],
      "analysis",
    ).refs[0]!;
    const riskOp = claim("risk");
    const issue: RiskIssue = {
      issueId: "liquidity",
      description: "Liquidity uncertainty",
      impact: "Execution impact",
      trigger: "Volume declines",
      constraint: "Position restraint",
      recommendation: "Monitor liquidity",
      evidence: [],
      numbers: [],
    };
    const risk: ResearchArtifactInput = {
      kind: "risk",
      title: "Risk assessment",
      body: "Liquidity risk",
      inputRefs: [analysisRef],
      claims: [],
      payload: { issues: [issue] },
    };
    const riskRef = artifacts.submitArtifact(riskOp, [risk], "risk").refs[0]!;
    const digestOp = claim("digest");
    const digest: ResearchArtifactInput = {
      kind: "digest",
      title: "Risk digest",
      body: "Risk summary",
      inputRefs: [analysisRef, riskRef],
      claims: [],
      payload: {
        facts: [
          {
            text: "Observed price",
            evidence: [],
            numbers: [
              { kind: "artifact", artifact: analysisRef, claimId: "base" },
            ],
          },
        ],
        disagreements: [],
        risks: [issue],
        gaps: [],
        upstreamRefs: [analysisRef, riskRef],
        numbers: [{ kind: "artifact", artifact: analysisRef, claimId: "base" }],
      },
    };
    const digestRef = artifacts.submitArtifact(digestOp, [digest], "digest")
      .refs[0]!;
    const managerOp = claim("manager");
    const draft: Extract<ResearchArtifactInput, { kind: "decision_draft" }> = {
      kind: "decision_draft",
      title: "Manager decision",
      body: "Scenario target {{number:target}}.",
      inputRefs: [digestRef, analysisRef],
      claims: [
        {
          id: "target",
          kind: "estimated",
          value: 120,
          unit: "USD/share",
          method: "Synthetic scenario",
          assumptions: ["Fixture assumptions hold"],
          evidence: [source],
        },
      ],
      payload: {
        rating: options.rating ?? "buy",
        horizonEndDate: "2025-01-03",
        thesis: [
          {
            text: "Scenario supported by the fixed observation",
            evidence: [],
            numbers: [
              { kind: "artifact", artifact: analysisRef, claimId: "base" },
            ],
          },
        ],
        basePrice: { kind: "artifact", artifact: analysisRef, claimId: "base" },
        targetPrice: { kind: "local", claimId: "target" },
        risks: ["Liquidity"],
        riskResponses: [
          {
            issueId: issue.issueId,
            disposition: "accepted",
            reason: "Included in the research view",
          },
        ],
        invalidationConditions: ["Underlying assumptions change"],
        limitations: ["Synthetic fixture only"],
      },
    };
    options.draft?.(draft);
    const draftRef = (
      options.deferDraft
        ? { refs: [] }
        : options.unvalidatedDraft
          ? runs.commitArtifact(managerOp, [draft], "draft")
          : artifacts.submitArtifact(managerOp, [draft], "draft")
    ).refs[0]!;
    return {
      directory,
      root,
      store,
      runs,
      numbers,
      artifacts,
      operation,
      scope,
      source,
      frame,
      analysisRef,
      riskRef,
      digestRef,
      draftRef,
      draft,
      managerOp,
      clock,
      now: () => {
        clock.calls++;
        return clock.value;
      },
      close: () => {
        try {
          root.close();
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (cause) {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    throw cause;
  }
}
