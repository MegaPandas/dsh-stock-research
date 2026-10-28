import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import {
  agentReportSchemas,
  DIGEST_MAX_CHARACTERS,
  type AgentReport,
} from "../../src/contracts/agent-reports.js";
import {
  parseAgentReport,
  validateStoredAgentReport,
} from "../../src/services/agent-reports.js";

function analysis(): AgentReport<"analysis"> {
  return {
    summary: "产品组合改善带动盈利，销量和终端价格决定后续增幅。",
    content: {
      currentState: ["新产品交付占比提高。"],
      analysisModel: {
        drivers: ["产品组合", "终端价格"],
        mechanism: "高价产品占比提高带动单车利润。",
        assumptions: [],
        alternativeExplanations: [],
      },
      outlook: {
        horizon: "未来两个季度",
        baseCase: { conditions: [], expectation: "产品组合继续改善。" },
        alternativeCases: [],
        watchPoints: [],
      },
      risks: [],
      handoff: { implications: [], openQuestions: [], limitations: [] },
    },
  };
}

function decision(): AgentReport<"decision_draft"> {
  return {
    summary: "保持买入判断，盈利兑现决定估值空间。",
    content: {
      thesis: ["产品组合改善带动利润。"],
      targetPrice: {
        value: 100,
        method: "预期每股收益乘以市盈率。",
        assumptions: ["每股收益5元，市盈率20倍。"],
      },
      risks: [],
      riskResponses: [],
      invalidationConditions: [],
      limitations: [],
    },
  };
}

