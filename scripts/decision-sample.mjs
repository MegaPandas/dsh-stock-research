import {
  ArtifactService,
  NumberService,
} from "@megapandas/dsh-stock-research/core";

// Three synthetic service inputs, never evidence of full quick-mode/vendor coverage.
export function openDecisionSample(runs, requestId) {
  const cutoff = "2024-01-03T22:00:00.000Z";
  const scope = {
    security: {
      id: "US:NVDA",
      market: "US",
      symbol: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      timeZone: "America/New_York",
    },
    date: "2024-01-03",
    cutoff,
  };
  const task = (id, executor, inputs, outputKinds) => ({
    id,
    executor,
    dependsOn: inputs,
    inputTasks: inputs,
    outputKinds,
    dataRequirements:
      id === "manager"
        ? [{ dataset: "market", fields: ["close"], requiredForDecision: true }]
        : [],
    instructionVersion: 1,
  });
  const { runId } = runs.open(
    "sample",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          task(
            "risk-summary",
            { kind: "service", service: "digest" },
            [],
            ["digest"],
          ),
          task(
            "manager",
            { kind: "role", role: "manager", specialty: "synthetic" },
            ["risk-summary"],
            ["decision_draft"],
          ),
          task(
            "final",
            { kind: "service", service: "finalize" },
            ["risk-summary", "manager"],
            ["decision", "report"],
          ),
        ],
      },
      versions: {
        plugin: "0.1.0-dev.1",
        mode: "synthetic",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    requestId,
  );
  const operation = { runId, identity: "sample" };
  const claim = (id) => ({
    ...runs.claim(operation, id, `claim-${id}`),
    identity: "sample-worker",
    sessionId: null,
  });
  const artifacts = new ArtifactService(runs, new NumberService(runs));
  const digestRef = artifacts.submitArtifact(
    claim("risk-summary"),
    [
      {
        kind: "digest",
        title: "Synthetic risk summary",
        body: "No fixture risks",
        inputRefs: [],
        claims: [],
        payload: {
          facts: [],
          disagreements: [],
          risks: [],
          gaps: [],
          upstreamRefs: [],
          numbers: [],
        },
      },
    ],
    "digest",
  ).refs[0];
  const manager = claim("manager");
  const source = {
    ...runs.recordEvidence(
      manager,
      {
        dataset: "market",
        provider: "synthetic",
        parameters: { maxAgeMs: 86_400_000 },
      },
      {
        envelope: {
          dataset: "market",
          data: {
            currency: "USD",
            adjustment: "split_adjusted",
            bars: [
              {
                date: scope.date,
                asOf: "2024-01-03T21:00:00.000Z",
                availableAt: "2024-01-03T21:00:00.000Z",
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
            provider: "synthetic",
            url: "https://example.com/decision-sample",
            adapterVersion: "1",
            normalizationVersion: "1",
          },
          asOf: "2024-01-03T21:00:00.000Z",
          availableAt: null,
          retrievedAt: "2024-01-03T21:30:00.000Z",
          cutoff,
          ageMs: 3_600_000,
          stale: false,
          historicalKnowledge: "verified",
          gaps: [],
        },
        candidates: [],
      },
      "data",
    ),
    selector: "/data/bars/0/close",
  };
  artifacts.submitArtifact(
    manager,
    [
      {
        kind: "decision_draft",
        title: "Synthetic manager view",
        body: "Base {{number:base}}, scenario {{number:target}}.",
        inputRefs: [digestRef],
        claims: [
          {
            id: "base",
            kind: "observed",
            value: 100,
            unit: "USD/share",
            source,
          },
          {
            id: "target",
            kind: "estimated",
            value: 120,
            unit: "USD/share",
            method: "Synthetic scenario",
            assumptions: ["Fixture only"],
            evidence: [source],
          },
        ],
        payload: {
          rating: "buy",
          horizonEndDate: "2025-01-03",
          thesis: [
            {
              text: "Fixed synthetic input",
              evidence: [],
              numbers: [{ kind: "local", claimId: "base" }],
            },
          ],
          basePrice: { kind: "local", claimId: "base" },
          targetPrice: { kind: "local", claimId: "target" },
          risks: [],
          riskResponses: [],
          invalidationConditions: ["Fixture assumptions change"],
          limitations: ["Synthetic sample only"],
        },
      },
    ],
    "draft",
  );
  return { operation, taskId: "final" };
}
