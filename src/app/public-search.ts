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
        `Search is paused: the user has rejected ${rejectedApprovals} search approvals during this public research. Complete the draft using the existing data and materials, and record information gaps and their impact in content.handoff.openQuestions and limitations. Only the primary agent or the user may decide whether a new search is needed; subagents must not resume searching or request permission again.`,
      );
  }
  const tool = researchTool({
    name: "stock_search_public",
    description: `检索公开信息，前${maxSearches}次免审批，之后每次检索均需用户单次批准；累计${PUBLIC_SEARCH_LIMITS.maxRejectedApprovals}次拒绝后暂停搜索，须先基于已有材料成稿并说明信息缺口。必要的新搜索由主Agent或用户决定，子Agent不能自行恢复搜索。结果条数沿用原生搜索配置，返回标题、链接、摘要、时间提示、检索时点及剩余免审批额度。`,
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
              `The user rejected this search (${rejectedApprovals}/${PUBLIC_SEARCH_LIMITS.maxRejectedApprovals} rejections so far). Complete the analysis using the existing materials, explain the information gaps, and do not request the same or a similar query again.`,
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
