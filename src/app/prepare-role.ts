import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DataEnvelope } from "../contracts/data.js";
import type { ResearchData } from "../contracts/research.js";
import type {
  RoleDispatchContext,
  TaskInstructionSnapshot,
} from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";
import type { RoleProvision } from "../host/dispatch.js";
import type { SubmitReport } from "../host/report-submission.js";
import type { ValuationOperations } from "../host/valuation-operations.js";
import type { RunService } from "../services/runs.js";
import { prepareUnifiedRole } from "./agent-role.js";
import { readApplicationInput } from "./research-input.js";
import { ROLE_PROMPT_VERSION } from "./research-prompts.js";

export interface RoleServices {
  runs: RunService;
  submitReport: SubmitReport;
  valuations: ValuationOperations;
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
}

export function prepareResearchRole(
  services: RoleServices,
  context: RoleDispatchContext,
  parent?: Agent,
): RoleProvision {
  const { claim } = context;
  const roleVersion = services.runs.inputCatalog(claim.runId).versions.prompts
    .roles;
  if (roleVersion !== ROLE_PROMPT_VERSION)
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
  return prepareUnifiedRole(
    services,
    context,
    readApplicationInput(services.runs, claim.runId),
    instruction,
    parent,
  );
}
