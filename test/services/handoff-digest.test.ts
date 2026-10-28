import { describe, expect, it } from "vitest";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import type { RiskIssue } from "../../src/contracts/artifact-payloads.js";
import type { ArtifactVersion } from "../../src/contracts/artifacts.js";
import type { DigestModelInput } from "../../src/contracts/digests.js";
import type { StageHandoff } from "../../src/contracts/stage-handoff.js";
import { assembleDigest } from "../../src/services/digest-draft.js";
import { handoffDigest } from "../../src/services/handoff-digest.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-28",
  cutoff: "2026-10-28T08:00:00.000Z",
};
const empty = (): StageHandoff => ({
  keyPoints: [],
  disagreements: [],
  risks: [],
  openQuestions: [],
});
function version(
  taskId: string,
  kind: "analysis" | "debate" | "risk" | "digest",
  payload: Record<string, unknown>,
): ArtifactVersion {
  return {
    ref: { runId: "run", artifactId: taskId, revision: 1 },
    taskId,
    attempt: 1,
    producerSessionId: "role-session",
    createdAt: scope.cutoff,
    schemaVersion: 1,
    content: {
      kind,
      title: taskId,
      body: "完整报告原文不应重复注入交接。",
      inputRefs: [],
      claims: [],
      payload,
    },
  };
}
function input(artifacts: ArtifactVersion[]): DigestModelInput {
  return {
    scope,
    taskId: "digest.analysis",
    instructionVersion: 1,
    instruction: null,
    artifacts,
    reports: artifacts,
    references: artifacts.map(({ ref }) => ref),
    numbers: [],
    risks: [],
    gaps: [],
  };
}
function digest(
  riskSummaries: { issueId: string; text: string }[] = [],
): AgentReport<"digest"> {
  return {
    summary: "PREVIOUS SUMMARY",
    content: {
      keyPoints: ["PREVIOUS LONG POINT"],
      disagreements: [],
      riskSummaries,
      openQuestions: [],
    },
  };
}
function issue(issueId: string): RiskIssue {
  return {
    issueId,
    description: "资金缺口",
    impact: "限制扩张",
    trigger: "现金流持续为负",
    constraint: "限制集中敞口",
    recommendation: "按季复核",
    evidence: [],
    numbers: [],
  };
}

