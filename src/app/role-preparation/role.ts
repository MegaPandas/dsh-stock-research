import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type {
  RoleDispatchContext,
  TaskInstructionSnapshot,
} from "../../contracts/runs.js";
import type { EvidenceData } from "../../contracts/query.js";
import { ResearchError } from "../../contracts/errors.js";
import { agentInput } from "../../host/agent-protocol/input.js";
import type { RoleProvision } from "../../host/dispatch/index.js";
import { reportMaterial } from "../../report/material.js";
import { ArtifactInputs } from "../../services/artifact-inputs.js";
import { inheritRisks } from "../../artifacts/risks.js";
import type { RoleServices } from "./services.js";
import type { readApplicationInput } from "../research-input.js";
import {
  readCollection,
  registerCollectionSources,
} from "../collection-input.js";
import { collectionDataTools } from "../collection-tools.js";
import { createReportReader } from "../report-reader.js";
import { PUBLIC_RESEARCH_TASK } from "../public-research.js";
import type { RegisteredTable } from "../reference-price.js";
import { decisionPolicy } from "../../valuation/rating-policy.js";
import { researchStageFeedback } from "../research-stages.js";
import { readResearchModels } from "../research-models.js";
import {
  preparePublicSearch,
  type PublicSearchSession,
} from "./public-search.js";
import {
  prepareRoleReport,
  type RoleReportKind,
  type RoleReportSeed,
} from "./report.js";
import { prepareRoleValuation } from "./valuation.js";

function followupInput(
  instruction: string,
  resumeSearch: boolean | undefined,
): ContentBlock[] {
  const lines = [
    instruction,
    "Use the existing conversation to complete the requested additions or revisions, check the draft and submit it.",
  ];
  if (resumeSearch !== undefined)
    lines.push(
      resumeSearch
        ? "The primary agent has resumed search. Previous usage and limits remain; each over-budget search requires user approval."
        : "Search pause and usage remain unchanged.",
    );
  return [{ type: "text", text: lines.join("\n") }];
}

export function prepareUnifiedRole(
  services: RoleServices,
  context: RoleDispatchContext,
  profile: ReturnType<typeof readApplicationInput>,
  instruction: string,
  parent?: Agent,
  continuation?: {
    search?: PublicSearchSession;
    submission: RoleReportSeed;
    resumeSearch: boolean;
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
  const reportKind = kind as RoleReportKind;
  const inputs = new ArtifactInputs(services.runs);
  const roots = claim.inputRefs.map((ref) => inputs.artifact(ref));
  const fixedInputs = inputs.closure(claim.inputRefs);
  const reports = fixedInputs.filter(
    ({ content }) => content.kind !== "collection",
  );
  const reader = createReportReader(reports, claim.inputRefs);
  const captures = roots.flatMap(({ content }) =>
    content.kind === "collection" ? [content.payload] : [],
  );
  const collection = readCollection(
    services.runs,
    claim.runId,
    captures.map(({ snapshot }) => snapshot),
  );
  const collected = registerCollectionSources(
    services.runs,
    {
      ...claim,
      identity: "stock-research:collection",
      sessionId: context.attempt.sessionId,
    },
    collection,
    new Map(
      captures.flatMap(({ snapshot, capturedAt }) =>
        snapshot.packets.map(({ id }) => [id, capturedAt] as const),
      ),
    ),
  );
  const tables: RegisteredTable[] = collected.flatMap(({ id, sourceRef }) => {
    const { envelope, snapshotAt } =
      services.runs.readEvidence<EvidenceData>(sourceRef);
    return "table" in envelope.data
      ? [
          {
            id,
            sourceRef,
            envelope: { ...envelope, data: envelope.data },
            ...(snapshotAt === undefined ? {} : { snapshotAt }),
          },
        ]
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
  const valuation = prepareRoleValuation(services, context, collection);
  const details: Record<string, unknown> = { ...valuation?.details };
  if (valuation !== undefined) {
    systemPrompt += `\n${profile.prompts.valuation}`;
    tools.push(...valuation.tools);
  }
  let search = continuation?.search;
  const revisionFeedback = researchStageFeedback(
    services.runs,
    claim.runId,
    claim.taskId,
  );
  if (revisionFeedback !== undefined)
    details.revisionFeedback = revisionFeedback;
  if (publicRole) {
    const prepared = preparePublicSearch(
      services,
      context,
      profile.publicSearchLimit,
      parent,
      search,
    );
    systemPrompt = prepared.systemPrompt;
    search = prepared.session;
    tools.push(search.tool);
    details.publicSearch = prepared.details;
  } else if (definition.executor.role === "analyst") {
    if (tables.length > 0) tools.push(...collectionDataTools(tables));
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
  const submission = prepareRoleReport(
    services,
    context,
    reportKind,
    {
      inputRefs: fixedInputs.map(({ ref }) => ref),
      tables,
      price,
      ...(valuation === undefined
        ? {}
        : { valuationMethods: valuation.methods }),
      publicRole,
    },
    continuation?.submission,
  );
  const agentOptions = readResearchModels(services.runs, claim.runId)?.research;
  return {
    ...(agentOptions === undefined ? {} : { agentOptions }),
    systemPrompt,
    tools: [...tools, ...submission.tools],
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
        {
          ...(search === undefined ? {} : { search }),
          submission: submission.continuation(),
          resumeSearch,
        },
      );
    },
    prompt:
      continuation === undefined
        ? agentInput({
            scope,
            task: {
              id: claim.taskId,
              role: definition.executor.specialty,
              objective: instruction,
            },
            context: {
              materials: roots
                .filter(({ content }) => content.kind !== "collection")
                .map(({ content }) => reportMaterial(content)),
              dataCatalog: collected.map((source) =>
                Object.fromEntries(
                  Object.entries(source).filter(([key]) => key !== "sourceRef"),
                ),
              ),
              reportCatalog: reader.catalog,
              requiredRisks: inheritRisks(reports).map(({ issueId }) => ({
                issueId,
              })),
              referencePrice:
                price === null
                  ? null
                  : { value: price.claim.value, unit: price.claim.unit },
              ...(reportKind === "decision_draft"
                ? { decisionPolicy: decisionPolicy(scope.date) }
                : {}),
              ...details,
            },
          })
        : followupInput(
            instruction,
            publicRole ? continuation.resumeSearch : undefined,
          ),
  };
}
