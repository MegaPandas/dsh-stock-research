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
import type { SubmitReport } from "../host/report-submission.js";
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
import {
  collectionDataTools,
  collectionReadTools,
} from "./collection-tools.js";
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
  artifactRefSchema,
} from "../tools/parameters.js";

const ROLE_TOOLS = new Set([
  "stock_read_run",
  "stock_read_artifact",
  "stock_read_evidence",
  "stock_data_health",
  "stock_recall",
]);
const SCOPED_QUERIES = new Set(["stock_data_health", "stock_recall"]);

export interface RoleServices {
  runs: RunService;
  submitReport: SubmitReport;
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
    roleVersion !== "22" &&
    roleVersion !== "23" &&
    roleVersion !== "24" &&
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
    roleVersion === "23" ||
    roleVersion === "24" ||
    roleVersion === "22" ||
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
    const publicRole = claim.taskId === PUBLIC_RESEARCH_TASK;
    let systemPrompt = profile.prompts.analyst;
    let dataTools = collectionDataTools(tables);
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
      dataTools = [
        createPublicSearchSession(
          {
            search: (query, exec) => services.searchPublic(query, exec, parent),
            approve: (query, exec, used) =>
              services.approvePublicSearch(query, exec, used, parent),
          },
          profile.publicSearchLimit,
        ).tool,
      ];
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
        ...dataTools,
        ...businessDraftTools(file),
        researchTool({
          name: "stock_save_report",
          description:
            "Validate the business structure and submission eligibility of this task's fixed JSON draft, then publish it. Accepts no body or reference arguments. Success ends the task.",
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
            services.submitReport(
              [content],
              text(item.requestId, "requestId"),
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
      if (!SCOPED_QUERIES.has(tool.name)) return tool;
      return {
        ...tool,
        parameters: scopedQueryParameters(tool.parameters, snapshot !== null),
      };
    });
  return {
    systemPrompt: profile.prompts[definition.executor.role],
    tools: [
      ...tools,
      researchTool({
        name: "stock_save_report",
        description:
          "Read, validate and publish this task's fixed Markdown draft. Errors identify fields and reasons; edit the retained draft and resubmit. Accepts no body or path arguments.",
        parameters: objectSchema({ requestId: stringSchema }),
        output: resultOutput(
          objectSchema({
            runId: stringSchema,
            taskId: stringSchema,
            attempt: { type: "integer" },
            refs: { type: "array", items: artifactRefSchema },
          }),
        ),
        async execute(value, exec) {
          const item = object(value, ["requestId"]);
          const result = services.submitReport(
            [await file.value(exec.signal)],
            text(item.requestId, "requestId"),
            exec,
          );
          exec.concludeTurn();
          return result;
        },
      }),
      ...collectionReadTools(tables),
      ...draftFileTools(file),
    ],
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
