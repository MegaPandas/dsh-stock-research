import { describe, expect, it } from "vitest";
import type { CollectedTableData } from "../../src/contracts/collection.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import { extractCandidates } from "../../src/services/candidates.js";
import {
  numberField,
  referenceField,
} from "../../src/services/number-fields.js";
import { verifyEvidence } from "../../src/services/evidence-checks.js";
import { CN_SECURITY } from "../fixtures/market.js";

function envelope(): DataEnvelope<CollectedTableData> {
  return {
    dataset: "fundamentals",
    data: {
      table: "financial.indicators",
      title: "人工指标样本",
      columns: {
        debt: { label: "负债率", unit: "percent" },
        eps: { label: "每股收益", unit: "CNY/share" },
      },
      rows: [
        {
          date: "2024-06-30",
          asOf: "2024-06-30T15:59:59.999Z",
          availableAt: null,
          complete: true,
          values: { debt: 70, eps: 1.5 },
        },
      ],
    },
    source: {
      provider: "fixture",
      url: "https://example.com/financial",
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: "2024-06-30T15:59:59.999Z",
    availableAt: null,
    retrievedAt: "2024-08-30T00:00:00.000Z",
    cutoff: "2024-08-30T00:01:00.000Z",
    ageMs: 1,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [
      {
        code: "unverified_time",
        field: "/data/rows",
        detail: "Current historical view.",
      },
    ],
  };
}

describe("collected evidence quantity contracts", () => {
  it("uses column-specific units and source values when constructing numeric candidates", () => {
    const frame = envelope();
    expect(extractCandidates(frame)).toEqual([
      expect.objectContaining({
        value: 70,
        unit: "percent",
        selector: "/data/rows/0/values/debt",
      }),
      expect.objectContaining({
        value: 1.5,
        unit: "CNY/share",
        selector: "/data/rows/0/values/eps",
      }),
    ]);
    expect(numberField(frame, "/data/rows/0/values/debt")).toMatchObject({
      value: 70,
      unit: "percent",
    });
    expect(numberField(frame, "/data/rows/0/values/eps")).toMatchObject({
      value: 1.5,
      unit: "CNY/share",
    });
    expect(() => numberField(frame, "/data/rows/0/asOf")).toThrow();
  });

  it("requires a pre-cutoff capture for a current historical view and rejects incomplete rows", () => {
    const frame = envelope();
    const scope = {
      security: CN_SECURITY,
      date: "2024-08-30",
      cutoff: frame.cutoff,
    };
    const ref = {
      runId: "run",
      evidenceId: "evidence",
      selector: "/data/rows/0/values/debt",
    };
    expect(() =>
      verifyEvidence(
        scope,
        frame,
        ref,
        referenceField(frame, ref.selector),
        [],
      ),
    ).not.toThrow();
    frame.retrievedAt = "2024-08-30T00:02:00.000Z";
    expect(() =>
      verifyEvidence(
        scope,
        frame,
        ref,
        referenceField(frame, ref.selector),
        [],
      ),
    ).toThrow(/known by cutoff/);
    frame.retrievedAt = "2024-08-30T00:00:00.000Z";
    frame.data.rows[0]!.complete = false;
    expect(() =>
      verifyEvidence(
        scope,
        frame,
        ref,
        referenceField(frame, ref.selector),
        [],
      ),
    ).toThrow(/incomplete/);
  });
});