describe("agent report contracts", () => {
  it("exposes every report through a DSH-supported closed JSON Schema", () => {
    for (const schema of Object.values(agentReportSchemas)) {
      expect(() => assertSupportedJsonSchema(schema)).not.toThrow();
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(["summary", "content"]);
    }
  });

  it("accepts the analysis model and preserves empty optional business lists", () => {
    const value = analysis();
    const parsed = parseAgentReport("analysis", value);
    expect(parsed).toEqual(value);
    parsed.content.analysisModel.drivers.push("产能");
    expect(value.content.analysisModel.drivers).toEqual([
      "产品组合",
      "终端价格",
    ]);
  });

  it.each([
    null,
    { summary: "结论" },
    { summary: "结论", content: {}, requestId: "model-request" },
    { summary: "结论", content: { unexpected: true } },
    {
      summary: "结论",
      content: { explanation: "plain text", limitations: [] },
    },
  ])("rejects report structures outside the selected role: %j", (value) => {
    expect(() => parseAgentReport("ask", value)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("enforces the summary budget in Unicode characters", () => {
    expect(
      parseAgentReport("coordinator", {
        summary: "🚀".repeat(600),
        content: {},
      }).summary,
    ).toHaveLength(1200);
    expect(() =>
      parseAgentReport("coordinator", {
        summary: "中".repeat(601),
        content: {},
      }),
    ).toThrowError(/summary.*600/);
  });

  it("limits the complete digest JSON in Unicode characters and retains risk handoffs", () => {
    const value: AgentReport<"digest"> = {
      summary: "交接结论。",
      content: {
        keyPoints: ["事实。"],
        disagreements: [],
        riskSummaries: [
          { issueId: "risk.finance.1", text: "折扣扩大时降低盈利假设。" },
        ],
        openQuestions: [],
      },
    };
    const available = DIGEST_MAX_CHARACTERS - [...JSON.stringify(value)].length;
    const elastic = structuredClone(value);
    elastic.content.keyPoints[0] += "中".repeat(
      3100 - [...JSON.stringify(elastic)].length,
    );
    expect([...JSON.stringify(elastic)]).toHaveLength(3100);
    expect(parseAgentReport("digest", elastic)).toEqual(elastic);
    value.content.keyPoints[0] += "🚀".repeat(available);
    expect([...JSON.stringify(value)]).toHaveLength(DIGEST_MAX_CHARACTERS);
    expect(JSON.stringify(value).length).toBeGreaterThan(DIGEST_MAX_CHARACTERS);
    expect(parseAgentReport("digest", value)).toEqual(value);
    value.content.keyPoints[0] += "中";
    expect(() => parseAgentReport("digest", value)).toThrowError(
      /9001\/9000.*over by 1.*keyPoints=/,
    );
    expect(() => validateStoredAgentReport("digest", value)).not.toThrow();
  });

  it("reports summary and serialized field sizes including escaped characters", () => {
    const value: AgentReport<"digest"> = {
      summary: "🚀".repeat(601),
      content: {
        keyPoints: ['引号"和换行\n'],
        disagreements: [],
        riskSummaries: [],
        openQuestions: [],
      },
    };
    const total = [...JSON.stringify(value)].length;
    const points = [...JSON.stringify(value.content.keyPoints)].length;
    expect(() => parseAgentReport("digest", value)).toThrowError(
      new RegExp(
        `${total}/9000.*summary: 601/600.*over by 1.*keyPoints=${points}`,
      ),
    );
  });

  it.each([{ rating: "buy" }, { horizonEndDate: "2027-03-31" }])(
    "rejects code-owned manager fields in a current submission: %j",
    (extra) => {
      const value = decision();
      expect(() =>
        parseAgentReport("decision_draft", {
          ...value,
          content: { ...value.content, ...extra },
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    },
  );

  it("reads a recorded manager report with its original rating and horizon", () => {
    const value = decision();
    const recorded = {
      ...value,
      content: {
        ...value.content,
        rating: "hold",
        horizonEndDate: "2027-03-31",
      },
    };
    expect(() =>
      validateStoredAgentReport("decision_draft", recorded),
    ).not.toThrow();
    expect(recorded.content.rating).toBe("hold");
    expect(recorded.content.horizonEndDate).toBe("2027-03-31");
    expect(() => parseAgentReport("decision_draft", recorded)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects empty report text while accepting an empty explanation list", () => {
    expect(() =>
      parseAgentReport("ask", {
        summary: "答案。",
        content: { explanation: ["  "], limitations: [] },
      }),
    ).toThrowError(/explanation\/0.*nonempty/);
    expect(
      parseAgentReport("ask", {
        summary: "答案。",
        content: { explanation: [], limitations: [] },
      }),
    ).toMatchObject({ content: { explanation: [] } });
  });

  it.each(["currentState", "drivers"] as const)(
    "requires an analysis %s item",
    (field) => {
      const value = analysis();
      if (field === "currentState") value.content.currentState = [];
      else value.content.analysisModel.drivers = [];
      expect(() => parseAgentReport("analysis", value)).toThrowError(
        /at least one/,
      );
    },
  );

  it("requires at least one debate argument", () => {
    expect(() =>
      parseAgentReport("debate", {
        summary: "多方判断。",
        content: {
          arguments: [],
          responses: [],
          outlook: analysis().content.outlook,
          risks: [],
          openQuestions: [],
        },
      }),
    ).toThrowError(/arguments.*at least one/);
  });

  it("accepts a decision constraint without claiming completed mitigation", () => {
    const value = decision();
    value.content.riskResponses = [
      {
        issueId: "risk.finance.1",
        disposition: "constrained",
        reason: "纳入估值约束。",
      },
    ];
    expect(parseAgentReport("decision_draft", value)).toEqual(value);
  });

  it.each([
    [
      "negative price",
      (value: AgentReport<"decision_draft">) => {
        value.content.targetPrice!.value = -1;
      },
    ],
    [
      "nonfinite price",
      (value: AgentReport<"decision_draft">) => {
        value.content.targetPrice!.value = Number.POSITIVE_INFINITY;
      },
    ],
    [
      "missing assumptions",
      (value: AgentReport<"decision_draft">) => {
        value.content.targetPrice!.assumptions = [];
      },
    ],
    [
      "missing thesis",
      (value: AgentReport<"decision_draft">) => {
        value.content.thesis = [];
      },
    ],
  ] as const)("rejects a decision with %s", (_name, change) => {
    const value = decision();
    change(value);
    expect(() => parseAgentReport("decision_draft", value)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("allows an investment judgment without a target price", () => {
    const value = decision();
    value.content.targetPrice = null;
    expect(parseAgentReport("decision_draft", value)).toEqual(value);
  });
});
