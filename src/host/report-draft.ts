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
import { createSubmission } from "./agent-execution.js";
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
  seed?: AgentReport<Kind>,
  legacy = false,
  handoffOptions?: { seed?: StageHandoff },
  requiredContentSections: readonly string[] = [],
): {
  tools: ToolDefinition[];
  result(): Result;
  draft(): ReportDraft<Kind>;
} {
  const schema = agentReportSchemas[kind];
  const sections: Record<string, JsonSchemaNode> = {
    summary: schema.properties.summary,
    ...schema.properties.content.properties,
  };
  const sectionFormats = Object.entries(sections)
    .map(([section, value]) => `${section}: ${JSON.stringify(value)}`)
    .join("\n");
  const legacySchema = objectSchema({
    section: {
      type: "string",
      description: `章节名称，可选：${Object.keys(sections).join("、")}。`,
    },
    value: {
      description: `章节内容，使用原生 JSON 值。各章节的 JSON Schema：\n${sectionFormats}`,
    },
  });
  const writeSchema = legacy ? legacySchema : objectSchema(sections, []);
  const emptySchema = objectSchema({});
  const stored: ReportDraft<Kind> =
    seed === undefined ? { content: {} } : parseAgentReport(kind, seed);
  let handoff =
    handoffOptions?.seed === undefined
      ? undefined
      : parseStageHandoff(handoffOptions.seed);
  let handoffConfirmed = false;
  const submission = createSubmission(kind, (report, exec) =>
    handoffOptions === undefined
      ? accept(report, exec)
      : accept(report, exec, handoff),
  );
  const draft = () => structuredClone(stored);
  const tools: ToolDefinition[] = [
    researchTool({
      name: "stock_write_report",
      description: legacy
        ? "写入或替换一个报告章节。section为summary或content的一级字段名；章节仅保存为草稿。"
        : "写入或替换一个报告章节。每次只传入一个章节字段，字段值的结构见参数 Schema；仅保存为草稿。",
      parameters: writeSchema,
      output: resultOutput(objectSchema({ section: { type: "string" } })),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        validate(writeSchema, value);
        const input = value as Record<string, unknown>;
        const names = Object.keys(input);
        if (!legacy && names.length !== 1)
          throw new ResearchError(
            "INVALID_INPUT",
            `Provide exactly one report section per call; received ${names.length}: ${names.join(", ") || "(none)"}. Write separate sections in separate stock_write_report calls.`,
          );
        const section = legacy ? (input.section as string) : names[0]!;
        const sectionValue = legacy ? input.value : input[section];
        if (!Object.hasOwn(sections, section))
          throw new ResearchError(
            "INVALID_INPUT",
            `Unknown report section ${section}. Allowed sections: ${Object.keys(sections).join(", ")}.`,
          );
        const errors = validateJsonSchemaValue(
          sections[section]!,
          sectionValue,
          section,
        );
        if (errors.length > 0)
          throw new ResearchError(
            "INVALID_INPUT",
            `${errors.join("\n")}\nSchema for ${section}: ${JSON.stringify(sections[section], (key, value: unknown) => (key === "description" ? undefined : value))}`,
          );
        const content = stored.content as Record<string, unknown>;
        if (section === "summary") stored.summary = sectionValue as string;
        else content[section] = structuredClone(sectionValue);
        handoffConfirmed = false;
        return { section };
      },
    }),
    researchTool({
      name: "stock_read_report_draft",
      description: "读取当前业务草稿及尚未写入的章节；不会发布报告。",
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
      ...submission.tool,
      description: "提交完整业务草稿；仅接受空对象，成功保存后结束。",
      parameters: emptySchema,
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
        return submission.tool.execute(draft(), exec);
      },
    }),
  ];
  if (handoffOptions !== undefined)
    tools.push(
      researchTool({
        name: "stock_write_handoff",
        description: `写入或重新确认本报告的结构化交接摘要，整份JSON目标${STAGE_HANDOFF_TARGET_CHARACTERS}个Unicode字符，上限${STAGE_HANDOFF_MAX_CHARACTERS}字符。正文完成后写入，正文再次修改后须重新确认；风控risks按正文issues顺序逐项对应，不填写系统编号。`,
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
