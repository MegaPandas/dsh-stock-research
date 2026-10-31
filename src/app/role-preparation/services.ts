import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DataEnvelope } from "../../contracts/data.js";
import type { ResearchData } from "../../contracts/research.js";
import type { RunCommands, RunReader } from "../../contracts/run-access.js";
import type { SubmitReport } from "../../host/report-submission.js";
import type { ValuationOperations } from "../../host/valuation-operations.js";

export interface RoleServices {
  runs: Pick<
    RunReader,
    | "inputCatalog"
    | "readInput"
    | "readInputs"
    | "readArtifact"
    | "readEvidence"
    | "numberContext"
    | "view"
    | "replaySnapshot"
  > &
    Pick<RunCommands, "evidenceForCall" | "recordEvidence" | "replayEvidence">;
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
