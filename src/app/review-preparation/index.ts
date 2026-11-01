import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../../contracts/data.js";
import type { MemoryRef } from "../../contracts/memory.js";
import type { QueryMemoryReturns } from "../../contracts/memory-service.js";
import type { QueryPolicy } from "../../contracts/query.js";
import type { RunReader } from "../../contracts/run-access.js";
import type { SourceHealth } from "../../contracts/sources.js";
import { agentInput } from "../../host/agent-protocol/input.js";
import { createSubmission } from "../../host/agent-protocol/submission.js";
import { ArtifactInputs } from "../../services/artifact-inputs.js";
import { createReportReader } from "../report-reader.js";
import type { ReviewInput } from "../review-input.js";
import { ReviewSession, type ReviewSessionPorts } from "../review-session.js";
import { createReviewTools } from "./tools.js";

export interface ReviewRequestPorts {
  runs: Pick<
    RunReader,
    "view" | "readArtifact" | "readEvidence" | "readInputs" | "numberContext"
  >;
  memory: ReviewSessionPorts["memory"];
  queryReturns: QueryMemoryReturns;
  sourceHealth(scope: ResearchScope): readonly SourceHealth[];
  policy: QueryPolicy;
  recallTool(): ToolDefinition;
  healthTool(): ToolDefinition;
}
export interface PreparedReview {
  scope: ResearchScope;
  tools: readonly ToolDefinition[];
  input: ReturnType<typeof agentInput>;
  result(): { ref: MemoryRef; outcome: string; note: string };
}

export function prepareReviewRequest(
  ports: ReviewRequestPorts,
  input: ReviewInput,
  signal: AbortSignal,
): PreparedReview {
  signal.throwIfAborted();
  const inputs = new ArtifactInputs(ports.runs);
  const currentReports = ports.runs
    .view({ runId: input.runId })
    .tasks.flatMap(({ outputRefs }) => outputRefs)
    .map((ref) => inputs.artifact(ref));
  const reports = inputs
    .closure(currentReports.map(({ ref }) => ref))
    .filter(({ content }) => content.kind !== "collection");
  const reader = createReportReader(reports, []);
  const selectedDecision =
    currentReports.find(({ content }) => content.kind === "decision") ??
    currentReports.find(({ content }) => content.kind === "decision_draft");
  let referencePrice: { value: number; unit: string } | null = null;
  if (
    selectedDecision?.content.kind === "decision" ||
    selectedDecision?.content.kind === "decision_draft"
  ) {
    const { basePrice } = selectedDecision.content.payload;
    if (basePrice !== null) {
      const local =
        selectedDecision.content.kind === "decision"
          ? selectedDecision.content.payload.draftRef
          : selectedDecision.ref;
      const { claim } = inputs.number(basePrice, local);
      referencePrice = { value: claim.value, unit: claim.unit };
    }
  }
  const session = new ReviewSession(
    input,
    currentReports
      .filter(
        ({ content }) =>
          content.kind === "decision" || content.kind === "report",
      )
      .map(({ ref }) => ref),
    { memory: ports.memory, queryReturns: ports.queryReturns },
  );
  const submission = createSubmission("review", (report, exec) => {
    signal.throwIfAborted();
    return session.submit(report, exec.agent!.id, exec.callId, exec.signal);
  });
  return {
    scope: input.scope,
    tools: [
      ports.healthTool(),
      ports.recallTool(),
      ...createReviewTools(session, input.scope, ports.policy),
      reader.tool,
      submission.tool,
    ],
    input: agentInput({
      scope: input.scope,
      task: { role: "review", objective: input.question },
      context: {
        runId: input.runId,
        originalScope: input.originalScope,
        referencePrice,
        reportCatalog: reader.catalog,
        availableSources: ports
          .sourceHealth(input.scope)
          .filter((source) => source.capability !== null),
      },
    }),
    result() {
      const ref = submission.result();
      const entry = ports.memory.read(ref);
      return { ref, outcome: entry.outcome, note: entry.note };
    },
  };
}
