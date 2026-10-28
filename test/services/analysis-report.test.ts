import { afterEach, describe, expect, it } from "vitest";
import type { GenerateDigest } from "../../src/contracts/digests.js";
import type { TaskDefinition } from "../../src/contracts/workflow.js";
import {
  assembleAnalysis,
  parseAnalysisDraft,
  parseAnalysisReport,
  renderAnalysisReport,
} from "../../src/services/analysis-report.js";
import { ArtifactInputs } from "../../src/services/artifact-inputs.js";
import { parseArtifactInput } from "../../src/services/artifact-schema.js";
import { checkDecisionRequirements } from "../../src/services/decision-requirements.js";
import { DigestService } from "../../src/services/digests.js";
import { renderArtifact } from "../../src/report/render.js";
import { analysisReport } from "../fixtures/analysis-report.js";
import { decisionFixture } from "../fixtures/decision.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function stageFixture(
  edit?: (frame: ReturnType<typeof decisionFixture>["frame"]) => void,
) {
  const task: TaskDefinition = {
    id: "stage",
    executor: { kind: "role", role: "analyst", specialty: "market" },
    dependsOn: [],
    inputTasks: [],
    outputKinds: ["analysis"],
    dataRequirements: [
      { dataset: "market", fields: ["close"], requiredForDecision: true },
    ],
    instructionVersion: 1,
  };
  const fixture = decisionFixture({
    additionalTasks: [
      task,
      {
        id: "stage.digest",
        executor: { kind: "service", service: "digest" },
        dependsOn: [task.id],
        inputTasks: [task.id],
        outputKinds: ["digest"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ],
  });
  cleanups.push(fixture.close);
  const operation = {
    ...fixture.runs.claim(fixture.operation, "stage", "stage-claim"),
    identity: "worker",
    sessionId: null,
  };
  const frame = structuredClone(fixture.frame);
  edit?.(frame);
  fixture.runs.recordEvidence(
    operation,
    {
      dataset: "market",
      provider: "fixture",
      parameters: { table: "market.daily" },
    },
    frame,
    "collection:market.daily",
  );
  const report = analysisReport();
  report.current_state = ["最近收盘100美元/股。"];
  report.handoff.limitations = ["缺少交付数据，不能验证销量驱动假设。"];
  const calls = fixture.numbers.calls;
  const content = assembleAnalysis(report, "阶段行情分析", []);
  const ref = fixture.artifacts.submitArtifact(
    operation,
    [content],
    "stage-submit",
  ).refs[0]!;
  const inputs = new ArtifactInputs(fixture.runs);
  const versions = inputs.closure([ref]);
  return {
    ...fixture,
    task,
    report,
    content,
    ref,
    inputs,
    versions,
    priorNumberCalls: calls,
  };
}

describe("directional analysis reports", () => {
  it("accepts the six business sections without reference metadata and preserves ordinary business numbers", () => {
    const report = analysisReport();
    report.current_state = ["收盘82.40元，低于20日均线83.058元。"];
    expect(parseAnalysisDraft(JSON.stringify(report))).toEqual(report);
    const content = assembleAnalysis(report, "行情阶段分析", []);
    expect(parseArtifactInput(content)).toEqual(content);
    expect(content.payload).toEqual({ schemaVersion: 2, ...report });
    expect(content.claims).toEqual([]);
    expect(content.body).toContain("82.40元");
    expect(content.body).not.toContain("{{number:");
  });

  it.each([
    [
      "analysis_model/mechanism",
      (value: Record<string, unknown>) => {
        (value.analysis_model as Record<string, unknown>).mechanism = "";
      },
    ],
    [
      "outlook/base_case/conditions",
      (value: Record<string, unknown>) => {
        (
          value.outlook as { base_case: Record<string, unknown> }
        ).base_case.conditions = "not an array";
      },
    ],
    [
      "handoff/open_questions",
      (value: Record<string, unknown>) => {
        delete (value.handoff as Record<string, unknown>).open_questions;
      },
    ],
    [
      "claims",
      (value: Record<string, unknown>) => {
        value.claims = [];
      },
    ],
    [
      "schemaVersion",
      (value: Record<string, unknown>) => {
        value.schemaVersion = 2;
      },
    ],
  ] as const)("rejects malformed business contract at %s", (path, mutate) => {
    const value: Record<string, unknown> = structuredClone(analysisReport());
    mutate(value);
    expect(() => parseAnalysisReport(value)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        message: expect.stringContaining(path),
      }),
    );
  });

  it("rejects bad JSON without echoing the draft in an error", () => {
    expect(() =>
      parseAnalysisDraft('{"assessment":"PRIVATE-DRAFT"'),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.not.stringContaining("PRIVATE-DRAFT"),
      }),
    );
  });

  it("renders the analysis model, conditional outlook, risks and handoff once without an internal citation appendix", () => {
    const report = analysisReport();
    report.current_state = ["毛利率为5%。"];
    const body = renderAnalysisReport(report);
    expect(body).toContain("## 分析模型");
    expect(body).toContain("### 基准路径");
    expect(body).toContain("### 替代路径");
    expect(body).toContain("## 风险与反证");
    expect(body).toContain("## 对后续研究的含义");
    expect(body.match(/毛利率为5%/g)).toHaveLength(1);
    expect(body).not.toContain("%%");
    expect(renderArtifact(assembleAnalysis(report, "研究", []))).not.toContain(
      "<details>",
    );
  });

  it("publishes a business note without numeric-claim validation and checks provided data coverage", () => {
    const f = stageFixture();
    expect(f.numbers.calls).toBe(f.priorNumberCalls);
    expect(f.runs.readArtifact(f.ref).content.payload).toEqual({
      schemaVersion: 2,
      ...f.report,
    });
    expect(() =>
      checkDecisionRequirements([f.task], f.versions, f.inputs, f.scope.cutoff),
    ).not.toThrow();
    expect(
      f.store
        .read(f.operation.runId)
        .tasks.find((task) => task.taskId === "stage")!.status,
    ).toBe("succeeded");
    expect(f.inputs.reportedGaps(f.versions)).toEqual([]);
  });

  it("does not cover a missing latest close with an older value in the provided data", () => {
    const f = stageFixture((frame) => {
      frame.envelope.data.bars.at(-1)!.close = null;
    });
    expect(() =>
      checkDecisionRequirements([f.task], f.versions, f.inputs, f.scope.cutoff),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining("latest"),
      }),
    );
  });

  it("rejects provided observations after cutoff without needing a model citation", () => {
    const f = stageFixture((frame) => {
      frame.envelope.data.bars.at(-1)!.asOf = "2024-01-04T21:00:00.000Z";
    });
    expect(() =>
      checkDecisionRequirements([f.task], f.versions, f.inputs, f.scope.cutoff),
    ).toThrowError(
      expect.objectContaining({
        code: "DATA_INSUFFICIENT",
        message: expect.stringContaining("after cutoff"),
      }),
    );
  });

  it("keeps actual source gaps separate from analytical limitations", () => {
    const f = stageFixture((frame) => {
      frame.envelope.gaps.push({
        code: "missing",
        field: "/data/bars/1/volume",
        detail: "成交量缺失。",
      });
    });
    expect(f.inputs.reportedGaps(f.versions)).toMatchObject([
      { kind: "source", gap: { detail: "成交量缺失。" } },
    ]);
    expect(() =>
      checkDecisionRequirements([f.task], f.versions, f.inputs, f.scope.cutoff),
    ).not.toThrow();
  });

  it("hands all six sections to the existing digest service with no invented numeric candidates", async () => {
    const f = stageFixture();
    const generate: GenerateDigest = async (
      context,
      _signal,
      _operation,
      submit,
    ) => {
      expect(context.artifacts).toHaveLength(1);
      expect(context.artifacts[0]!.content.payload).toEqual({
        schemaVersion: 2,
        ...f.report,
      });
      expect(context.numbers).toEqual([]);
      return submit({
        title: "阶段研究摘要",
        body: "综合本方向判断与条件。",
        inputRefs: context.artifacts.map((item) => item.ref),
        facts: [{ text: f.report.assessment, inputRefs: [f.ref], numbers: [] }],
        disagreements: f.report.handoff.open_questions,
        riskSummaries: [],
      });
    };
    const result = await new DigestService(
      f.runs,
      f.artifacts,
      generate,
    ).makeDigest(f.operation, "stage.digest", "stage-digest");
    expect(f.runs.readArtifact(result.refs[0]!).content.payload).toMatchObject({
      facts: [{ text: f.report.assessment }],
    });
  });
});
