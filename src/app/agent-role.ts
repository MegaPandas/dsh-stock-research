import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {
  RoleDispatchContext,
  TaskInstructionSnapshot,
} from "../contracts/runs.js";
import type { EvidenceData } from "../contracts/query.js";
import type { ResearchData } from "../contracts/research.js";
import { ResearchError } from "../contracts/errors.js";
import { agentInput, createSubmission } from "../host/agent-execution.js";
import { createReportDraft } from "../host/report-draft.js";
import type { AgentReport } from "../contracts/agent-reports.js";
import type { StageHandoff } from "../contracts/stage-handoff.js";
import type { RoleProvision } from "../host/dispatch.js";
import { reportMaterial } from "../report/material.js";
import { ArtifactInputs } from "../services/artifact-inputs.js";
import { assembleAgentArtifact } from "../services/business-reports.js";
import { digestRisks } from "../services/digest-inputs.js";
import type { RoleServices } from "./prepare-role.js";
import type { readApplicationInput } from "./research-input.js";
import {
  readCollection,
  registerCollectionSources,
} from "./collection-input.js";
import { collectionDataTools } from "./collection-tools.js";
import { createReportReader } from "./report-reader.js";
import {
  PUBLIC_RESEARCH_PROMPT_INPUT,
  PUBLIC_RESEARCH_TASK,
  PUBLIC_SEARCH_LIMITS,
} from "./public-research.js";
import { createPublicSearchSession } from "./public-search.js";
import { referencePrice, type RegisteredTable } from "./reference-price.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import { researchStageFeedback } from "./research-stages.js";
import { ROLE_PROMPT_VERSION } from "./research-prompts.js";
import {
  createValuationMethodTool,
  financialMetricContext,
  readValuationMethods,
  usesValuationMethods,
  valuationMethodContext,
} from "./valuation-methods.js";
import { validateRoleValuation } from "../services/valuation.js";
import { DETERMINISTIC_VALUATION_PROTOCOL } from "../contracts/valuation.js";
import { valuationCalculationCatalog } from "../services/valuation-calculations.js";
import {
  computedValuationDraftTools,
  scopedCalculationReader,
} from "./valuation-tools.js";

