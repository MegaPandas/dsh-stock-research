import {
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import {
  agentReportSchemas,
  type AgentReport,
  type AgentReportContent,
  type AgentReportKind,
} from "../contracts/agent-reports.js";
import { ResearchError } from "../contracts/errors.js";
import { parseAgentReport } from "../services/agent-reports.js";
import { researchTool } from "../tools/errors.js";
import { objectSchema, resultOutput } from "../tools/parameters.js";
import { createSubmissionSession } from "./agent-execution.js";
import {
  stageHandoffSchema,
  STAGE_HANDOFF_MAX_CHARACTERS,
  STAGE_HANDOFF_TARGET_CHARACTERS,
  type StageHandoff,
} from "../contracts/stage-handoff.js";
import { parseStageHandoff } from "../services/stage-handoff.js";

export type ReportDraft<Kind extends AgentReportKind> = {
  summary?: string;
  content: Partial<AgentReportContent<Kind>>;
};

/** Input sections are validated before resolving references into stored report sections. */
export interface ReportDraftInput {
  sections: Record<string, JsonSchemaNode>;
  resolve(updates: Record<string, unknown>): Record<string, unknown>;
}

function validate(schema: JsonSchemaNode, value: unknown): void {
  const errors = validateJsonSchemaValue(schema, value, "reportDraft");
  if (errors.length > 0)
    throw new ResearchError("INVALID_INPUT", errors.join("\n"));
}

/** A role edits business sections locally and publishes only a complete report. */
export function createReportDraft<Kind extends AgentReportKind, Result>(
  kind: Kind,
  accept: (
    report: AgentReport<Kind>,
    exec: ToolRunContext,
    handoff?: StageHandoff,
  ) => Result | Promise<Result>,
  options: {
    seed?: AgentReport<Kind>;
    handoff?: { seed?: StageHandoff };
    requiredContentSections?: readonly string[];
    input?: ReportDraftInput;
  } = {},
): {
  tools: ToolDefinition[];
  result(): Result;
  draft(): ReportDraft<Kind>;
} {
  const {
    seed,
    handoff: handoffOptions,
    requiredContentSections = [],
    input: inputContract,
  } = options;
  const schema = agentReportSchemas[kind];
  const sections: Record<string, JsonSchemaNode> = inputContract?.sections ?? {
    summary: schema.properties.summary,
    ...schema.properties.content.properties,
  };
  const writeSchema = {
    ...objectSchema(sections, []),
    description: "Report sections to update; {} makes no changes.",
  };
  const emptySchema = objectSchema({});
  const stored: ReportDraft<Kind> =
    seed === undefined ? { content: {} } : parseAgentReport(kind, seed);
  let handoff =
    handoffOptions?.seed === undefined
      ? undefined
      : parseStageHandoff(handoffOptions.seed);
  let handoffConfirmed = false;
  const submission = createSubmissionSession(kind, (report, exec) =>
    handoffOptions === undefined
      ? accept(report, exec)
      : accept(report, exec, handoff),
  );
  const draft = () => structuredClone(stored);
  const tools: ToolDefinition[] = [
    researchTool({
      name: "stock_write_report",
      description:
        "Write or replace supplied draft sections atomically; omitted sections stay unchanged. {} makes no changes.",
      parameters: writeSchema,
      output: resultOutput(
        objectSchema({
          sections: { type: "array", items: { type: "string" } },
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        validate(writeSchema, value);
        const input = value as Record<string, unknown>;
        const names = Object.keys(input);
        const updates = structuredClone(
          inputContract === undefined ? input : inputContract.resolve(input),
        );
        const content = stored.content as Record<string, unknown>;
        for (const [section, sectionValue] of Object.entries(updates))
          if (section === "summary") stored.summary = sectionValue as string;
          else content[section] = sectionValue;
        if (names.length > 0) handoffConfirmed = false;
        return { sections: names };
      },
    }),
    researchTool({
      name: "stock_read_report_draft",
      description: "Read the current draft and missing sections.",
      parameters: emptySchema,
      output: resultOutput(
        objectSchema({
          draft: objectSchema(
            {
              summary: schema.properties.summary,
              content: objectSchema(schema.properties.content.properties, []),
            },
            ["content"],
          ),
          missingSections: { type: "array", items: { type: "string" } },
          ...(handoffOptions === undefined
            ? {}
            : {
                stageHandoff: {
                  oneOf: [stageHandoffSchema, { type: "null" as const }],
                },
                handoffConfirmed: { type: "boolean" as const },
              }),
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        validate(emptySchema, value);
        return {
          draft: draft(),
          missingSections: [
            "summary",
            ...schema.properties.content.required,
            ...requiredContentSections,
          ].filter((section) =>
            section === "summary"
              ? stored.summary === undefined
              : !Object.hasOwn(stored.content, section),
          ),
          ...(handoffOptions === undefined
            ? {}
            : { stageHandoff: handoff ?? null, handoffConfirmed }),
        };
      },
    }),
    researchTool({
      name: "stock_submit",
      description:
        "Submit the complete draft with {}; successful saving ends the current execution.",
      parameters: emptySchema,
      output: resultOutput(
        objectSchema({ status: { type: "string", const: "submitted" } }),
      ),
      execute(value, exec) {
        exec.signal.throwIfAborted();
        validate(emptySchema, value);
        if (handoffOptions !== undefined) {
          if (handoff === undefined || !handoffConfirmed)
            throw new ResearchError(
              "INVALID_INPUT",
              "Write or reconfirm stageHandoff with stock_write_handoff after the final report edit before submitting.",
            );
          if (
            kind === "risk" &&
            handoff.risks.length !==
              (stored.content as Partial<AgentReportContent<"risk">>).issues
                ?.length
          )
            throw new ResearchError(
              "INVALID_INPUT",
              "stageHandoff.risks must have exactly one summary for each report issue, in the same order.",
            );
        }
        return submission.submit(draft(), exec);
      },
    }),
  ];
  if (handoffOptions !== undefined)
    tools.push(
      researchTool({
        name: "stock_write_handoff",
        description: `Write or reconfirm the handoff summary; target ${STAGE_HANDOFF_TARGET_CHARACTERS} Unicode characters for the whole JSON, maximum ${STAGE_HANDOFF_MAX_CHARACTERS}. Reconfirm after editing the report. For risk reports, risks correspond one-to-one with report issues in order; the system assigns IDs.`,
        parameters: stageHandoffSchema,
        output: resultOutput(
          objectSchema({ status: { type: "string", const: "saved" } }),
        ),
        async execute(value, exec) {
          exec.signal.throwIfAborted();
          handoff = parseStageHandoff(value);
          handoffConfirmed = true;
          return { status: "saved" };
        },
      }),
    );
  return { tools, result: submission.result, draft };
}
