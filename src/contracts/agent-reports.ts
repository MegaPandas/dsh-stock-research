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
    : Schema extends {
          type: "object";
          properties: infer Properties;
          required: (infer Required)[];
        }
      ? {
          -readonly [Key in Extract<keyof Properties, Required>]: SchemaValue<
            Properties[Key]
          >;
        } & {
          -readonly [Key in Exclude<keyof Properties, Required>]?: SchemaValue<
            Properties[Key]
          >;
        }
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
    required: Object.keys(properties) as (keyof Properties & string)[],
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
function withOptional<
  const Required extends Record<string, ReportSchema>,
  const Optional extends Record<string, ReportSchema>,
>(required: Required, optional: Optional) {
  return { ...object(required), properties: { ...required, ...optional } };
}

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

export const valuationRecordSchema = object({
  companyProfile: text(
    "企业经营类型、发展阶段及判断依据；可保留多个特征及不确定性。",
  ),
  valuationDate: text("研究日，YYYY-MM-DD；valueRange均为该日的价值。"),
  targetDate: text(
    "研究日后六个月的目标日期，采用context.valuationMethods.targetDate。",
  ),
  methods: array(
    withOptional(
      {
        methodId: text("内置方法目录中的编号；首项为主模型，其余为交叉核对。"),
        suitability: text("方法适用的业务、阶段与数据条件，以及选择依据。"),
        valueObject: choices(
          "operating_assets",
          "common_equity",
          "per_share",
          "project",
        ),
        inputs: array(
          object({
            name: text("输入名称、期间和单位。"),
            value: text(
              "采用的输入值，保留单位；缺失输入写入limitations，不填零。",
            ),
            kind: choices("observed", "normalized", "assumed"),
            basis: text(
              "观察值注明快照表、字段和日期或资料定位；正常化与假设注明推导依据，不以方法文献替代公司输入证据。",
            ),
          }),
        ),
        assumptions: texts(
          "增长、利润率、再投资、折现率、终值、股数等采用的具体假设。",
        ),
        calculation: texts(
          "可复核的计算步骤；涉及折现时列逐期现金流、终值与折现，经营价值到股权或每股价值时列桥接。",
        ),
        valueRange: nullable(
          object({
            low: { type: "number" },
            high: { type: "number" },
            unit: text(
              "证券币种的基础金额或每股单位，例如CNY、USD/share；与valueObject匹配，数量级体现在数值中。",
            ),
          }),
        ),
        sensitivity: texts("关键参数或替代情景变化对结果的影响。"),
        limitations: texts(
          "缺失的必要输入、未满足的适用条件与对结果的限制；不足以量化时valueRange为null。",
        ),
      },
      {
        calculationIds: texts(
          "程序保存的估值计算编号，数值与步骤由计算结果装配。",
        ),
      },
    ),
  ),
  targetPriceBasis: nullable(
    text(
      "经理解释目标价对应的情景、股息、融资、股数及从研究日价值到目标日期价格的关系；未设目标价时为null。",
    ),
  ),
});
export type ValuationRecord = SchemaValue<typeof valuationRecordSchema>;

/** Model drafts select calculations; stored reports contain materialized results. */
export function calculatedReportSections<
  Sections extends Record<string, unknown>,
>(sections: Sections): Record<string, Sections[keyof Sections] | ReportSchema> {
  const properties = { ...sections } as Record<
    string,
    Sections[keyof Sections] | ReportSchema
  >;
  if (properties.valuation !== undefined)
    properties.valuation = nullable(
      object({
        companyProfile: text("经营类型、发展阶段与判断依据。"),
        methods: array(
          object({
            methodId: text("内置方法编号；首项为主模型。"),
            suitability: text("方法适用性与选择依据。"),
            calculationIds: texts(
              "研究日估值计算编号。缺少必要输入时使用空列表，并在limitations说明缺口。",
            ),
            limitations: texts("缺失输入与结果限制。"),
          }),
        ),
        targetPriceBasis: nullable(
          text("目标日情景、期间分配、融资与股数等依据；无目标价时为null。"),
        ),
      }),
    );
  if (properties.targetPrice !== undefined)
    properties.targetPrice = nullable(
      object({
        calculationId: text(
          "purpose=target_price且输出为单个每股结果的计算编号。",
        ),
      }),
    );
  return properties;
}

// Optional in stored reports; the current application requires it for valuation owners.
function withValuation<const Properties extends Record<string, ReportSchema>>(
  properties: Properties,
) {
  return {
    ...object(properties),
    properties: { ...properties, valuation: nullable(valuationRecordSchema) },
  };
}

export const agentReportSchemas = {
  analysis: envelope(
    withValuation({
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
    withValuation({
      thesis: texts("投资判断的主要依据与经营驱动，至少一项。"),
      targetPrice: nullable(
        withOptional(
          {
            value: {
              type: "number",
              description:
                "context.decisionPolicy.horizonEndDate对应的同币种非负目标价格。",
            },
            method: text("目标价格的估值方法。"),
            assumptions: texts("估值方法采用的具体假设，至少一项。"),
          },
          { calculationId: text("生成目标价的程序计算编号。") },
        ),
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
    thesis:
      agentReportSchemas.decision_draft.properties.content.properties.thesis,
    targetPrice:
      agentReportSchemas.decision_draft.properties.content.properties
        .targetPrice,
    risks:
      agentReportSchemas.decision_draft.properties.content.properties.risks,
    riskResponses:
      agentReportSchemas.decision_draft.properties.content.properties
        .riskResponses,
    invalidationConditions:
      agentReportSchemas.decision_draft.properties.content.properties
        .invalidationConditions,
    limitations:
      agentReportSchemas.decision_draft.properties.content.properties
        .limitations,
  }),
);
export type LegacyDecisionAgentReport = SchemaValue<
  typeof legacyDecisionReportSchema
>;
