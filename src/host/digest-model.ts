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
  sharedResearchPrompt(`Create a stage digest from the fixed research context for downstream roles, condensing key conclusions, drivers, outlook and disagreements.
keyPoints retains decisive facts and mechanisms; disagreements retains opposing views; openQuestions retains questions that determine the next research steps.
Target ${DIGEST_TARGET_CHARACTERS} Unicode characters for the entire summary/content JSON, maximum ${DIGEST_MAX_CHARACTERS}, including keys and punctuation. Target ${AGENT_SUMMARY_TARGET_CHARACTERS} for summary, maximum ${AGENT_SUMMARY_MAX_CHARACTERS}. Prioritize conclusions, key facts, assumptions and disagreements; full analysis remains in the original reports. Preserve the distinction between upstream facts, inferences and disagreements.
For each requiredRisks issueId, include a riskSummaries entry retaining its impact, triggers or action constraints. Read full risks from original reports using reportCatalog IDs.`);
const DIGEST_PROTOCOL = `${LEGACY_DIGEST_PROTOCOL}
Start with report summaries in materials. Use stock_read_report with reportCatalog IDs when evidence, disagreements, specific risks or limitations need clarification; omission from a summary does not establish absence.
Budget for JSON keys, punctuation and escaping. Allocate space to accurately cover every requiredRisks item and retain key conditions. If over budget, revise using the tool's actual length and field usage feedback.`;

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
                input.instruction ??
                "Summarize this stage's key conclusions, disagreements and risks.",
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
