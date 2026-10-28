import { referencePrice, type RegisteredTable } from "./reference-price.js";
import { prepareUnifiedRole } from "./agent-role.js";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  RoleDispatchContext,
  TaskInstructionSnapshot,
  TaskOperation,
} from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";
import type { EvidenceData, QuerySnapshot } from "../contracts/query.js";
import type { ResearchData } from "../contracts/research.js";
import type { DataEnvelope } from "../contracts/data.js";
import {
  assembleAnalysis,
  parseAnalysisDraft,
} from "../services/analysis-report.js";
import type { RoleProvision } from "../host/dispatch.js";
import type { RunService } from "../services/runs.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";
import { readApplicationInput } from "./research-input.js";
import {
  ROLE_PROMPT_VERSION,
  type RoleArtifactKind,
} from "./research-prompts.js";
import { scopedQueryParameters } from "./query-scope.js";
import { prepareBusinessRole } from "./business-role.js";
import { businessDraftTools } from "../host/business-draft.js";
import {
  readCollection,
  registerCollectionSources,
} from "./collection-input.js";
import type { DraftFile } from "../host/draft-file.js";
import { draftFileTools } from "../tools/draft-file.js";
import { collectionDataTool, collectionReadTool } from "./collection-tools.js";
import { researchTool } from "../tools/errors.js";
import { createPublicSearchSession } from "./public-search.js";
import {
  PUBLIC_RESEARCH_PROMPT_INPUT,
  PUBLIC_RESEARCH_TASK,
  PUBLIC_SEARCH_LIMITS,
} from "./public-research.js";
import {
  object,
  objectSchema,
  stringSchema,
  text,
  resultOutput,
} from "../tools/parameters.js";

const ROLE_TOOLS = new Set([
  "stock_read",
  "stock_data_health",
  "stock_recall",
  "stock_save_report",
]);
const SCOPED_QUERIES = new Set(["stock_data_health", "stock_recall"]);

export interface RoleServices {
  runs: RunService;
  searchPublic(
    query: string,
    exec: ToolRunContext,
    parent?: Agent,
  ): Promise<DataEnvelope<ResearchData>>;
  approvePublicSearch(
    query: string,
    exec: ToolRunContext,
    used: number,
    parent?: Agent,
  ): Promise<boolean>;
  createDraftFile(
    operation: Pick<TaskOperation, "runId" | "taskId">,
  ): DraftFile;
  createTools(
    policy: QueryToolPolicy,
    snapshots?: readonly QuerySnapshot[],
  ): ToolDefinition[];
}

