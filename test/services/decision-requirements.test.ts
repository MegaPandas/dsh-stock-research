import { afterEach, describe, expect, it } from "vitest";
import type {
  DataEnvelope,
  Dataset,
  Security,
} from "../../src/contracts/data.js";
import type { FundamentalsData } from "../../src/contracts/fundamentals.js";
import type { MacroData } from "../../src/contracts/macro.js";
import type {
  PriceReturnsData,
  QueryData,
  QueryEnvelope,
} from "../../src/contracts/query.js";
import type { ResearchData } from "../../src/contracts/research.js";
import type { SinaIncomeData } from "../../src/contracts/sina-income.js";
import type { TaskDefinition } from "../../src/contracts/workflow.js";
import { ArtifactInputs } from "../../src/services/artifact-inputs.js";
import { checkDecisionRequirements } from "../../src/services/decision-requirements.js";
import {
  decisionFixture,
  type DecisionFixtureOptions,
} from "../fixtures/decision.js";
import { CN_SECURITY } from "../fixtures/market.js";

type Fixture = ReturnType<typeof decisionFixture>;
const fixtures: Fixture[] = [];
function setup(options: DecisionFixtureOptions = {}): Fixture {
  const fixture = decisionFixture(options);
  fixtures.push(fixture);
  return fixture;
}
function currentInputs(fixture: Fixture, runId = fixture.operation.runId) {
  const state = fixture.store.read(runId);
  const inputs = new ArtifactInputs(fixture.runs);
  return {
    tasks: state.definition.tasks,
    versions: inputs.closure(state.tasks.flatMap((task) => task.outputRefs)),
    inputs,
    cutoff: state.scope.cutoff,
  };
}
function check(fixture: Fixture, tasks?: readonly TaskDefinition[]): void {
  const current = currentInputs(fixture);
  checkDecisionRequirements(
    tasks ?? current.tasks,
    current.versions,
    current.inputs,
    current.cutoff,
  );
}
const missingLatestClose: NonNullable<DecisionFixtureOptions["frame"]> = (
  frame,
) => {
  frame.envelope.data.bars[1]!.close = null;
  frame.envelope.gaps.push({
    code: "missing",
    field: "/data/bars/1/close",
    detail: "The latest artificial closing price is missing.",
  });
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe("decision required-data coverage", () => {
  it("accepts the latest adopted close without rerunning numeric validation", () => {
    const fixture = setup();
    const calls = fixture.numbers.calls;
    expect(() => check(fixture)).not.toThrow();
    expect(fixture.numbers.calls).toBe(calls);
  });

  it("does not use a valid older cited price to cover the packet's missing latest close", () => {
    const fixture = setup({
      observedIndex: 0,
      frame: missingLatestClose,
    });
    expect(() => check(fixture)).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining(
          "market.close: the latest adopted observation is missing",
        ),
      }),
    );
  });

  it("does not let a volume gap block a complete required close", () => {
    const fixture = setup({
      frame: (frame) => {
        frame.envelope.data.bars[1]!.volume = null;
        frame.envelope.gaps.push({
          code: "missing",
          field: "/data/bars/1/volume",
          detail: "The latest artificial volume is missing.",
        });
      },
    });
    expect(() => check(fixture)).not.toThrow();
  });

  it("does not block on a missing optional field", () => {
    const fixture = setup({
      required: false,
      observedIndex: 0,
      frame: missingLatestClose,
    });
    const tasks = currentInputs(fixture).tasks.map((task): TaskDefinition =>
      task.id === "analysis"
        ? {
            ...task,
            dataRequirements: [
              {
                dataset: "market",
                fields: ["close"],
                requiredForDecision: false,
              },
            ],
          }
        : task,
    );
    expect(() => check(fixture, tasks)).not.toThrow();
  });

  it("preserves an adopted analysis's explicit required-field gap", () => {
    const fixture = setup({
      analysisGaps: [
        {
          code: "unverified_time",
          field: "close",
          detail: "The analysis leaves close availability unresolved.",
        },
      ],
    });
    expect(() => check(fixture)).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining(
          "market.close: The analysis leaves close availability unresolved.",
        ),
      }),
    );
  });

  it("does not treat registered but unadopted evidence as coverage", () => {
    const fixture = setup();
    const sourceState = fixture.store.read(fixture.operation.runId);
    const { runId } = fixture.runs.open(
      "owner",
      {
        definition: {
          scope: fixture.scope,
          mode: "quick",
          tasks: [
            {
              id: "analysis",
              executor: {
                kind: "role",
                role: "analyst",
                specialty: "fixture",
              },
              dependsOn: [],
              inputTasks: [],
              outputKinds: ["analysis"],
              dataRequirements: [
                {
                  dataset: "market",
                  fields: ["close"],
                  requiredForDecision: true,
                },
              ],
              instructionVersion: 1,
            },
          ],
        },
        versions: sourceState.versions,
        inputs: [],
      },
      "unadopted-run",
    );
    const operation = {
      ...fixture.runs.claim({ runId, identity: "owner" }, "analysis", "claim"),
      identity: "worker",
      sessionId: null,
    };
    fixture.runs.recordEvidence(
      operation,
      { dataset: "market", provider: "fixture", parameters: {} },
      fixture.frame,
      "registered-only",
    );
    fixture.artifacts.submitArtifact(
      operation,
      [
        {
          kind: "analysis",
          title: "Unadopted packet",
          body: "No source was adopted by this analysis.",
          inputRefs: [],
          claims: [],
          payload: {
            findings: [
              {
                text: "Coverage remains unsupported.",
                evidence: [],
                numbers: [],
              },
            ],
            risks: [],
            gaps: [],
          },
        },
      ],
      "submit",
    );
    expect(fixture.store.read(runId).evidence).toHaveLength(1);
    const current = currentInputs(fixture, runId);
    expect(() =>
      checkDecisionRequirements(
        current.tasks,
        current.versions,
        current.inputs,
        current.cutoff,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining(
          "market.close: no adopted observation",
        ),
      }),
    );
  });
});

