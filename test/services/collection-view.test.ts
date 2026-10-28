import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectionReadTool } from "../../src/app/collection-tools.js";
import type { ResearchArtifactInput } from "../../src/contracts/artifact-payloads.js";
import type { CollectedTableData } from "../../src/contracts/collection.js";
import type {
  CandidateClaim,
  DataEnvelope,
  DataGap,
  SourceRef,
} from "../../src/contracts/data.js";
import type { RunState } from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { collectionSummary } from "../../src/services/collection-view.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { CN_SECURITY } from "../fixtures/market.js";

const cleanups: (() => void)[] = [];
const fetch = vi.fn<typeof globalThis.fetch>();
const scope = {
  security: CN_SECURITY,
  date: "2024-01-03",
  cutoff: "2024-01-03T15:59:59.999Z",
};
const globalGap: DataGap = {
  code: "unverified_time",
  field: "/data/rows",
  detail: "The synthetic source does not establish historical revisions.",
};
const staleGap: DataGap = {
  code: "stale",
  field: "/data/rows",
  detail: "Synthetic freshness limitation.",
};
const selectedGap: DataGap = {
  code: "unverified_time",
  field: "/data/rows/1/availableAt",
  detail: "The selected row has no precise publication time.",
};

function envelope(): DataEnvelope<CollectedTableData> {
  return {
    dataset: "market",
    data: {
      table: "market.daily",
      title: "Synthetic fixed daily observations",
      currency: "CNY",
      adjustment: "unadjusted",
      interval: "1d",
      columns: {
        close: { label: "Close", unit: "CNY/share", price: true },
        volume: { label: "Volume", unit: "shares" },
      },
      rows: [10, 20, 30].map((close, index) => ({
        date: `2024-01-0${index + 1}`,
        asOf: `2024-01-0${index + 1}T07:30:00.000Z`,
        availableAt: null,
        complete: true,
        values: { close, volume: index === 1 ? null : 1000 },
      })),
    },
    source: {
      provider: "fixture",
      url: "https://example.invalid/collected-daily",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: "2024-01-03T07:30:00.000Z",
    availableAt: null,
    retrievedAt: "2024-01-03T07:31:00.000Z",
    cutoff: scope.cutoff,
    ageMs: Date.parse(scope.cutoff) - Date.parse("2024-01-03T07:30:00.000Z"),
    stale: true,
    historicalKnowledge: "unverified",
    gaps: [
      globalGap,
      staleGap,
      {
        code: "incomparable",
        field: "/data/rows/0/values/volume",
        detail: "An unrelated earlier volume observation is not comparable.",
      },
      {
        code: "missing",
        field: "/data/rows/1/values/volume",
        detail: "The selected row has no volume.",
      },
      selectedGap,
    ],
  };
}
function reader(saved = envelope(), sourceRef?: SourceRef) {
  const tool = collectionReadTool([
    { id: "market.daily", envelope: saved, ...(sourceRef && { sourceRef }) },
  ]);
  const call = (args: unknown, signal = new AbortController().signal) =>
    tool.execute(args, { signal } as ToolRunContext);
  return { tool, call };
}
const rowRequest = {
  kind: "rows",
  table: "market.daily",
  fields: ["close"],
  offset: 0,
  limit: 1,
};
beforeEach(() => {
  fetch.mockReset().mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

describe("collected table views", () => {
  it("projects a discoverable directory without embedding values, field definitions or detailed gaps", () => {
    const saved = envelope();
    const before = structuredClone(saved);
    expect(collectionSummary("market.daily", saved)).toEqual({
      id: "market.daily",
      dataset: "market",
      title: "Synthetic fixed daily observations",
      recordCount: 3,
      range: { from: "2024-01-01", to: "2024-01-03" },
      interval: "1d",
      quality: {
        stale: true,
        historicalKnowledge: "unverified",
        missingValues: 1,
      },
    });
    expect(saved).toEqual(before);
  });

  it("returns field definitions and price basis without historical rows or numeric candidates", async () => {
    const saved = envelope();
    const result = await reader(saved).call({
      kind: "schema",
      table: "market.daily",
    });
    expect(result).toMatchObject({
      kind: "schema",
      data: {
        table: "market.daily",
        columns: saved.data.columns,
        currency: "CNY",
        adjustment: "unadjusted",
        interval: "1d",
      },
      source: saved.source,
      recordCount: 3,
      range: { from: "2024-01-01", to: "2024-01-03" },
      quality: {
        stale: true,
        historicalKnowledge: "unverified",
        missingValues: 1,
      },
      gaps: [globalGap, staleGap],
    });
    expect((result as { data: object }).data).not.toHaveProperty("rows");
    expect(result).not.toHaveProperty("candidateClaims");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("filters by inclusive dates before paging and keeps original row indices and only selected fields", async () => {
    const saved = envelope();
    const before = structuredClone(saved);
    const result = await reader(saved).call({
      ...rowRequest,
      dateFrom: "2024-01-02",
      dateTo: "2024-01-03",
      offset: 1,
    });
    expect(result).toMatchObject({
      totalRows: 2,
      data: {
        columns: { close: saved.data.columns.close },
        rows: [{ index: 2, date: "2024-01-03", values: { close: 30 } }],
      },
      gaps: [globalGap, staleGap],
    });
    const data = (result as { data: CollectedTableData }).data;
    expect(data.rows).toHaveLength(1);
    expect(data.columns).not.toHaveProperty("volume");
    expect(data.rows[0]!.values).not.toHaveProperty("volume");
    expect(saved).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps table and selected-row time limitations while excluding gaps in unselected fields and rows", async () => {
    const result = await reader().call({ ...rowRequest, offset: 1 });
    expect(result).toMatchObject({
      data: { rows: [{ index: 1, values: { close: 20 } }] },
      gaps: [globalGap, staleGap, selectedGap],
      stale: true,
      historicalKnowledge: "unverified",
    });
  });

  it("preserves an explicitly missing selected value and its relevant gap without inventing a candidate", async () => {
    const result = await reader(envelope(), {
      runId: "run",
      evidenceId: "evidence",
      selector: "/data",
    }).call({ ...rowRequest, fields: ["volume"], offset: 1 });
    expect(result).toMatchObject({
      data: { rows: [{ index: 1, values: { volume: null } }] },
      candidateClaims: [],
      gaps: [
        globalGap,
        staleGap,
        expect.objectContaining({ field: "/data/rows/1/values/volume" }),
        selectedGap,
      ],
    });
  });

  it("returns an empty bounded page when the selected date range has no observations", async () => {
    const result = await reader().call({
      ...rowRequest,
      dateFrom: "2024-02-01",
    });
    expect(result).toMatchObject({
      totalRows: 0,
      data: { rows: [] },
      gaps: [globalGap, staleGap],
    });
  });

  it.each([
    { ...rowRequest, fields: [] },
    { ...rowRequest, fields: ["close", "close"] },
    { ...rowRequest, fields: ["unknown"] },
    { ...rowRequest, fields: "close" },
    { ...rowRequest, offset: -1 },
    { ...rowRequest, offset: 0.5 },
    { ...rowRequest, limit: 0 },
    { ...rowRequest, limit: 101 },
    { ...rowRequest, dateFrom: "2024-02-30" },
    { ...rowRequest, dateFrom: "2024-01-03", dateTo: "2024-01-02" },
    { ...rowRequest, cutoff: scope.cutoff },
    { kind: "schema", table: "market.daily", fields: ["close"] },
    { kind: "unexpected", table: "market.daily" },
    { table: "market.daily", fields: ["close"], offset: 0, limit: 1 },
  ])(
    "rejects invalid public read arguments without calling a data source: %j",
    async (args) => {
      await expect(reader().call(args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports unavailable tables and respects cancellation", async () => {
    await expect(
      reader().call({ kind: "schema", table: "financial.income" }),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    const controller = new AbortController();
    controller.abort(new Error("Stop local read"));
    await expect(reader().call(rowRequest, controller.signal)).rejects.toThrow(
      "Stop local read",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns historical numeric references that survive paging, pass real number checks and replay offline", async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "dsh-collection-view-"));
    const root = new DataRoot(directory);
    cleanups.push(() => {
      root.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const runs = new RunService(
      new RunStore<RunState>(root),
      () => "2024-01-04T00:00:00.000Z",
    );
    const input = {
      definition: {
        scope,
        mode: "quick" as const,
        tasks: [
          {
            id: "analysis.market",
            executor: {
              kind: "role" as const,
              role: "analyst" as const,
              specialty: "market",
            },
            dependsOn: [],
            inputTasks: [],
            outputKinds: ["analysis" as const],
            dataRequirements: [],
            instructionVersion: 1,
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
    };
    const { runId } = runs.open("owner", input, "open");
    const operation = {
      ...runs.claim({ runId, identity: "owner" }, "analysis.market", "claim"),
      identity: "worker",
      sessionId: null,
    };
    const query = {
      dataset: "market" as const,
      provider: "fixture",
      parameters: { table: "market.daily", collectionVersion: 1 },
    };
    const ref = runs.recordEvidence(
      operation,
      query,
      { envelope: envelope(), candidates: [] },
      "collection",
    );
    const original = runs.readEvidence<CollectedTableData>(ref);
    const request = {
      ...rowRequest,
      dateFrom: "2024-01-02",
      dateTo: "2024-01-02",
    };
    const result = (await reader(original.envelope, ref).call(request)) as {
      candidateClaims: CandidateClaim[];
    };
    expect(result.candidateClaims).toHaveLength(1);
    const claim = result.candidateClaims[0]!;
    expect(claim).toMatchObject({
      value: 20,
      unit: "CNY/share",
      source: { ...ref, selector: "/data/rows/1/values/close" },
    });
    const content: ResearchArtifactInput = {
      kind: "analysis",
      title: "Bounded fixed input",
      body: "Close {{number:close}}.",
      inputRefs: [],
      claims: [
        {
          id: "close",
          kind: "observed",
          value: claim.value,
          unit: claim.unit,
          source: claim.source,
        },
      ],
      payload: {
        findings: [
          {
            text: "The selected observation is fixed.",
            evidence: [],
            numbers: [{ kind: "local", claimId: "close" }],
          },
        ],
        risks: [],
        gaps: [],
      },
    };
    expect(
      new NumberService(runs).checkNumbers(
        { runId, identity: "worker" },
        { kind: "pending", contentId: "bounded", content },
      ),
    ).toMatchObject({ passed: true });
    expect(runs.readEvidence(ref)).toEqual(original);

    const replay = runs.open(
      "owner",
      { replay: { runId }, versions: input.versions },
      "replay",
    );
    const replayOperation = {
      ...runs.claim(
        { runId: replay.runId, identity: "owner" },
        "analysis.market",
        "replay-claim",
      ),
      identity: "worker",
      sessionId: null,
    };
    const replayRef = runs.replayEvidence(
      replayOperation,
      query,
      "replay-input",
    );
    const replayed = runs.readEvidence<CollectedTableData>(replayRef);
    const replayResult = (await reader(replayed.envelope, replayRef).call(
      request,
    )) as { candidateClaims: CandidateClaim[] };
    expect(replayed.replayedFrom).toEqual(ref);
    expect(replayResult.candidateClaims[0]).toMatchObject({
      value: 20,
      source: { ...replayRef, selector: "/data/rows/1/values/close" },
    });
    expect(runs.readEvidence(ref)).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });
});