export function prepareResearchRole(
  services: RoleServices,
  context: RoleDispatchContext,
  parent?: Agent,
): RoleProvision {
  const { claim, definition, scope } = context;
  const profile = readApplicationInput(services.runs, claim.runId);
  const roleVersion = services.runs.inputCatalog(claim.runId).versions.prompts
    .roles;
  if (
    roleVersion !== "11" &&
    roleVersion !== "12" &&
    roleVersion !== "13" &&
    roleVersion !== "14" &&
    roleVersion !== "15" &&
    roleVersion !== "16" &&
    roleVersion !== "17" &&
    roleVersion !== "19" &&
    roleVersion !== "20" &&
    roleVersion !== "21" &&
    roleVersion !== ROLE_PROMPT_VERSION
  )
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The recorded research role protocol is unavailable.",
    );
  if (claim.instructionRef === undefined)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The task has no recorded instruction snapshot.",
    );
  const instruction = services.runs.readInput<TaskInstructionSnapshot>(
    claim.runId,
    claim.instructionRef,
  ).instruction;
  if (
    roleVersion === ROLE_PROMPT_VERSION ||
    roleVersion === "21" ||
    roleVersion === "20" ||
    roleVersion === "19"
  )
    return prepareUnifiedRole(
      services,
      context,
      profile,
      instruction,
      parent,
      roleVersion === "19"
        ? false
        : roleVersion === "20"
          ? "legacy"
          : roleVersion === "21"
            ? "typed"
            : "handoff",
    );
  if (
    (roleVersion === "16" || roleVersion === "17") &&
    definition.executor.role !== "analyst"
  )
    return prepareBusinessRole(services, context, profile, instruction);
  const snapshot = services.runs.replaySnapshot(claim.runId);
  const collection = readCollection(services.runs, claim.runId);
  const collectionSources = registerCollectionSources(services.runs, {
    ...claim,
    identity: "stock-research:collection",
    sessionId: context.attempt.sessionId,
  });
  const file = services.createDraftFile(claim);
  const tables: RegisteredTable[] = collectionSources.flatMap(
    ({ id, sourceRef }) => {
      const envelope =
        services.runs.readEvidence<EvidenceData>(sourceRef).envelope;
      return "table" in envelope.data
        ? [{ id, sourceRef, envelope: { ...envelope, data: envelope.data } }]
        : [];
    },
  );
  if (definition.executor.role === "analyst" && roleVersion !== "11") {
    const taskTools = services.createTools(profile.policy);
    const submit = taskTools.find((tool) => tool.name === "stock_save_report")!;
    const publicRole = claim.taskId === PUBLIC_RESEARCH_TASK;
    let systemPrompt = profile.prompts.analyst;
    let dataTool = collectionDataTool(tables);
    let publicInput: object | undefined;
    if (publicRole) {
      const saved = services.runs
        .inputCatalog(claim.runId)
        .inputs.filter(({ name }) => name === PUBLIC_RESEARCH_PROMPT_INPUT);
      if (saved.length !== 1)
        throw new ResearchError(
          "VERSION_UNAVAILABLE",
          "The public analyst requires its recorded prompt.",
        );
      const value = services.runs.readInput<unknown>(
        claim.runId,
        saved[0]!.ref,
      );
      if (typeof value !== "string" || value.trim() === "")
        throw new ResearchError(
          "STORAGE_FAILED",
          "Invalid public analyst prompt.",
        );
      systemPrompt = value;
      dataTool = createPublicSearchSession(
        {
          search: (query, exec) => services.searchPublic(query, exec, parent),
          approve: (query, exec, used) =>
            services.approvePublicSearch(query, exec, used, parent),
        },
        profile.publicSearchLimit,
      ).tool;
      const savedSearches =
        snapshot?.tasks.find(({ taskId }) => taskId === claim.taskId)
          ?.evidenceRefs ?? [];
      publicInput = {
        publicSearch: {
          ...PUBLIC_SEARCH_LIMITS,
          maxSearches: profile.publicSearchLimit,
          savedSearches: savedSearches
            .map((ref) => services.runs.readEvidence<ResearchData>(ref))
            .filter(({ request }) => request.dataset === "research")
            .map(({ envelope }) => ({
              query: envelope.data.query,
              resultCount: envelope.data.items.length,
              retrievedAt: envelope.retrievedAt,
            })),
        },
      };
    }
    const assigned = new Set(collectionSources.map(({ id }) => id));
    const sources = collectionSources.map((source) =>
      Object.fromEntries(
        Object.entries(source).filter(([key]) => key !== "sourceRef"),
      ),
    );
    return {
      systemPrompt,
      tools: [
        dataTool,
        ...businessDraftTools(file),
        researchTool({
          ...submit,
          description:
            "校验并发布本任务固定JSON草稿；只检查业务结构与提交资格，不接受正文或引用参数。成功后结束本任务。",
          parameters: objectSchema({ requestId: stringSchema }),
          output: resultOutput(
            objectSchema({ status: { type: "string", const: "submitted" } }),
          ),
          async execute(value, exec) {
            const item = object(value, ["requestId"]);
            const report = parseAnalysisDraft(await file.read(exec.signal));
            const content = assembleAnalysis(
              report,
              publicRole
                ? `${scope.security.symbol} 公开信息与产品竞争分析`
                : `${scope.security.symbol} ${definition.executor.specialty}阶段分析`,
              claim.inputRefs,
              referencePrice(tables, scope),
            );
            if (publicRole) {
              const times = services.runs
                .numberContext(claim.runId)
                .evidence.filter(
                  ({ taskId, attempt }) =>
                    taskId === claim.taskId && attempt === claim.attempt,
                )
                .map(({ evidenceId }) =>
                  services.runs.readEvidence({
                    runId: claim.runId,
                    evidenceId,
                  }),
                )
                .filter(({ request }) => request.dataset === "research")
                .map(({ envelope }) => envelope.retrievedAt)
                .sort();
              if (times.length > 0)
                content.body = `公开检索截至：${times.at(-1)}\n\n${content.body}`;
            }
            await submit.execute(
              {
                requestId: text(item.requestId, "requestId"),
                contents: [content],
              },
              exec,
            );
            exec.concludeTurn();
            return { status: "submitted" };
          },
        }),
      ],
      prompt: [
        {
          type: "text",
          text: JSON.stringify({
            scope,
            task: {
              id: claim.taskId,
              specialty: definition.executor.specialty,
              instruction,
              outputKinds: definition.outputKinds,
            },
            outputContract: profile.guides.analysis,
            inputs: claim.inputRefs.map((ref) => {
              const content = services.runs.readArtifact(ref).content;
              return { title: content.title, body: content.body };
            }),
            ...(publicRole
              ? publicInput
              : {
                  collectionSources: sources,
                  coverage: {
                    availableOutsideTask:
                      collection?.packets
                        .filter(({ id }) => !assigned.has(id))
                        .map(({ id }) => id) ?? [],
                    failedTables:
                      collection?.failures.map(({ id }) => id) ?? [],
                  },
                  collectionFailures: collection?.failures ?? [],
                }),
          }),
        },
      ],
    };
  }
  const tools = services
    .createTools(profile.policy)
    .filter((tool) => ROLE_TOOLS.has(tool.name))
    .map((tool) => {
      if (tool.name === "stock_save_report")
        return researchTool({
          ...tool,
          description:
            "读取本任务固定Markdown草稿，校验并发布。错误返回具体字段和原因，草稿仍在文件中，修改后可重新提交；不接收正文或任意路径。",
          parameters: objectSchema({ requestId: stringSchema }),
          async execute(value, exec) {
            const item = object(value, ["requestId"]);
            const requestId = text(item.requestId, "requestId");
            const result = await tool.execute(
              { requestId, contents: [await file.value(exec.signal)] },
              exec,
            );
            exec.concludeTurn();
            return result;
          },
        });
      if (!SCOPED_QUERIES.has(tool.name)) return tool;
      return {
        ...tool,
        parameters: scopedQueryParameters(tool.parameters, snapshot !== null),
      };
    });
  return {
    systemPrompt: profile.prompts[definition.executor.role],
    tools: [...tools, collectionReadTool(tables), ...draftFileTools(file)],
    prompt: [
      {
        type: "text",
        text: JSON.stringify({
          scope,
          draftFile: file.path,
          task: {
            id: claim.taskId,
            attempt: claim.attempt,
            executor: definition.executor,
            instructionVersion: claim.instructionVersion,
            instruction,
            outputKinds: definition.outputKinds,
            dataRequirements: definition.dataRequirements,
          },
          outputContracts: definition.outputKinds.map(
            (kind) => profile.guides[kind as RoleArtifactKind],
          ),
          inputRefs: claim.inputRefs,
          inputs: claim.inputRefs.map((ref) => ({
            ref,
            content: services.runs.readArtifact(ref).content,
          })),
          collectionSources,
          collectionFailures: collection?.failures ?? [],
          secIssuerConfigured: Object.hasOwn(
            profile.policy.secCiks,
            scope.security.id,
          ),
          replay: snapshot,
        }),
      },
    ],
  };
}
