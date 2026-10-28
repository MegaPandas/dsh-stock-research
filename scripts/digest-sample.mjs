import {
  ArtifactService,
  NumberService,
} from "@megapandas/dsh-stock-research/core";

export function sampleDigestReply(context) {
  const candidate = context.numbers[0].candidateId;
  return {
    title: "Synthetic digest",
    body: `Snapshot {{number:${candidate}}}.`,
    inputRefs: context.artifacts.map((version) => version.ref),
    facts: [
      {
        text: `Known price {{number:${candidate}}}.`,
        inputRefs: [context.artifacts[0].ref],
        numbers: [candidate],
      },
    ],
    disagreements: [],
    riskSummaries: context.risks.map((risk) => ({
      issueId: risk.issueId,
      text: "Synthetic risk summary",
    })),
  };
}
// Fixed synthetic inputs measure service composition, not a live model or source.
export function openDigestSample(runs, requestId, claims) {
  const cutoff = "2024-01-03T22:00:00.000Z";
  const definition = {
    scope: {
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
    },
    mode: "quick",
    tasks: [
      {
        id: "analysis",
        executor: { kind: "role", role: "analyst", specialty: "synthetic" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      },
      {
        id: "digest",
        executor: { kind: "service", service: "digest" },
        dependsOn: ["analysis"],
        inputTasks: ["analysis"],
        outputKinds: ["digest"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ],
  };
  const { runId } = runs.open(
    "digest-sample",
    {
      definition,
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
  const operation = { runId, identity: "digest-sample" };
  const producer = {
    ...runs.claim(operation, "analysis", "claim"),
    identity: "sample-worker",
    sessionId: null,
  };
  const source = {
    ...runs.recordEvidence(
      producer,
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
                date: definition.scope.date,
                asOf: "2024-01-03T21:00:00.000Z",
                availableAt: "2024-01-03T21:00:00.000Z",
                sessionComplete: true,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: null,
              },
            ],
          },
          source: {
            provider: "synthetic",
            url: "https://example.com/digest-fixture",
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
          gaps: [
            {
              code: "missing",
              field: "/data/bars/0/volume",
              detail: "Synthetic optional volume gap",
            },
          ],
        },
        candidates: [],
      },
      "data",
    ),
    selector: "/data/bars/0/close",
  };
  new ArtifactService(runs, new NumberService(runs)).submitArtifact(
    producer,
    [
      {
        kind: "analysis",
        title: "Synthetic market analysis",
        body: "Price {{number:price-0}}.",
        inputRefs: [],
        claims: Array.from({ length: claims }, (_, index) => ({
          id: `price-${index}`,
          kind: "observed",
          value: 100,
          unit: "USD/share",
          source,
        })),
        payload: {
          findings: [
            {
              text: "Synthetic observation",
              evidence: [],
              numbers: [{ kind: "local", claimId: "price-0" }],
            },
          ],
          risks: [],
          gaps: [],
        },
      },
    ],
    "analysis",
  );
  return { operation, taskId: "digest" };
}
