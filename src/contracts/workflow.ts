import type { ArtifactKind } from "./artifacts.js";
import type { Dataset, ResearchScope } from "./data.js";

export interface DataRequirement {
  dataset: Dataset;
  fields: string[];
  requiredForDecision: boolean;
}

export interface TaskDefinition {
  id: string;
  executor:
    | {
        kind: "role";
        role: "analyst" | "discussion" | "manager";
        specialty: string;
      }
    | { kind: "service"; service: "digest" | "finalize" };
  dependsOn: string[];
  inputTasks: string[];
  outputKinds: ArtifactKind[];
  dataRequirements: DataRequirement[];
  valuation?: "research" | "decision";
  instructionVersion: number;
}

export interface RunDefinition {
  scope: ResearchScope;
  mode: "quick" | "deep";
  tasks: TaskDefinition[];
  stages?: StageDefinition[];
}

export interface StageDefinition {
  id: string;
  taskIds: string[];
  beforeTasks: string[];
  /** Together stages dispatch all ready peers in one batch; a single ready revision may run alone. */
  dispatch?: "together";
}
