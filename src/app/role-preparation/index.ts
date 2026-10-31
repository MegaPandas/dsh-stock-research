import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  RoleDispatchContext,
  TaskInstructionSnapshot,
} from "../../contracts/runs.js";
import { ResearchError } from "../../contracts/errors.js";
import type { RoleProvision } from "../../host/dispatch/index.js";
import type { RoleServices } from "./services.js";
import { prepareUnifiedRole } from "./role.js";
import { readApplicationInput } from "../research-input.js";
import { ROLE_PROMPT_VERSION } from "../research-prompts.js";

export type { RoleServices } from "./services.js";

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