describe("deterministic role handoff digest", () => {
  it("retains authored handoff text, attribution and fixed provenance without reading the report body", () => {
    const handoff: StageHandoff = {
      keyPoints: ["毛利率18.9%，预测依赖销量增长10%。"],
      disagreements: ["毛利改善能否持续仍有争议。"],
      risks: ["价格下降会压缩利润；以毛利率为触发信号。"],
      openQuestions: ["折扣是否扩大？"],
    };
    const original = input([
      version("analysis.fundamentals", "analysis", { stageHandoff: handoff }),
    ]);
    const before = structuredClone(original);
    const result = handoffDigest(original);
    expect(result.report!.content).toEqual({
      keyPoints: [
        "[analysis.fundamentals] 毛利率18.9%，预测依赖销量增长10%。",
        "[analysis.fundamentals] 风险：价格下降会压缩利润；以毛利率为触发信号。",
      ],
      disagreements: ["[analysis.fundamentals] 毛利改善能否持续仍有争议。"],
      riskSummaries: [],
      openQuestions: ["[analysis.fundamentals] 折扣是否扩大？"],
    });
    expect(result.facts[0]!.inputRefs).toEqual([original.artifacts[0]!.ref]);
    expect(assembleDigest(result, original).payload.upstreamRefs).toEqual(
      original.references,
    );
    expect(JSON.stringify(result)).not.toContain("完整报告原文");
    result.facts[0]!.inputRefs[0]!.artifactId = "changed";
    expect(original).toEqual(before);
  });

  it("keeps opposing views distinct while retaining the preceding digest only as a fixed input", () => {
    const previous = version("digest.analysis", "digest", { report: digest() });
    const original = input([
      previous,
      version("debate.1.bull", "debate", {
        stageHandoff: {
          ...empty(),
          keyPoints: ["毛利率可升至20%，条件是折扣收窄。"],
        },
      }),
      version("debate.1.bear", "debate", {
        stageHandoff: {
          ...empty(),
          keyPoints: ["毛利率可能降至17%，条件是折扣扩大。"],
        },
      }),
    ]);
    const result = handoffDigest(original);
    expect(result.report!.content.keyPoints).toEqual([
      "[debate.1.bull] 毛利率可升至20%，条件是折扣收窄。",
      "[debate.1.bear] 毛利率可能降至17%，条件是折扣扩大。",
    ]);
    expect(JSON.stringify(result.report)).not.toContain("PREVIOUS");
    expect(result.inputRefs).toContainEqual(previous.ref);
  });

  it("binds inherited and newly assigned risk IDs once without duplicating their text in key points", () => {
    const inherited = issue("risk.inherited.1");
    const current = issue("risk.finance.1");
    const priorText = "收入下行影响偿债；触发为现金流转负；限制单一持仓。";
    const currentText = "资金缺口限制扩张；现金流持续为负时限制集中敞口。";
    const original = input([
      version("digest.plan", "digest", {
        report: digest([{ issueId: inherited.issueId, text: priorText }]),
      }),
      version("risk.finance", "risk", {
        issues: [current],
        stageHandoff: {
          ...empty(),
          keyPoints: ["需要约束财务敞口。"],
          risks: [currentText],
        },
      }),
    ]);
    original.risks = [inherited, current];
    const result = handoffDigest(original);
    expect(result.riskSummaries).toEqual([
      { issueId: inherited.issueId, text: priorText },
      { issueId: current.issueId, text: currentText },
    ]);
    expect(result.report!.content.keyPoints).toEqual([
      "[risk.finance] 需要约束财务敞口。",
    ]);
    expect(assembleDigest(result, original).payload.risks).toEqual(
      original.risks,
    );
  });

  it("reports missing handoffs and missing risk coverage instead of inventing summaries", () => {
    expect(() =>
      handoffDigest(input([version("analysis.market", "analysis", {})])),
    ).toThrowError(/analysis.market.*stageHandoff/);
    const missing = input([
      version("analysis.market", "analysis", { stageHandoff: empty() }),
    ]);
    missing.risks = [issue("risk.missing.1")];
    expect(() => handoffDigest(missing)).toThrowError(
      /Missing accepted handoff.*risk.missing.1/,
    );
    const missingRisk = input([
      version("risk.finance", "risk", {
        issues: [issue("risk.finance.1")],
        stageHandoff: empty(),
      }),
    ]);
    expect(() => handoffDigest(missingRisk)).toThrowError(
      /risk.finance.*no handoff.*risk.finance.1/,
    );
  });

  it("rejects conflicting accepted risk handoffs", () => {
    const original = input([
      version("digest.first", "digest", {
        report: digest([{ issueId: "risk.1", text: "first accepted view" }]),
      }),
      version("digest.second", "digest", {
        report: digest([
          { issueId: "risk.1", text: "different accepted view" },
        ]),
      }),
    ]);
    original.risks = [issue("risk.1")];
    expect(() => handoffDigest(original)).toThrowError(
      /Conflicting accepted handoffs.*risk.1/,
    );
  });

  it("retains seven substantial role handoffs in the analysis stage", () => {
    const artifacts = Array.from({ length: 7 }, (_, index) =>
      version(`analysis.role-${index}`, "analysis", {
        stageHandoff: { ...empty(), keyPoints: ["中".repeat(650)] },
      }),
    );
    const result = handoffDigest(input(artifacts));
    expect(result.report!.content.keyPoints).toHaveLength(7);
    expect(
      result.report!.content.keyPoints.every((point) =>
        point.endsWith("中".repeat(650)),
      ),
    ).toBe(true);
  });

  it("accepts the elastic stage budget and reports oversize without clipping any role", () => {
    const artifacts = Array.from({ length: 42 }, (_, index) =>
      version(`analysis.role-${index}`, "analysis", {
        stageHandoff: { ...empty(), keyPoints: ["中".repeat(200)] },
      }),
    );
    const elastic = handoffDigest(input(artifacts.slice(0, 27)));
    expect([...JSON.stringify(elastic.report)].length).toBeGreaterThan(6000);
    expect([...JSON.stringify(elastic.report)].length).toBeLessThanOrEqual(
      9000,
    );
    expect(elastic.report!.content.keyPoints).toHaveLength(27);
    expect(
      elastic.report!.content.keyPoints.every((point) =>
        point.endsWith("中".repeat(200)),
      ),
    ).toBe(true);
    expect(() => handoffDigest(input(artifacts))).toThrowError(
      /9000 Unicode characters.*target 4500.*analysis.role-41=.*no content was truncated/s,
    );
    expect(
      (artifacts[17]!.content.payload as { stageHandoff: StageHandoff })
        .stageHandoff.keyPoints[0],
    ).toHaveLength(200);
  });
});
