export interface StageHandoff {
  keyPoints: string[];
  disagreements: string[];
  risks: string[];
  openQuestions: string[];
}

export const STAGE_HANDOFF_MAX_CHARACTERS = 900;
export const STAGE_HANDOFF_TARGET_CHARACTERS = STAGE_HANDOFF_MAX_CHARACTERS / 2;

export const stageHandoffSchema = {
  type: "object" as const,
  properties: Object.fromEntries(
    ["keyPoints", "disagreements", "risks", "openQuestions"].map((name) => [
      name,
      { type: "array" as const, items: { type: "string" as const } },
    ]),
  ),
  required: ["keyPoints", "disagreements", "risks", "openQuestions"],
  additionalProperties: false,
};
