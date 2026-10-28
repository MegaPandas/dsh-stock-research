import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type LlmCallConfig } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { resolveModelOptions, type ModelConfig } from "../app/model-config.js";
import type {} from "../app/settings.js";
import type { GenerateDigest } from "../contracts/digests.js";
import { ResearchError } from "../contracts/errors.js";
import { createReportReader } from "../app/report-reader.js";
import { sharedResearchPrompt } from "../app/agent-prompt.js";
import { researchStageFeedback } from "../app/research-stages.js";
import { digestBusinessDraft } from "../services/digest-business.js";
import { handoffDigest } from "../services/handoff-digest.js";
import { artifactKey } from "../services/run-dependencies.js";
import { reportMaterial } from "../report/material.js";
import {
  agentInput,
  createSubmission,
  setupResearchTools,
} from "./agent-execution.js";
import { observeModelCalls } from "./model-events.js";
import {
  AGENT_SUMMARY_TARGET_CHARACTERS,
  AGENT_SUMMARY_MAX_CHARACTERS,
  DIGEST_MAX_CHARACTERS,
  DIGEST_TARGET_CHARACTERS,
} from "../contracts/agent-reports.js";
import { readResearchModels } from "../app/research-models.js";

export const DIGEST_PROMPT_VERSION = "12";
const LEGACY_DIGEST_PROTOCOL =
  sharedResearchPrompt(`固定研究上下文的阶段摘要，压缩核心判断、驱动机制、展望和分歧，供后续角色使用。
keyPoints保留决定判断的事实和机制；disagreements保留各方分歧；openQuestions保存决定后续方向的待答问题。
整份summary/content业务JSON目标${DIGEST_TARGET_CHARACTERS}个Unicode字符，允许最多${DIGEST_MAX_CHARACTERS}字符，包含字段名与标点；summary目标${AGENT_SUMMARY_TARGET_CHARACTERS}字符，上限${AGENT_SUMMARY_MAX_CHARACTERS}字符。按重要性压缩当前结论、关键事实、假设和分歧，原报告保存完整分析。压缩时保持上游事实、推断和分歧的性质。
riskSummaries逐项对应给定requiredRisks的issueId，以短条目保留影响、触发条件或处置约束。完整风险保存在原报告中，按reportCatalog中的id读取。`);
const DIGEST_PROTOCOL = `${LEGACY_DIGEST_PROTOCOL}
先根据materials中的报告摘要整理交接；当依据、分歧、具体风险或限制不清楚时，按reportCatalog中的id调用stock_read_report读取完整报告。不得把摘要中没有提及的事项当成不存在。
预留JSON字段名、标点和转义空间，根据实际风险调整各字段长度，确保每个requiredRisks均有准确回应，不为凑预算删去关键条件。超限时按工具返回的实际长度和字段用量修改。`;

/** DSH owns the context and tool loop; the domain callback validates and publishes. */
export class HostDigestModel {
  private readonly config: LlmCallConfig | ModelConfig | undefined;

  constructor(
    private readonly ctx: Context,
    config?: LlmCallConfig | ModelConfig,
  ) {
    this.config = structuredClone(config);
  }

  readonly generate: GenerateDigest = async (
    input,
    signal,
    operation,
    submit,
  ) => {
    signal.throwIfAborted();
    if (
      input.protocolVersion !== undefined &&
      input.protocolVersion !== "10" &&
      input.protocolVersion !== "11" &&
      input.protocolVersion !== DIGEST_PROMPT_VERSION
    )
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        `The recorded digest protocol ${input.protocolVersion} is unavailable.`,
      );
    if (input.protocolVersion === DIGEST_PROMPT_VERSION) {
      const draft = handoffDigest(input);
      signal.throwIfAborted();
      return submit(draft);
    }
    let handle: AgentHandle | undefined;
    let failure: unknown;
    const submission = createSubmission("digest", (report) => {
      signal.throwIfAborted();
      return submit(digestBusinessDraft(report, input));
    });
    const legacy = input.protocolVersion === "10";
    const reader = createReportReader(
      input.reports,
      legacy ? input.artifacts.map(({ ref }) => ref) : [],
    );
    const abort = () => handle?.agent.cancel({ kind: "user" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const { reasoningEffort, ...explicit } = this.config ?? {};
      const parent = this.ctx.agents.get(SessionId(operation.identity));
      const runtime = this.ctx.get("stockResearch");
      const models =
        runtime === undefined
          ? undefined
          : readResearchModels(runtime.runs, operation.runId);
      const revisionFeedback =
        runtime === undefined
          ? undefined
          : researchStageFeedback(runtime.runs, operation.runId, input.taskId);
      const config =
        models?.digest ??
        (this.config?.provider === undefined
          ? resolveModelOptions(
              parent!,
              this.config ??
                this.ctx.get("stockResearchSettings")?.digestFor(parent!),
            )
          : {
              ...explicit,
              ...(reasoningEffort == null ? {} : { reasoningEffort }),
            });
      handle = await this.ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        agentOptions: config,
        signal,
        setup: (ctx, agent) => {
          // AgentOptions covers routing; preserve the full deployment call config.
          ctx.on("agent/request", async (_payload, next) => ({
            ...config,
            ...(await next()),
          }));
          ctx.systemPrompt.section({
            name: "stock:digest",
            order: 0,
            text: legacy ? LEGACY_DIGEST_PROTOCOL : DIGEST_PROTOCOL,
            complete: true,
            interpolate: false,
          });
          const verifyTools = setupResearchTools(ctx, agent, [
            reader.tool,
            submission.tool,
          ]);
          observeModelCalls(agent, operation, "digest");
          ctx.on("agent/error", ({ error }) => {
            failure ??= error;
          });
          return { commit: verifyTools };
        },
      });
      signal.throwIfAborted();
      handle.agent.followup(
        createUserMessage({
          content: agentInput({
            scope: input.scope,
            task: {
              id: input.taskId,
              role: "digest",
              objective:
                input.instruction ?? "提炼当前阶段的核心结论、分歧和风险。",
            },
            context: {
              materials: input.artifacts.map(({ content, ref }) => {
                const material = reportMaterial(content);
                return !legacy && "summary" in material
                  ? {
                      id: reader.catalog[
                        input.reports.findIndex(
                          (report) =>
                            artifactKey(report.ref) === artifactKey(ref),
                        )
                      ]!.id,
                      title: material.title,
                      summary: material.summary,
                    }
                  : material;
              }),
              reportCatalog: reader.catalog,
              requiredRisks: input.risks.map(({ issueId }) => ({ issueId })),
              ...(revisionFeedback === undefined ? {} : { revisionFeedback }),
            },
          }),
          source: { kind: "user" },
        }),
      );
      await handle.agent.whenIdle();
      signal.throwIfAborted();
      if (failure !== undefined) throw failure;
      return submission.result();
    } finally {
      signal.removeEventListener("abort", abort);
      await handle?.dispose();
    }
  };
}
