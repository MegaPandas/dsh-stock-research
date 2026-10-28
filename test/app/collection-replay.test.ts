import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachCollection,
  registerCollectionSources,
} from "../../src/app/collection-input.js";
import type { ResearchArtifactInput } from "../../src/contracts/artifact-payloads.js";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import type {
  ArtifactRef,
  ResearchScope,
  SourceRef,
} from "../../src/contracts/data.js";
import type {
  OpenRunInput,
  RunState,
  TaskOperation,
} from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";

const cleanups: (() => void)[] = [];
const scope: ResearchScope = {
  security: {
    id: "CN:002594.SZ",
    market: "CN",
    symbol: "002594.SZ",
    exchange: "SZ",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2026-10-27",
  cutoff: "2026-10-27T10:00:00.000Z",
};
function collection(): CollectionSnapshot {
  return {
    schemaVersion: 1,
    scope,
    failures: [],
    packets: [
      {
        id: "financial.indicators",
        envelope: {
          dataset: "fundamentals",
          data: {
            table: "financial.indicators",
            title: "人工财务样本",
            columns: { revenue: { label: "营收", unit: "CNY" } },
            rows: [
              {
                date: "2026-06-30",
                asOf: "2026-06-30T15:59:59.999Z",
                availableAt: null,
                complete: true,
                values: { revenue: 100 },
              },
            ],
          },
          source: {
            provider: "eastmoney",
            url: "https://example.com/synthetic-financials",
            adapterVersion: "1",
            normalizationVersion: "1",
          },
          asOf: "2026-06-30T15:59:59.999Z",
          availableAt: null,
          retrievedAt: "2026-10-27T09:00:00.000Z",
          cutoff: scope.cutoff,
          ageMs:
            Date.parse(scope.cutoff) - Date.parse("2026-06-30T15:59:59.999Z"),
          stale: false,
          historicalKnowledge: "unverified",
          gaps: [],
        },
      },
    ],
  };
}
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-collection-replay-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const runs = new RunService(
    new RunStore<RunState>(root),
    () => "2026-10-27T10:01:00.000Z",
  );
  const artifacts = new ArtifactService(runs, new NumberService(runs));
  const input: OpenRunInput = attachCollection(
    {
      definition: {
        scope,
        mode: "deep",
        tasks: ["analysis.fundamentals", "analysis.business"].map(
          (id, index) => ({
            id,
            executor: {
              kind: "role",
              role: "analyst",
              specialty: id.slice("analysis.".length),
            },
            dependsOn: index === 0 ? [] : ["analysis.fundamentals"],
            inputTasks: index === 0 ? [] : ["analysis.fundamentals"],
            outputKinds: ["analysis"],
            dataRequirements: [],
            instructionVersion: 1,
          }),
        ),
      },
      versions: {
        plugin: "1",
        mode: "collection/1",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    collection(),
  );
  const sourceRun = runs.open("owner", input, "source").runId;
  function claim(taskId: string, runId = sourceRun): TaskOperation {
    return {
      ...runs.claim({ runId, identity: "owner" }, taskId, `claim:${taskId}`),
      identity: "stock-research:collection",
      sessionId: null,
    };
  }
  function replay() {
    return runs.open(
      "owner",
      { replay: { runId: sourceRun }, versions: input.versions },
      "replay",
    ).runId;
  }
  function analysis(
    source: SourceRef,
    copied?: { ref: ArtifactRef; source: SourceRef },
  ): ResearchArtifactInput {
    const observed = (id: string, ref: SourceRef) => ({
      id,
      kind: "observed" as const,
      value: 100,
      unit: "CNY",
      source: { ...ref, selector: "/data/rows/0/values/revenue" },
    });
    return {
      kind: "analysis",
      title: "人工固定输入",
      body: "本任务采用 {{number:own}}。",
      inputRefs: copied === undefined ? [] : [copied.ref],
      claims: [
        observed("own", source),
        ...(copied === undefined ? [] : [observed("copied", copied.source)]),
      ],
      payload: {
        findings: [
          {
            text: "保留本任务与上游固定数值引用。",
            evidence: [],
            numbers: [
              { kind: "local", claimId: "own" },
              ...(copied === undefined
                ? []
                : [
                    {
                      kind: "artifact" as const,
                      artifact: copied.ref,
                      claimId: "own",
                    },
                  ]),
            ],
          },
        ],
        risks: [],
        gaps: [],
      },
    };
  }
  return { runs, artifacts, input, sourceRun, claim, replay, analysis };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("deterministic collection replay identity", () => {
  it("selects the original task's collected evidence even when its artifact also cites the other analyst's same table", () => {
    const h = setup();
    const fundamentals = h.claim("analysis.fundamentals");
    const originalFundamental = registerCollectionSources(
      h.runs,
      fundamentals,
    )[0]!;
    const fundamentalRef = h.artifacts.submitArtifact(
      fundamentals,
      [h.analysis(originalFundamental.sourceRef)],
      "save-fundamentals",
    ).refs[0]!;
    const business = h.claim("analysis.business");
    const originalBusiness = registerCollectionSources(h.runs, business)[0]!;
    h.artifacts.submitArtifact(
      business,
      [
        h.analysis(originalBusiness.sourceRef, {
          ref: fundamentalRef,
          source: originalFundamental.sourceRef,
        }),
      ],
      "save-business",
    );
    expect(originalBusiness.sourceRef.evidenceId).not.toBe(
      originalFundamental.sourceRef.evidenceId,
    );

    const replayRun = h.replay();
    const replayFundamental = h.claim("analysis.fundamentals", replayRun);
    const replayedFundamental = registerCollectionSources(
      h.runs,
      replayFundamental,
    )[0]!;
    h.artifacts.submitArtifact(
      replayFundamental,
      [h.analysis(replayedFundamental.sourceRef)],
      "save-replayed-fundamentals",
    );
    const replayBusiness = h.claim("analysis.business", replayRun);
    expect(() =>
      h.runs.replayEvidence(
        replayBusiness,
        {
          dataset: "fundamentals",
          provider: "eastmoney",
          parameters: { table: "financial.indicators", collectionVersion: 1 },
        },
        "ambiguous-query-selection",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining("Multiple saved evidence"),
      }),
    );
    const replayedBusiness = registerCollectionSources(
      h.runs,
      replayBusiness,
    )[0]!;
    expect(
      h.runs.readEvidence(replayedBusiness.sourceRef).replayedFrom,
    ).toEqual(originalBusiness.sourceRef);

    const count = h.runs.numberContext(replayRun).evidence.length;
    const repeated = registerCollectionSources(h.runs, replayBusiness)[0]!;
    expect(repeated.sourceRef).toEqual(replayedBusiness.sourceRef);
    expect(h.runs.numberContext(replayRun).evidence).toHaveLength(count);
  });

  it("fails explicitly when the original task never registered its collection input", () => {
    const h = setup();
    h.claim("analysis.fundamentals");
    const replayRun = h.replay();
    const replayFundamental = h.claim("analysis.fundamentals", replayRun);
    expect(() =>
      registerCollectionSources(h.runs, replayFundamental),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining("financial.indicators"),
      }),
    );
    expect(h.runs.numberContext(replayRun).evidence).toHaveLength(0);
  });
});
