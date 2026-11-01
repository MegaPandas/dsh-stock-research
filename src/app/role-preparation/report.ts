import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {
  AgentReport,
  AgentReportKind,
} from "../../contracts/agent-reports.js";
import type { StageHandoff } from "../../contracts/stage-handoff.js";
import type { RoleDispatchContext } from "../../contracts/runs.js";
import type { ResearchArtifactVersion } from "../../contracts/artifact-payloads.js";
import { createReportDraft } from "../../host/report-draft.js";
import { assembleAgentArtifact } from "../../services/agent-artifacts.js";
import type { ArtifactNumber } from "../../services/artifact-inputs.js";
import { validateRoleValuation } from "../../valuation/report-policy.js";
import { referencePrice, type RegisteredTable } from "../reference-price.js";
import type { ValuationMethods } from "../valuation-methods.js";
import { latestPublicSearchTime } from "./public-search.js";
import { valuationDraftInput } from "./valuation-draft.js";
import type { RoleServices } from "./services.js";

export interface RoleReportSeed {
  report?: AgentReport;
  stageHandoff?: StageHandoff;
  publicSearchAsOf?: string;
}

export function prepareRoleReport(
  services: Pick<RoleServices, "runs" | "submitReport">,
  { claim, definition, scope }: RoleDispatchContext,
  kind: AgentReportKind,
  inputs: {
    reports: readonly ResearchArtifactVersion[];
    tables: readonly RegisteredTable[];
    price: ArtifactNumber | null;
    valuationMethods?: ValuationMethods;
    publicRole: boolean;
  },
  previous?: RoleReportSeed,
) {
  const { reports, tables, price, valuationMethods, publicRole } = inputs;
  const labels = {
    analysis: publicRole
      ? "公开信息与产品竞争分析"
      : `${definition.executor.specialty}阶段分析`,
    debate: definition.executor.specialty === "bull" ? "多方讨论" : "空方讨论",
    risk: "风控分析",
    plan: "研究计划",
    decision_draft: "经理决策",
  };
  let submittedReport: AgentReport | undefined;
  let submittedHandoff: StageHandoff | undefined;
  let publicSearchAsOf = previous?.publicSearchAsOf;
  const accept = async (
    report: AgentReport,
    exec: ToolRunContext,
    stageHandoff?: StageHandoff,
  ) => {
    if (valuationMethods !== undefined)
      validateRoleValuation(
        report,
        definition.valuation,
        scope,
        valuationMethods.methods.map(({ id }) => id),
      );
    const artifact = assembleAgentArtifact(
      kind,
      report,
      {
        taskId: claim.taskId,
        specialty: definition.executor.specialty,
        title: `${scope.security.symbol} ${labels[kind]}`,
        inputRefs: reports.map(({ ref }) => ref),
        currency: scope.security.currency,
        referencePrice: price,
        scope,
      },
      kind === "analysis" ? referencePrice(tables, scope) : [],
      stageHandoff,
    );
    if (publicRole) {
      publicSearchAsOf = latestPublicSearchTime(
        services.runs,
        claim,
        publicSearchAsOf,
      );
      if (
        publicSearchAsOf !== undefined &&
        artifact.kind === "analysis" &&
        "schemaVersion" in artifact.payload &&
        artifact.payload.schemaVersion === 3
      ) {
        artifact.payload.publicSearchAsOf = publicSearchAsOf;
        artifact.body = `公开检索截至：${publicSearchAsOf}\n\n${artifact.body}`;
      }
    }
    submittedReport = report;
    submittedHandoff = stageHandoff;
    return services.submitReport([artifact], `submit:${exec.callId}`, exec);
  };
  const submission = createReportDraft(kind, accept, {
    ...(previous?.report === undefined ? {} : { seed: previous.report }),
    handoff:
      previous?.stageHandoff === undefined
        ? {}
        : { seed: previous.stageHandoff },
    requiredContentSections:
      definition.valuation === undefined ? [] : ["valuation"],
    ...(valuationMethods === undefined
      ? {}
      : { input: valuationDraftInput(kind, services.runs, claim.runId) }),
  });
  return {
    tools: submission.tools,
    continuation(): RoleReportSeed {
      return {
        ...(submittedReport === undefined ? {} : { report: submittedReport }),
        ...(submittedHandoff === undefined
          ? {}
          : { stageHandoff: submittedHandoff }),
        ...(publicSearchAsOf === undefined ? {} : { publicSearchAsOf }),
      };
    },
  };
}
