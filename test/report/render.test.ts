import { describe, expect, it } from "vitest";
import type { ArtifactInput } from "../../src/contracts/artifacts.js";
import { renderArtifact } from "../../src/report/render.js";

const artifact = { runId: "run-one", artifactId: "analysis-one", revision: 3 };
const source = {
  runId: "run-one",
  evidenceId: "evidence-one",
  selector: "/observations/0/value",
};
function input(overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    kind: "analysis",
    title: "Research",
    body: "Body",
    claims: [],
    inputRefs: [],
    payload: {},
    ...overrides,
  };
}

describe("verified artifact rendering", () => {
  it("renders observed, calculated and estimated values with their distinct unit semantics", () => {
    const result = renderArtifact(
      input({
        body: "Price {{number:price}}, return {{number:return}}, estimate {{number:estimate}}.",
        claims: [
          { id: "price", kind: "observed", value: 125.5, unit: "USD", source },
          {
            id: "return",
            kind: "calculated",
            value: 0.125,
            unit: "ratio",
            operation: "simple_return",
            inputs: [
              { kind: "local", claimId: "price" },
              { kind: "artifact", artifact, claimId: "previous" },
            ],
          },
          {
            id: "estimate",
            kind: "estimated",
            value: 6.5,
            unit: "percent",
            method: "Scenario model",
            assumptions: ["Stable margin"],
            evidence: [source],
          },
        ],
      }),
    );
    expect(result).toContain(
      "Price 125.5 USD, return 12.5%, estimate 6.5%（估计）.",
    );
    expect(result).not.toContain("run-one");
    expect(result).not.toContain("## 数值声明");
  });

  it("replaces repeated placeholders while preserving dates, tickers and authored Markdown", () => {
    const body =
      "## NVDA on 2024-01-02\n\n**Price**: {{number:price}}; again {{number:price}}.\n\n[Source](https://example.com)\n\n```text\nNVDA 2024-01-02\n```";
    const result = renderArtifact(
      input({
        body,
        claims: [
          { id: "price", kind: "observed", value: 0, unit: "USD", source },
        ],
      }),
    );
    expect(result).toContain(
      "## NVDA on 2024-01-02\n\n**Price**: 0 USD; again 0 USD.\n\n[Source](https://example.com)\n\n```text\nNVDA 2024-01-02\n```",
    );
    expect(result).not.toContain("{{number:");
  });

  it("renders an estimate without appending its internal provenance", () => {
    const result = renderArtifact(
      input({
        body: "Value {{number:valuation}}",
        inputRefs: [artifact],
        claims: [
          {
            id: "valuation",
            kind: "estimated",
            value: -2,
            unit: "USD/share",
            method: "Discounted cash flow",
            assumptions: ["Growth remains flat", "Discount rate is fixed"],
            evidence: [source],
          },
        ],
      }),
    );
    expect(result).toContain("-2 USD/share（估计）");
    expect(result).not.toContain("Discounted cash flow");
    expect(result).not.toContain("run-one");
  });

  it("escapes metadata markup and folds metadata newlines without escaping authored body", () => {
    const result = renderArtifact(
      input({
        title: "Title *bold*\n# heading",
        body: "**authored** {{number:claim_[x]}}",
        claims: [
          {
            id: "claim_[x]",
            kind: "estimated",
            value: 5,
            unit: "USD|share",
            method: "<method>\nnext",
            assumptions: ["*assumption*"],
            evidence: [{ ...source, selector: "/[value]" }],
          },
        ],
      }),
    );
    expect(result).toContain(String.raw`# Title \*bold\* \# heading`);
    expect(result).toContain("**authored**");
    expect(result).toContain(String.raw`5 USD\|share（估计）`);
    expect(result).not.toContain("<method>");
  });

  it("omits empty metadata sections and ends plain artifacts with one newline", () => {
    expect(
      renderArtifact(input({ title: "Plain", body: "Paragraph\n\n- item" })),
    ).toBe("# Plain\n\nParagraph\n\n- item\n");
  });

  it("formats business values without provenance appendices and leaves exact values intact", () => {
    const value = input({
      body: "SMA20：{{number:sma}}；RSI：{{number:rsi}}。",
      claims: [
        {
          id: "sma",
          kind: "observed",
          value: 83.15299999999999,
          unit: "CNY/share",
          source,
        },
        {
          id: "rsi",
          kind: "observed",
          value: 0.000000123456789,
          unit: "index",
          source,
        },
      ],
      inputRefs: [artifact],
    });
    const result = renderArtifact(value);
    expect(result).toContain(
      "SMA20：83.153 CNY/share；RSI：0.000000123457 index。",
    );
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("数值与引用");
    expect(value.claims[0]!.value).toBe(83.15299999999999);
    expect(value.claims[1]!.value).toBe(0.000000123456789);
  });

  it("does not append a raw input manifest to the reader-facing final report", () => {
    const value = input({ kind: "report", inputRefs: [artifact] });
    expect(renderArtifact(value)).toBe("# Research\n\nBody\n");
    expect(value.inputRefs).toEqual([artifact]);
  });

  it("does not modify the verified input or nested references", () => {
    const value = input({
      body: "{{number:estimate}}",
      inputRefs: [artifact],
      payload: { retained: [1, 2] },
      claims: [
        {
          id: "estimate",
          kind: "estimated",
          value: 10,
          unit: "USD",
          method: "Model",
          assumptions: ["Assumption"],
          evidence: [source],
        },
      ],
    });
    const before = structuredClone(value);
    renderArtifact(value);
    expect(value).toEqual(before);
  });
});
