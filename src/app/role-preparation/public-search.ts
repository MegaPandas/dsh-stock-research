import type { Agent } from "@deepseek-ai/dsh-agent";
import type { RoleDispatchContext } from "../../contracts/runs.js";
import type { ResearchData } from "../../contracts/research.js";
import { ResearchError } from "../../contracts/errors.js";
import {
  PUBLIC_RESEARCH_PROMPT_INPUT,
  PUBLIC_SEARCH_LIMITS,
} from "../public-research.js";
import { createPublicSearchSession } from "../public-search.js";
import type { RoleServices } from "./services.js";

export type PublicSearchSession = ReturnType<typeof createPublicSearchSession>;

export function preparePublicSearch(
  services: Pick<RoleServices, "runs" | "searchPublic" | "approvePublicSearch">,
  context: RoleDispatchContext,
  limit: number,
  parent?: Agent,
  previous?: PublicSearchSession,
) {
  const { claim } = context;
  const saved = services.runs
    .inputCatalog(claim.runId)
    .inputs.filter(({ name }) => name === PUBLIC_RESEARCH_PROMPT_INPUT);
  if (saved.length !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The public analyst requires its recorded prompt.",
    );
  const systemPrompt = services.runs.readInput<unknown>(
    claim.runId,
    saved[0]!.ref,
  );
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "")
    throw new ResearchError("STORAGE_FAILED", "Invalid public analyst prompt.");
  const session =
    previous ??
    createPublicSearchSession(
      {
        search: (query, exec) => services.searchPublic(query, exec, parent),
        approve: (query, exec, used) =>
          services.approvePublicSearch(query, exec, used, parent),
      },
      limit,
    );
  const replay = services.runs
    .replaySnapshot(claim.runId)
    ?.tasks.find(({ taskId }) => taskId === claim.taskId);
  return {
    systemPrompt,
    session,
    details: {
      ...PUBLIC_SEARCH_LIMITS,
      maxSearches: limit,
      savedSearches: (replay?.evidenceRefs ?? [])
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

export function latestPublicSearchTime(
  runs: Pick<RoleServices["runs"], "numberContext" | "readEvidence">,
  claim: Pick<RoleDispatchContext["claim"], "runId" | "taskId" | "attempt">,
  previous?: string,
): string | undefined {
  const times = runs
    .numberContext(claim.runId)
    .evidence.filter(
      ({ taskId, attempt }) =>
        taskId === claim.taskId && attempt === claim.attempt,
    )
    .map(({ evidenceId }) =>
      runs.readEvidence({ runId: claim.runId, evidenceId }),
    )
    .filter(({ request }) => request.dataset === "research")
    .map(({ envelope }) => envelope.retrievedAt);
  return [...times, ...(previous === undefined ? [] : [previous])]
    .sort()
    .at(-1);
}
