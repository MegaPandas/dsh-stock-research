import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DataEnvelope } from "../contracts/data.js";
import type { ResearchData } from "../contracts/research.js";
import { ResearchError } from "../contracts/errors.js";
import { researchTool } from "../tools/errors.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../tools/parameters.js";
import { PUBLIC_SEARCH_LIMITS } from "./public-research.js";

/** Each analyst receives one search budget, including unsuccessful attempts. */
export function createPublicSearchSession(
  access: {
    search(
      query: string,
      exec: ToolRunContext,
    ): Promise<DataEnvelope<ResearchData>>;
    approve(
      query: string,
      exec: ToolRunContext,
      used: number,
    ): Promise<boolean>;
  },
  maxSearches: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): { tool: ToolDefinition; resume(): void } {
  let used = 0;
  let rejectedApprovals = 0;
  let approvalQueue = Promise.resolve();
  function requireSearchOpen() {
    if (rejectedApprovals >= PUBLIC_SEARCH_LIMITS.maxRejectedApprovals)
      throw new ResearchError(
        "ACCESS_DENIED",
        `Search is paused after ${rejectedApprovals} denied approvals. Complete the draft using existing materials. Record only gaps affecting conclusions in content.handoff.openQuestions or content.handoff.limitations. Resumption requires a decision by the primary agent or user.`,
      );
  }
  const tool = researchTool({
    name: "stock_search_public",
    description: `Search public information. The first ${maxSearches} searches need no approval; each additional search requires approval. Pause after ${PUBLIC_SEARCH_LIMITS.maxRejectedApprovals} denials; resumption requires a decision by the primary agent or user. Use the host's result-count setting. Return titles, links, snippets, time hints, retrieval time and remaining budget.`,
    parameters: objectSchema({ query: stringSchema }),
    output: resultOutput(opaqueObjectSchema),
    async execute(value, exec) {
      exec.signal.throwIfAborted();
      const item = object(value, ["query"]);
      const query = text(item.query, "query");
      requireSearchOpen();
      if (used >= maxSearches) {
        const reserveApprovedSearch = async () => {
          exec.signal.throwIfAborted();
          requireSearchOpen();
          const allowed = await access.approve(query, exec, used);
          exec.signal.throwIfAborted();
          if (!allowed) {
            rejectedApprovals += 1;
            requireSearchOpen();
            throw new ResearchError(
              "ACCESS_DENIED",
              `Search approval denied (${rejectedApprovals}/${PUBLIC_SEARCH_LIMITS.maxRejectedApprovals}). Complete the analysis using existing materials; record gaps only when they affect conclusions. Do not repeat the same or a similar query.`,
            );
          }
          used += 1;
        };
        // Queued calls must see earlier refusals before opening another approval.
        const reserved = approvalQueue.then(
          reserveApprovedSearch,
          reserveApprovedSearch,
        );
        approvalQueue = reserved;
        await reserved;
      } else used += 1;
      const envelope = await access.search(query, exec);
      const { data } = envelope;
      const sources = data.items.map((source) => ({
        title: source.title,
        url: source.url,
        snippet:
          source.snippet === null
            ? null
            : [...source.snippet]
                .slice(0, PUBLIC_SEARCH_LIMITS.maxSnippetChars)
                .join(""),
        timeHint: source.providerTimestamp,
      }));
      return {
        query: data.query,
        retrievedAt: envelope.retrievedAt,
        timestampScope: "current_search",
        sources,
        truncated:
          data.truncated ||
          data.items.some(
            (source) =>
              source.snippet !== null &&
              [...source.snippet].length > PUBLIC_SEARCH_LIMITS.maxSnippetChars,
          ),
        budget: {
          limit: maxSearches,
          used,
          remaining: Math.max(maxSearches - used, 0),
        },
      };
    },
  });
  return {
    tool,
    resume() {
      rejectedApprovals = 0;
    },
  };
}
