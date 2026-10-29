import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectionDataTools } from "../../src/app/collection-tools.js";
import type { CollectionReadSource } from "../../src/contracts/collection.js";

const fetch = vi.fn<typeof globalThis.fetch>();
const historicalLimitation = {
  code: "unverified_time" as const,
  detail: "The source does not establish historical revisions.",
};

function source(): CollectionReadSource {
  return {
    id: "financial.indicators",
    sourceRef: {
      runId: "fbf5e306-5dc5-465d-bd40-2132ce8e481b",
      evidenceId: "3fffc414-6548-485f-825b-1de98787970b",
      selector: "/data",
    },
    envelope: {
      dataset: "fundamentals",
      source: {
        provider: "fixture",
        url: "https://example.invalid/data-source",
        adapterVersion: "fixture-adapter-1",
        normalizationVersion: "fixture-normalization-1",
      },
      asOf: "2024-01-03T07:00:00.000Z",
      availableAt: null,
      retrievedAt: "2024-01-03T07:01:00.000Z",
      cutoff: "2024-01-03T08:00:00.000Z",
      ageMs: 3_600_000,
      stale: true,
      historicalKnowledge: "unverified",
      gaps: [
        { ...historicalLimitation, field: "/data/rows" },
        { ...historicalLimitation, field: "/availableAt" },
        {
          code: "missing",
          field: "/data/rows/1/values/profit",
          detail: "Profit is absent for 2024-01-02.",
        },
        {
          code: "incomparable",
          field: "/data/rows/0/values/revenue",
          detail: "The first revenue observation is not comparable.",
        },
        {
          code: "unverified_time",
          field: "/data/rows/1/availableAt",
          detail: "The second row has no precise publication time.",
        },
      ],
      data: {
        table: "financial.indicators",
        title: "财务指标",
        currency: "CNY",
        basis: "year_to_date",
        attributes: {
          name: "示例公司",
          quoteDirection: "CNY/USD",
          sourceUrl: "https://example.invalid/attribute-source",
        },
        columns: {
          profit: { label: "归母净利润", unit: "CNY" },
          revenue: { label: "营业收入", unit: "CNY" },
        },
        rows: [123456789.012345, null, 34.56].map((profit, index) => ({
          date: `2024-01-0${index + 1}`,
          periodStart: "2024-01-01",
          publishedDate: index === 1 ? null : `2024-01-0${index + 2}`,
          filing: {
            accession: "internal-filing-id",
            form: "10-Q",
            url: "https://example.invalid/filing",
          },
          asOf: `2024-01-0${index + 1}T07:00:00.000Z`,
          availableAt: null,
          complete: true,
          values: { profit, revenue: 20 + index },
        })),
      },
    },
  };
}

function reader(saved = source()) {
  const [describeTool, tool] = collectionDataTools([saved]);
  const call = (args: unknown, signal = new AbortController().signal) =>
    tool!.execute(args, { signal } as ToolRunContext);
  const describe = (args: unknown, signal = new AbortController().signal) =>
    describeTool!.execute(args, { signal } as ToolRunContext);
  return { tool: tool!, describeTool: describeTool!, call, describe };
}

const request = {
  table: "financial.indicators",
  fields: ["profit"],
  offset: 0,
  limit: 1,
  dateFrom: null,
  dateTo: null,
};