export function prepareUnifiedRole(
  services: RoleServices,
  context: RoleDispatchContext,
  profile: ReturnType<typeof readApplicationInput>,
  instruction: string,
  parent?: Agent,
  incremental: false | "legacy" | "typed" | "handoff" = "typed",
  previous?: {
    search?: ReturnType<typeof createPublicSearchSession>;
    report?: AgentReport;
    stageHandoff?: StageHandoff;
    publicSearchAsOf?: string;
  },
): RoleProvision {
  const { claim, definition, scope } = context;
  const kind = definition.outputKinds[0];
  if (
    definition.outputKinds.length !== 1 ||
    !["analysis", "debate", "risk", "plan", "decision_draft"].includes(kind!)
  )
    throw new ResearchError(
      "INVALID_INPUT",
      "A research role requires one supported business report kind.",
    );
  const reportKind = kind as
    "analysis" | "debate" | "risk" | "plan" | "decision_draft";
  const reports = new ArtifactInputs(services.runs).closure(claim.inputRefs);
  const reader = createReportReader(reports, claim.inputRefs);
  const collected = registerCollectionSources(services.runs, {
    ...claim,
    identity: "stock-research:collection",
    sessionId: context.attempt.sessionId,
  });
  const tables: RegisteredTable[] = collected.flatMap(({ id, sourceRef }) => {
    const envelope =
      services.runs.readEvidence<EvidenceData>(sourceRef).envelope;
    return "table" in envelope.data
      ? [{ id, sourceRef, envelope: { ...envelope, data: envelope.data } }]
      : [];
  });
  const priceReport = reports.find(({ content }) =>
    content.claims.some(({ id }) => id === "market.close"),
  );
  const priceClaim = priceReport?.content.claims.find(
    ({ id }) => id === "market.close",
  );
  const price =
    priceReport && priceClaim
      ? { artifact: priceReport.ref, claim: priceClaim }
      : null;
  const publicRole = claim.taskId === PUBLIC_RESEARCH_TASK;
  let systemPrompt = profile.prompts[definition.executor.role];
  const tools = reader.catalog.length === 0 ? [] : [reader.tool];
  const details: Record<string, unknown> = {};
  const valuationMethods =
    usesValuationMethods(claim.taskId) &&
    ["24", ROLE_PROMPT_VERSION].includes(
      services.runs.inputCatalog(claim.runId).versions.prompts.roles!,
    )
      ? readValuationMethods(services.runs, claim.runId)
      : undefined;
  if (valuationMethods !== undefined) {
    systemPrompt += `\n${profile.prompts.valuation}`;
    tools.push(createValuationMethodTool(valuationMethods));
    details.valuationMethods = valuationMethodContext(valuationMethods, scope);
  }
  const computedValuation =
    valuationMethods !== undefined &&
    services.runs.inputCatalog(claim.runId).versions.prompts.roles ===
      DETERMINISTIC_VALUATION_PROTOCOL;
  if (computedValuation) {
    const collection = readCollection(services.runs, claim.runId);
    if (collection !== null)
      details.financialMetrics = financialMetricContext(collection.packets);
    const calculationTools = services.createTools(profile.policy);
    tools.push(
      calculationTools.find(
        ({ name }) => name === "stock_calculate_valuation",
      )!,
    );
    tools.push(
      scopedCalculationReader(
        calculationTools.find(
          ({ name }) => name === "stock_read_valuation_calculation",
        )!,
        claim.runId,
      ),
    );
    details.valuationCalculations = valuationCalculationCatalog(
      services.runs,
      claim.runId,
    );
  }
  let search = previous?.search;
  let publicSearchAsOf = previous?.publicSearchAsOf;
  const revisionFeedback = researchStageFeedback(
    services.runs,
    claim.runId,
    claim.taskId,
  );
  if (revisionFeedback !== undefined)
    details.revisionFeedback = revisionFeedback;
  if (publicRole) {
    const saved = services.runs
      .inputCatalog(claim.runId)
      .inputs.filter(({ name }) => name === PUBLIC_RESEARCH_PROMPT_INPUT);
    if (saved.length !== 1)
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "The public analyst requires its recorded prompt.",
      );
    const prompt = services.runs.readInput<unknown>(claim.runId, saved[0]!.ref);
    if (typeof prompt !== "string" || prompt.trim() === "")
      throw new ResearchError(
        "STORAGE_FAILED",
        "Invalid public analyst prompt.",
      );
    systemPrompt = prompt;
    search ??= createPublicSearchSession(
      {
        search: (query, exec) => services.searchPublic(query, exec, parent),
        approve: (query, exec, used) =>
          services.approvePublicSearch(query, exec, used, parent),
      },
      profile.publicSearchLimit,
    );
    tools.push(search.tool);
    const replay = services.runs
      .replaySnapshot(claim.runId)
      ?.tasks.find(({ taskId }) => taskId === claim.taskId);
    details.publicSearch = {
      ...PUBLIC_SEARCH_LIMITS,
      maxSearches: profile.publicSearchLimit,
      savedSearches: (replay?.evidenceRefs ?? [])
        .map((ref) => services.runs.readEvidence<ResearchData>(ref))
        .filter(({ request }) => request.dataset === "research")
        .map(({ envelope }) => ({
          query: envelope.data.query,
          resultCount: envelope.data.items.length,
          retrievedAt: envelope.retrievedAt,
        })),
    };
  } else if (definition.executor.role === "analyst") {
    if (tables.length > 0) tools.push(...collectionDataTools(tables));
    const collection = readCollection(services.runs, claim.runId);
    const assigned = new Set(collected.map(({ id }) => id));
    details.coverage = {
      availableOutsideTask:
        collection?.packets
          .filter(({ id }) => !assigned.has(id))
          .map(({ id }) => id) ?? [],
      failedTables: collection?.failures.map(({ id }) => id) ?? [],
    };
    details.collectionFailures = collection?.failures ?? [];
  }
  const labels = {
    analysis: publicRole
      ? "公开信息与产品竞争分析"
      : `${definition.executor.specialty}阶段分析`,
    debate: definition.executor.specialty === "bull" ? "多方讨论" : "空方讨论",
    risk: "风控分析",
    plan: "研究计划",
    decision_draft: "经理决策",
  };
  const save = services
    .createTools(profile.policy)
    .find(({ name }) => name === "stock_save_report")!;
  let submittedReport: AgentReport | undefined;
  let submittedHandoff: StageHandoff | undefined;
  const accept = async (
    report: AgentReport<typeof reportKind>,
    exec: ToolRunContext,
    stageHandoff?: StageHandoff,
  ) => {
    if (valuationMethods !== undefined)
      validateRoleValuation(
        report,
        claim.taskId,
        scope,
        valuationMethods.methods.map(({ id }) => id),
      );
    const artifact = assembleAgentArtifact(
      reportKind,
      report,
      {
        taskId: claim.taskId,
        specialty: definition.executor.specialty,
        title: `${scope.security.symbol} ${labels[reportKind]}`,
        inputRefs: reports.map(({ ref }) => ref),
        currency: scope.security.currency,
        referencePrice: price,
        scope,
      },
      reportKind === "analysis" ? referencePrice(tables, scope) : [],
      stageHandoff,
    );
    if (publicRole) {
      const times = services.runs
        .numberContext(claim.runId)
        .evidence.filter(
          ({ taskId, attempt }) =>
            taskId === claim.taskId && attempt === claim.attempt,
        )
        .map(({ evidenceId }) =>
          services.runs.readEvidence({ runId: claim.runId, evidenceId }),
        )
        .filter(({ request }) => request.dataset === "research")
        .map(({ envelope }) => envelope.retrievedAt)
        .sort();
      publicSearchAsOf = [
        ...times,
        ...(publicSearchAsOf === undefined ? [] : [publicSearchAsOf]),
      ]
        .sort()
        .at(-1);
      if (
        publicSearchAsOf !== undefined &&
        artifact.kind === "analysis" &&
        "schemaVersion" in artifact.payload &&
        artifact.payload.schemaVersion === 3
      ) {
        artifact.payload.publicSearchAsOf = publicSearchAsOf;
        artifact.body = `公开检索截至：${artifact.payload.publicSearchAsOf}\n\n${artifact.body}`;
      }
    }
    submittedReport = report;
    submittedHandoff = stageHandoff;
    return save.execute(
      { requestId: `submit:${exec.callId}`, contents: [artifact] },
      exec,
    );
  };
  const submission = incremental
    ? createReportDraft(
        reportKind,
        accept,
        previous?.report as AgentReport<typeof reportKind> | undefined,
        incremental === "legacy",
        incremental === "handoff"
          ? previous?.stageHandoff === undefined
            ? {}
            : { seed: previous.stageHandoff }
          : undefined,
        valuationMethods !== undefined &&
          (claim.taskId === "analysis.fundamentals" ||
            reportKind === "decision_draft")
          ? ["valuation"]
          : [],
      )
    : createSubmission(reportKind, accept);
  return {
    systemPrompt,
    tools: [
      ...tools,
      ...("tools" in submission
        ? computedValuation
          ? computedValuationDraftTools(
              submission.tools,
              services.runs,
              claim.runId,
            )
          : submission.tools
        : [submission.tool]),
    ],
    followup(next, { resumeSearch }) {
      if (resumeSearch) search?.resume();
      return prepareUnifiedRole(
        services,
        next,
        profile,
        services.runs.readInput<TaskInstructionSnapshot>(
          next.claim.runId,
          next.claim.instructionRef!,
        ).instruction,
        parent,
        incremental,
        {
          ...(search === undefined ? {} : { search }),
          report: submittedReport!,
          ...(submittedHandoff === undefined
            ? {}
            : { stageHandoff: submittedHandoff }),
          ...(publicSearchAsOf === undefined ? {} : { publicSearchAsOf }),
        },
      );
    },
    prompt: agentInput({
      scope,
      task: {
        id: claim.taskId,
        role: definition.executor.specialty,
        objective: instruction,
      },
      context: {
        materials: claim.inputRefs.map((ref) =>
          reportMaterial(services.runs.readArtifact(ref).content),
        ),
        dataCatalog: collected.map((source) =>
          Object.fromEntries(
            Object.entries(source).filter(([key]) => key !== "sourceRef"),
          ),
        ),
        reportCatalog: reader.catalog,
        requiredRisks: digestRisks(reports).map(({ issueId }) => ({ issueId })),
        referencePrice:
          price === null
            ? null
            : { value: price.claim.value, unit: price.claim.unit },
        ...(reportKind === "decision_draft"
          ? { decisionPolicy: decisionPolicy(scope.date) }
          : {}),
        ...details,
      },
    }),
  };
}