function mappingEnvelope<T extends QueryData>(
  dataset: Dataset,
  data: T,
  asOf: string,
): DataEnvelope<T> {
  const cutoff = "2024-01-03T22:00:00.000Z";
  return {
    dataset,
    data,
    source: {
      provider: "artificial-coverage",
      url: "https://example.com/required-field-fixture",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf,
    availableAt: null,
    retrievedAt: "2024-01-03T21:30:00.000Z",
    cutoff,
    ageMs: Date.parse(cutoff) - Date.parse(asOf),
    stale: false,
    historicalKnowledge: "verified",
    gaps: [],
  };
}
interface MappingSample {
  name: string;
  field: string;
  selector: string;
  envelope: QueryEnvelope;
  number?: { value: number; unit: string };
  security?: Security;
  failure?: string;
}
const mappingSamples: MappingSample[] = [
  {
    name: "SEC revenue",
    field: "revenue",
    selector: "/data/observations/0/value",
    envelope: mappingEnvelope<FundamentalsData>(
      "fundamentals",
      {
        field: "revenue",
        currency: "USD",
        concept: { taxonomy: "us-gaap", tag: "Revenues" },
        observations: [
          {
            periodStart: "2023-01-01",
            periodEnd: "2023-12-31",
            value: 120,
            filed: "2024-01-02",
            accession: "0000000000-24-000001",
            form: "10-K",
            filingUrl: "https://example.com/artificial-filing",
            availableAt: "2024-01-02T12:00:00.000Z",
          },
        ],
      },
      "2023-12-31T23:59:59.999Z",
    ),
    number: { value: 120, unit: "USD" },
  },
  {
    name: "Sina revenue",
    field: "revenue",
    selector: "/data/observations/0/values/revenue",
    security: CN_SECURITY,
    envelope: mappingEnvelope<SinaIncomeData>(
      "fundamentals",
      {
        currency: "CNY",
        basis: "year_to_date",
        consolidation: "consolidated",
        fields: ["revenue"],
        observations: [
          {
            periodStart: "2023-01-01",
            periodEnd: "2023-12-31",
            publishDate: "2024-01-02",
            sourceUpdatedAt: "2024-01-02T08:00:00.000Z",
            values: { revenue: 80 },
            availableAt: null,
          },
        ],
      },
      "2023-12-31T15:59:59.999Z",
    ),
    number: { value: 80, unit: "CNY" },
  },
  {
    name: "FRED DGS10",
    field: "DGS10",
    selector: "/data/observations/0/value",
    envelope: mappingEnvelope<MacroData>(
      "macro",
      {
        seriesId: "DGS10",
        unit: "percent",
        frequency: "daily",
        seasonalAdjustment: "not_seasonally_adjusted",
        view: "current",
        observations: [{ date: "2024-01-03", value: 4.05, availableAt: null }],
      },
      "2024-01-03T00:00:00.000Z",
    ),
    number: { value: 4.05, unit: "percent" },
  },
  {
    name: "price return value",
    field: "value",
    selector: "/data/value",
    envelope: mappingEnvelope<PriceReturnsData>(
      "returns",
      {
        market: {
          currency: "USD",
          adjustment: "split_adjusted",
          bars: [80, 100].map((close, index) => ({
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
        algorithmVersion: "1",
        requestedStartDate: "2024-01-02",
        requestedEndDate: "2024-01-03",
        start: {
          date: "2024-01-02",
          price: 80,
          currency: "USD",
          adjustment: "split_adjusted",
          asOf: "2024-01-02T21:00:00.000Z",
          availableAt: "2024-01-02T21:00:00.000Z",
        },
        end: {
          date: "2024-01-03",
          price: 100,
          currency: "USD",
          adjustment: "split_adjusted",
          asOf: "2024-01-03T21:00:00.000Z",
          availableAt: "2024-01-03T21:00:00.000Z",
        },
        comparable: true,
        value: 0.25,
        unit: "ratio",
      },
      "2024-01-03T21:00:00.000Z",
    ),
    number: { value: 0.25, unit: "ratio" },
  },
  {
    name: "research items with a missing location",
    field: "items",
    selector: "/data/items",
    envelope: {
      ...mappingEnvelope<ResearchData>(
        "research",
        {
          query: "Artificial research",
          items: [
            {
              url: "https://example.com/artificial-research",
              title: "Artificial source",
              snippet: "Frozen research content for this coverage test.",
              providerTimestamp: null,
              publishedAt: null,
              availableAt: null,
              location: null,
            },
          ],
          truncated: false,
          view: "current_search",
        },
        "2024-01-03T21:30:00.000Z",
      ),
      gaps: [
        {
          code: "missing",
          field: "/data/items/0/location",
          detail: "The artificial source has no document location.",
        },
      ],
    },
    failure:
      "research.items: /data/items/0/location: The artificial source has no document location.",
  },
  {
    name: "empty research items",
    field: "items",
    selector: "/data/items",
    envelope: mappingEnvelope<ResearchData>(
      "research",
      {
        query: "Artificial empty research",
        items: [],
        truncated: false,
        view: "current_search",
      },
      "2024-01-03T21:30:00.000Z",
    ),
    failure: "research.items: the latest adopted observation is missing",
  },
];

describe("required non-market field names", () => {
  it.each(mappingSamples)("maps $name to adopted source data", (sample) => {
    const fixture = setup({ required: false });
    const sourceState = fixture.store.read(fixture.operation.runId);
    const task: TaskDefinition = {
      ...sourceState.definition.tasks.find((task) => task.id === "analysis")!,
      dataRequirements: [
        {
          dataset: sample.envelope.dataset,
          fields: [sample.field],
          requiredForDecision: true,
        },
      ],
    };
    const { runId } = fixture.runs.open(
      "owner",
      {
        definition: {
          scope: {
            ...fixture.scope,
            security: sample.security ?? fixture.scope.security,
          },
          mode: "quick",
          tasks: [task],
        },
        versions: sourceState.versions,
        inputs: [],
      },
      "mapping-run",
    );
    const operation = {
      ...fixture.runs.claim({ runId, identity: "owner" }, "analysis", "claim"),
      identity: "worker",
      sessionId: null,
    };
    const source = {
      ...fixture.runs.recordEvidence(
        operation,
        {
          dataset: sample.envelope.dataset,
          provider: "artificial-coverage",
          parameters: {},
        },
        { envelope: sample.envelope, candidates: [] },
        "mapping-data",
      ),
      selector: sample.selector,
    };
    fixture.artifacts.submitArtifact(
      operation,
      [
        {
          kind: "analysis",
          title: "Artificial field mapping",
          body:
            sample.number === undefined
              ? "Adopted research packet."
              : "Observed {{number:required}}.",
          inputRefs: [],
          claims:
            sample.number === undefined
              ? []
              : [
                  {
                    id: "required",
                    kind: "observed",
                    value: sample.number.value,
                    unit: sample.number.unit,
                    source,
                  },
                ],
          payload: {
            findings: [
              {
                text: "Artificial data adopted for the required field.",
                evidence: sample.number === undefined ? [source] : [],
                numbers:
                  sample.number === undefined
                    ? []
                    : [{ kind: "local", claimId: "required" }],
              },
            ],
            risks: [],
            gaps: [],
          },
        },
      ],
      "mapping-submit",
    );
    const current = currentInputs(fixture, runId);
    const run = () =>
      checkDecisionRequirements(
        current.tasks,
        current.versions,
        current.inputs,
        current.cutoff,
      );
    if (sample.failure === undefined) expect(run).not.toThrow();
    else
      expect(run).toThrowError(
        expect.objectContaining({
          code: "DATA_INSUFFICIENT",
          message: expect.stringContaining(sample.failure),
        }),
      );
  });
});
