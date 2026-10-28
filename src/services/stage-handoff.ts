import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  STAGE_HANDOFF_MAX_CHARACTERS,
  STAGE_HANDOFF_TARGET_CHARACTERS,
  stageHandoffSchema,
  type StageHandoff,
} from "../contracts/stage-handoff.js";
import { ResearchError } from "../contracts/errors.js";

export function parseStageHandoff(value: unknown): StageHandoff {
  const errors = validateJsonSchemaValue(
    stageHandoffSchema,
    value,
    "stageHandoff",
  );
  if (errors.length > 0)
    throw new ResearchError("INVALID_INPUT", errors.join("\n"));
  const handoff = value as StageHandoff;
  const entries = Object.values(handoff).flat();
  if (entries.length === 0 || entries.some((entry) => entry.trim() === ""))
    throw new ResearchError(
      "INVALID_INPUT",
      "stageHandoff requires at least one nonempty entry; unused lists must be empty.",
    );
  const length = [...JSON.stringify(handoff)].length;
  if (length > STAGE_HANDOFF_MAX_CHARACTERS) {
    const fields = Object.entries(handoff)
      .map(([name, value]) => `${name}=${[...JSON.stringify(value)].length}`)
      .join(", ");
    throw new ResearchError(
      "INVALID_INPUT",
      `stageHandoff JSON: ${length}/${STAGE_HANDOFF_MAX_CHARACTERS} Unicode characters (target ${STAGE_HANDOFF_TARGET_CHARACTERS}, over by ${length - STAGE_HANDOFF_MAX_CHARACTERS}). Field JSON value lengths: ${fields}; counts include JSON escaping, field names and punctuation. Compress the handoff without omitting decisive conditions or risks.`,
    );
  }
  return structuredClone(handoff);
}