beforeEach(() => {
  fetch.mockReset().mockRejectedValue(new Error("Unexpected source request"));
  vi.stubGlobal("fetch", fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("analysis collection business views", () => {
  it("describes numeric columns and automatically supplied row fields without provenance", async () => {
    const { describeTool, describe } = reader();
    const args = { table: "financial.indicators" };
    expect(validateJsonSchemaValue(describeTool.parameters, args)).toEqual([]);
    const result = await describe(args);
    expect(result).toMatchObject({
      kind: "schema",
      provider: "fixture",
      stale: true,
      historicalKnowledge: "unverified",
      recordCount: 3,
      range: { from: "2024-01-01", to: "2024-01-03" },
      data: {
        currency: "CNY",
        basis: "year_to_date",
        columns: { profit: { label: "归母净利润", unit: "CNY" } },
        rowFields: {
          date: { type: "date" },
          periodStart: { type: "date" },
          publishedDate: { type: "date" },
        },
        attributes: { name: "示例公司", quoteDirection: "CNY/USD" },
      },
      limitations: [historicalLimitation],
    });
    expect(result).not.toHaveProperty("data.rows");
    expect(JSON.stringify(result)).not.toMatch(
      /sourceRef|candidateClaims|evidenceId|runId|selector|\/data\/|https?:|adapterVersion|normalizationVersion|internal-filing-id/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps exact business values once and never returns numeric reference candidates", async () => {
    const saved = source();
    const before = structuredClone(saved);
    const result = await reader(saved).call(request);
    expect(result).toMatchObject({
      kind: "rows",
      totalRows: 3,
      offset: 0,
      limit: 1,
      data: {
        rows: [
          {
            index: 0,
            date: "2024-01-01",
            periodStart: "2024-01-01",
            publishedDate: "2024-01-02",
            values: { profit: 123456789.012345 },
          },
        ],
      },
      limitations: [historicalLimitation],
    });
    const text = JSON.stringify(result);
    expect(text.match(/123456789\.012345/g)).toHaveLength(1);
    expect(text).not.toMatch(
      /sourceRef|candidateClaims|evidenceId|runId|selector|\/data\/|https?:|adapterVersion|normalizationVersion|internal-filing-id/,
    );
    expect(result).not.toHaveProperty("data.rows.0.filing");
    expect(result).not.toHaveProperty("data.rows.0.values.revenue");
    expect(saved).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts explicitly requested date fields and returns their values without numeric duplication", async () => {
    const result = await reader().call({
      ...request,
      fields: ["date", "periodStart", "publishedDate", "profit"],
      offset: 1,
    });
    expect(result).toMatchObject({
      data: {
        columns: { profit: { label: "归母净利润", unit: "CNY" } },
        rows: [
          {
            index: 1,
            date: "2024-01-02",
            periodStart: "2024-01-01",
            publishedDate: null,
            values: { profit: null },
          },
        ],
      },
      limitations: [
        historicalLimitation,
        { code: "missing", detail: "Profit is absent for 2024-01-02." },
        {
          code: "unverified_time",
          detail: "The second row has no precise publication time.",
        },
      ],
    });
    expect(result).not.toHaveProperty("data.rows.0.values.date");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can read only automatically supplied row fields", async () => {
    const result = await reader().call({
      ...request,
      fields: ["publishedDate"],
    });
    expect(result).toMatchObject({
      data: {
        columns: {},
        rows: [{ date: "2024-01-01", publishedDate: "2024-01-02", values: {} }],
      },
    });
  });

  it("filters dates before pagination and preserves the original row number", async () => {
    const result = await reader().call({
      ...request,
      dateFrom: "2024-01-02",
      dateTo: "2024-01-03",
      offset: 1,
    });
    expect(result).toMatchObject({
      totalRows: 2,
      data: {
        rows: [{ index: 2, date: "2024-01-03", values: { profit: 34.56 } }],
      },
      limitations: [historicalLimitation],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves only limitations that apply to the selected fields and rows", async () => {
    const result = await reader().call({ ...request, fields: ["revenue"] });
    expect(result).toMatchObject({
      limitations: [
        historicalLimitation,
        {
          code: "incomparable",
          detail: "The first revenue observation is not comparable.",
        },
      ],
    });
  });

  it("does not attach limitations about an unselected numeric column", async () => {
    const saved = source();
    const limitation = {
      code: "incomparable" as const,
      detail: "Revenue uses a source-specific definition.",
    };
    saved.envelope.gaps.push({
      ...limitation,
      field: "/data/columns/revenue",
    });
    expect(await reader(saved).call(request)).toMatchObject({
      limitations: [historicalLimitation],
    });
    expect(
      await reader(saved).call({ ...request, fields: ["revenue"] }),
    ).toMatchObject({
      limitations: expect.arrayContaining([limitation]),
    });
    expect(
      await reader(saved).describe({
        table: "financial.indicators",
      }),
    ).toMatchObject({
      limitations: expect.arrayContaining([limitation]),
    });
  });

  it.each([
    { ...request, fields: ["unknown"] },
    { ...request, fields: ["filing"] },
    { ...request, fields: ["date", "date"] },
    { ...request, fields: [] },
    { ...request, offset: -1 },
    { ...request, limit: 101 },
    { ...request, dateFrom: "2024-02-30" },
    { ...request, dateFrom: "2024-01-03", dateTo: "2024-01-02" },
  ])("rejects invalid requests at the tool boundary: %j", async (args) => {
    await expect(reader().call(args)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports unavailable tables and respects cancellation without source access", async () => {
    await expect(
      reader().call({ ...request, table: "market.daily" }),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    const controller = new AbortController();
    controller.abort(new Error("Stop collection view"));
    await expect(reader().call(request, controller.signal)).rejects.toThrow(
      "Stop collection view",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
