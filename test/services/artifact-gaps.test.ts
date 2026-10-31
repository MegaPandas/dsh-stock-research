import { describe, expect, it } from "vitest";
import type { ReportedGap } from "../../src/contracts/artifact-payloads.js";
import {
  aggregateArtifactGaps,
  summarizeArtifactGaps,
} from "../../src/artifacts/gaps.js";

const source = { runId: "run", evidenceId: "prices", selector: "" };
const missing = (index: number): Extract<ReportedGap, { kind: "source" }> => ({
  kind: "source",
  source,
  gap: {
    code: "missing",
    field: `/data/rows/${index}/values/amount`,
    detail: `Amount unavailable in observation ${index}.`,
  },
});

describe("data-quality summaries", () => {
  it("groups row-level gaps and retains a real example and the complete input", () => {
    const gaps = Array.from({ length: 60 }, (_, index) => missing(index));
    const before = structuredClone(gaps);
    expect(summarizeArtifactGaps(gaps)).toEqual([
      { ...gaps[0], fieldPattern: "/data/rows/*/values/amount", count: 60 },
    ]);
    expect(gaps).toEqual(before);
  });

  it("keeps origins, artifact revisions, fields and gap codes distinct", () => {
    const first = missing(0);
    const artifacts = [1, 2].map((revision): ReportedGap => ({
      kind: "artifact",
      artifact: { runId: "run", artifactId: "analysis", revision },
      gap: first.gap,
    }));
    const gaps: ReportedGap[] = [
      first,
      { ...first, source: { ...source, evidenceId: "other" } },
      { ...first, gap: { ...first.gap, field: "/data/rows/0/values/volume" } },
      { ...first, gap: { ...first.gap, code: "incomparable" } },
      ...artifacts,
    ];
    const amount = "/data/rows/*/values/amount";
    expect(summarizeArtifactGaps(gaps)).toEqual([
      { ...first, fieldPattern: amount, count: 1 },
      { ...gaps[1], fieldPattern: amount, count: 1 },
      { ...gaps[2], fieldPattern: "/data/rows/*/values/volume", count: 1 },
      { ...gaps[3], fieldPattern: amount, count: 1 },
      { ...artifacts[0], fieldPattern: amount, count: 1 },
      { ...artifacts[1], fieldPattern: amount, count: 1 },
    ]);
  });

  it.each(["rows", "bars", "observations", "items"])(
    "groups only array positions for %s",
    (collection) => {
      const gap: ReportedGap = {
        kind: "source",
        source,
        gap: {
          code: "missing",
          field: `/data/${collection}/5/value`,
          detail: "Missing value",
        },
      };
      expect(summarizeArtifactGaps([gap])).toEqual([
        { ...gap, fieldPattern: `/data/${collection}/*/value`, count: 1 },
      ]);
      const namedField = {
        ...gap,
        gap: { ...gap.gap, field: "/data/fields/2026/value" },
      };
      expect(summarizeArtifactGaps([namedField])).toEqual([
        { ...namedField, fieldPattern: "/data/fields/2026/value", count: 1 },
      ]);
    },
  );

  it("counts repeated source references once after raw-gap aggregation", () => {
    const gap = missing(0).gap;
    const raw = aggregateArtifactGaps(
      [],
      [
        { source, gaps: [gap] },
        { source, gaps: [gap] },
      ],
    );
    expect(raw).toHaveLength(1);
    expect(summarizeArtifactGaps(raw)).toEqual([
      { ...missing(0), fieldPattern: "/data/rows/*/values/amount", count: 1 },
    ]);
    expect(summarizeArtifactGaps([])).toEqual([]);
  });
});
