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
  conditions: texts("Business conditions required for this scenario."),
  expectation: text("Expected changes and their impact on the company."),
});
const outlook = object({
  horizon: text("Forecast start and end periods or time horizon."),
  baseCase: scenario,
  alternativeCases: array(scenario),
  watchPoints: texts("Specific signals of a change in the scenario."),
});
const risks = array(
  object({
    factor: text("Adverse factor."),
    impact: text("How this factor causes losses."),
    trigger: text("Conditions that trigger or materially increase the risk."),
  }),
);
const envelope = <Content extends ReportSchema>(content: Content) =>
  object({
    summary: text(
      `Conclusions, key drivers and conditions that would change the assessment for downstream roles. Target ${AGENT_SUMMARY_TARGET_CHARACTERS} Unicode characters; maximum ${AGENT_SUMMARY_MAX_CHARACTERS}.`,
    ),
    content,
  });

export const valuationRecordSchema = object({
  companyProfile: text(
    "Business type, development stage and supporting rationale.",
  ),
  valuationDate: text(
    "Research date, YYYY-MM-DD; all valueRange results are valued at this date.",
  ),
  targetDate: text(
    "Target date six months after the research date: context.valuationMethods.targetDate.",
  ),
  methods: array(
    withOptional(
      {
        methodId: text(
          "Built-in method ID. The first method is primary; others are cross-checks.",
        ),
        suitability: text(
          "Applicable business, stage and data conditions, with selection rationale.",
        ),
        valueObject: choices(
          "operating_assets",
          "common_equity",
          "per_share",
          "project",
        ),
        inputs: array(
          object({
            name: text("Input name, period and unit."),
            value: text(
              "Input value with units. Record missing inputs in limitations, not as zero.",
            ),
            kind: choices("observed", "normalized", "assumed"),
            basis: text(
              "For observations, cite the snapshot table, field and date or source location. Explain derivations for normalized and assumed values; method literature does not substantiate company inputs.",
            ),
          }),
        ),
        assumptions: texts(
          "Specific assumptions for growth, margins, reinvestment, discount rates, terminal value and share count.",
        ),
        calculation: texts(
          "Reproducible steps, including period cash flows, terminal value and discounting where applicable, and bridges from operating value to equity or per-share value.",
        ),
        valueRange: nullable(
          object({
            low: { type: "number" },
            high: { type: "number" },
            unit: text(
              "Base currency or per-share unit, e.g. CNY or USD/share, matching valueObject. Express scale in the numeric value.",
            ),
          }),
        ),
        sensitivity: texts(
          "Effects of key parameter changes or alternative scenarios.",
        ),
        limitations: texts(
          "Missing required inputs, unmet applicability conditions and their effects. Set valueRange to null when quantification is unsupported.",
        ),
      },
      {
        calculationIds: texts(
          "Saved calculation IDs; code assembles values and steps from these results.",
        ),
      },
    ),
  ),
  targetPriceBasis: nullable(
    text(
      "Manager's rationale for the target-price scenario, dividends, financing, share count and the relationship between research-date value and target-date price. Null when no target price is set.",
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
        companyProfile: text(
          "Business type, development stage and supporting rationale.",
        ),
        methods: array(
          object({
            methodId: text("Built-in method ID; the first method is primary."),
            suitability: text("Method applicability and selection rationale."),
            calculationIds: texts(
              "Research-date calculation IDs. Use [] when required inputs are missing and explain the gaps in limitations.",
            ),
            limitations: texts(
              "Missing inputs and limitations of the results.",
            ),
          }),
        ),
        targetPriceBasis: nullable(
          text(
            "Rationale for the target-date scenario, interim distributions, financing and share count. Null when no target price is set.",
          ),
        ),
      }),
    );
  if (properties.targetPrice !== undefined)
    properties.targetPrice = nullable(
      object({
        calculationId: text(
          "ID of a purpose=target_price calculation with a single per-share result.",
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
      currentState: texts(
        "Key facts, period changes and business implications; at least one item.",
      ),
      analysisModel: object({
        drivers: texts(
          "Main business variables driving outcomes; at least one item.",
        ),
        mechanism: text("How the variables interact and affect the company."),
        assumptions: texts("Assumptions required by the model."),
        alternativeExplanations: texts(
          "Other substantive explanations for the same observations.",
        ),
      }),
      outlook,
      risks,
      handoff: object({
        implications: texts("Business conclusions for downstream research."),
        openQuestions: texts(
          "Unresolved questions that affect the assessment.",
        ),
        limitations: texts(
          "Specific evidence gaps and their effects on the assessment.",
        ),
      }),
    }),
  ),
  debate: envelope(
    object({
      arguments: array(
        object({
          claim: text("This side's argument."),
          mechanism: text("How the argument affects the company or its price."),
          conditions: texts("Conditions required for the argument to hold."),
        }),
      ),
      responses: array(
        object({
          point: text("Specific opposing argument from the inputs to address."),
          response: text("This side's response and rationale."),
        }),
      ),
      outlook,
      risks,
      openQuestions: texts(
        "Unresolved questions that determine the disputed conclusion.",
      ),
    }),
  ),
  risk: envelope(
    object({
      issues: array(
        object({
          description: text("Source of loss requiring action."),
          impact: text("Risk impact and transmission mechanism."),
          trigger: text("Conditions that trigger or increase the risk."),
          constraint: text("Proposed decision constraint."),
          recommendation: text("Recommended action."),
        }),
      ),
    }),
  ),
  plan: envelope(
    object({
      questions: array(
        object({
          question: text("Research question to resolve."),
          whyItMatters: text("How the question affects the assessment."),
          nextStep: text(
            "Research steps and checkpoints for resolving the question.",
          ),
        }),
      ),
      constraints: texts("Research scope, data and execution constraints."),
    }),
  ),
  decision_draft: envelope(
    withValuation({
      thesis: texts(
        "Main investment rationale and business drivers; at least one item.",
      ),
      targetPrice: nullable(
        withOptional(
          {
            value: {
              type: "number",
              description:
                "Nonnegative target price in the security's currency for context.decisionPolicy.horizonEndDate.",
            },
            method: text("Valuation method for the target price."),
            assumptions: texts(
              "Specific valuation assumptions; at least one item.",
            ),
          },
          {
            calculationId: text(
              "ID of the calculation producing the target price.",
            ),
          },
        ),
      ),
      risks: texts("Main loss risks determining investment outcomes."),
      riskResponses: array(
        object({
          issueId: text("Risk business ID from the inputs to address."),
          disposition: choices("accepted", "constrained", "unresolved"),
          reason: text(
            "Rationale for accepting the risk, constraining the decision or leaving it unresolved.",
          ),
        }),
      ),
      invalidationConditions: texts(
        "Specific observations that change the investment thesis or trigger exposure adjustments or revaluation.",
      ),
      limitations: texts("Specific evidence gaps affecting the decision."),
    }),
  ),
  digest: envelope(
    object({
      keyPoints: texts(
        "Key facts, mechanisms and forecast conditions for the next stage.",
      ),
      disagreements: texts(
        "Unresolved substantive disagreements and their effects.",
      ),
      riskSummaries: array(
        object({
          issueId: text("Risk business ID from the inputs."),
          text: text(
            "Main risk impact, trigger conditions or decision constraints.",
          ),
        }),
      ),
      openQuestions: texts("Questions for the next stage."),
    }),
  ),
  ask: envelope(
    object({
      explanation: texts(
        "Facts and causal relationships that directly answer the user's question.",
      ),
      limitations: texts("Specific evidence gaps affecting this answer."),
    }),
  ),
  review: envelope(
    object({
      comparisons: array(
        object({
          original: text(
            "Original research conclusion or forecast conditions.",
          ),
          observed: text(
            "Subsequent observations with their periods and measurement basis.",
          ),
          implication: text(
            "How the observations validate or challenge the original conclusion.",
          ),
        }),
      ),
      lessons: texts("Specific lessons from the review."),
      followUp: texts("Research actions to take next."),
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
    horizonEndDate: text("Saved assessment horizon end date."),
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
