interface ReportSchema {
  type?: "object" | "array" | "string" | "number" | "null";
  properties?: Record<string, ReportSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ReportSchema;
  enum?: string[];
  oneOf?: ReportSchema[];
  description?: string;
}

type SchemaValue<Schema> = Schema extends { oneOf: (infer Branch)[] }
  ? SchemaValue<Branch>
  : Schema extends { enum: (infer Value)[] }
    ? Value
    : Schema extends { type: "object"; properties: infer Properties }
      ? { -readonly [Key in keyof Properties]: SchemaValue<Properties[Key]> }
      : Schema extends { type: "array"; items: infer Item }
        ? SchemaValue<Item>[]
        : Schema extends { type: "string" }
          ? string
          : Schema extends { type: "number" }
            ? number
            : Schema extends { type: "null" }
              ? null
              : never;

function object<const Properties extends Record<string, ReportSchema>>(
  properties: Properties,
) {
  return {
    type: "object" as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const text = (description: string) => ({
  type: "string" as const,
  description,
});
const array = <Item extends ReportSchema>(items: Item) => ({
  type: "array" as const,
  items,
});
const texts = (description: string) => array(text(description));
const choices = <const Values extends string[]>(...values: Values) => ({
  type: "string" as const,
  enum: values,
});
const nullable = <Value extends ReportSchema>(value: Value) => ({
  oneOf: [value, { type: "null" as const }],
});

export const AGENT_SUMMARY_MAX_CHARACTERS = 600;
export const AGENT_SUMMARY_TARGET_CHARACTERS = AGENT_SUMMARY_MAX_CHARACTERS / 2;
export const DIGEST_MAX_CHARACTERS = 9000;
export const DIGEST_TARGET_CHARACTERS = DIGEST_MAX_CHARACTERS / 2;

const scenario = object({
  conditions: texts("路径成立所需的业务条件。"),
  expectation: text("预期变化及其对公司的影响。"),
});
const outlook = object({
  horizon: text("预测的起止期间或时间跨度。"),
  baseCase: scenario,
  alternativeCases: array(scenario),
  watchPoints: texts("用于观察路径变化的具体信号。"),
});
const risks = array(
  object({
    factor: text("不利因素。"),
    impact: text("不利因素造成损失的作用机制。"),
    trigger: text("风险发生或明显上升的条件。"),
  }),
);
const envelope = <Content extends ReportSchema>(content: Content) =>
  object({
    summary: text(
      `交给下游的结论、主要驱动及改变判断的条件，目标${AGENT_SUMMARY_TARGET_CHARACTERS}个Unicode字符，上限${AGENT_SUMMARY_MAX_CHARACTERS}字符。`,
    ),
    content,
  });

export const agentReportSchemas = {
  analysis: envelope(
    object({
      currentState: texts("关键事实、期间变化及其业务含义，至少一项。"),
      analysisModel: object({
        drivers: texts("决定结果的主要业务变量，至少一项。"),
        mechanism: text("变量之间的作用关系及公司影响。"),
        assumptions: texts("模型成立所需的假设。"),
        alternativeExplanations: texts("对同一观察的其他实质解释。"),
      }),
      outlook,
      risks,
      handoff: object({
        implications: texts("后续研究应采用的业务结论。"),
        openQuestions: texts("尚需解决且会影响判断的问题。"),
        limitations: texts("具体材料缺口及其对判断的影响。"),
      }),
    }),
  ),
  debate: envelope(
    object({
      arguments: array(
        object({
          claim: text("本方论点。"),
          mechanism: text("论点影响公司或价格的作用机制。"),
          conditions: texts("论点成立的条件。"),
        }),
      ),
      responses: array(
        object({
          point: text("输入中需要回应的对方具体论点。"),
          response: text("本方回应及其理由。"),
        }),
      ),
      outlook,
      risks,
      openQuestions: texts("决定争议结论的未决问题。"),
    }),
  ),
  risk: envelope(
    object({
      issues: array(
        object({
          description: text("需要处置的损失来源。"),
          impact: text("风险的影响及传导机制。"),
          trigger: text("风险发生或上升的条件。"),
          constraint: text("建议纳入决策的约束。"),
          recommendation: text("建议采取的处置。"),
        }),
      ),
    }),
  ),
  plan: envelope(
    object({
      questions: array(
        object({
          question: text("需要解决的研究问题。"),
          whyItMatters: text("该问题如何影响研究判断。"),
          nextStep: text("解决问题的研究路径及检查点。"),
        }),
      ),
      constraints: texts("研究范围、数据与执行条件。"),
    }),
  ),
  decision_draft: envelope(
    object({
      thesis: texts("投资判断的主要依据与经营驱动，至少一项。"),
      targetPrice: nullable(
        object({
          value: {
            type: "number",
            description:
              "context.decisionPolicy.horizonEndDate对应的同币种非负目标价格。",
          },
          method: text("目标价格的估值方法。"),
          assumptions: texts("估值方法采用的具体假设，至少一项。"),
        }),
      ),
      risks: texts("决定投资结果的主要损失风险。"),
      riskResponses: array(
        object({
          issueId: text("输入中需要回应的风险业务编号。"),
          disposition: choices("accepted", "constrained", "unresolved"),
          reason: text("接受风险、纳入决策约束或保留未决的理由。"),
        }),
      ),
      invalidationConditions: texts(
        "改变投资判断或触发投资者调整敞口、重估的具体观察条件。",
      ),
      limitations: texts("影响决策的具体材料缺口。"),
    }),
  ),
  digest: envelope(
    object({
      keyPoints: texts("供下一阶段使用的关键事实、机制与预测条件。"),
      disagreements: texts("尚未解决的实质分歧及其影响。"),
      riskSummaries: array(
        object({
          issueId: text("输入中的风险业务编号。"),
          text: text("风险的主要影响、触发条件或决策约束。"),
        }),
      ),
      openQuestions: texts("交给下一阶段的问题。"),
    }),
  ),
  ask: envelope(
    object({
      explanation: texts("直接解释用户问题的事实与作用关系。"),
      limitations: texts("影响当前答案的具体材料缺口。"),
    }),
  ),
  review: envelope(
    object({
      comparisons: array(
        object({
          original: text("原研究的判断或预测条件。"),
          observed: text("后续实际观察，包含对应期间与口径。"),
          implication: text("后续观察对原判断的检验结果。"),
        }),
      ),
      lessons: texts("复盘得出的具体经验。"),
      followUp: texts("后续需要采取的研究行动。"),
    }),
  ),
  coordinator: envelope(object({})),
};

export type AgentReportKind = keyof typeof agentReportSchemas;
export type AgentReport<Kind extends AgentReportKind = AgentReportKind> =
  SchemaValue<(typeof agentReportSchemas)[Kind]>;
export type AgentReportContent<Kind extends AgentReportKind> =
  AgentReport<Kind>["content"];

/** Recorded role protocol 18 included the model's rating and horizon. */
export const legacyDecisionReportSchema = envelope(
  object({
    rating: nullable(
      choices("strong_buy", "buy", "hold", "sell", "strong_sell"),
    ),
    horizonEndDate: text("已保存的判断期限。"),
    ...agentReportSchemas.decision_draft.properties.content.properties,
  }),
);
export type LegacyDecisionAgentReport = SchemaValue<
  typeof legacyDecisionReportSchema
>;
