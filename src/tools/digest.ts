import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { GenerateDigest } from "../contracts/digests.js";
import type { DraftFile } from "../host/draft-file.js";
import { researchTool } from "./errors.js";
import {
  artifactRefSchema,
  object,
  objectSchema,
  resultOutput,
  stringSchema,
} from "./parameters.js";

const strings = { type: "array", items: stringSchema } as const;
const refs = { type: "array", items: artifactRefSchema } as const;
export const digestMetadataSchema = objectSchema({
  title: stringSchema,
  inputRefs: refs,
  facts: {
    type: "array",
    items: objectSchema({
      text: stringSchema,
      inputRefs: refs,
      numbers: strings,
    }),
  },
  disagreements: strings,
  riskSummaries: {
    type: "array",
    items: objectSchema({ issueId: stringSchema, text: stringSchema }),
  },
});

/** Registered only in the owning digest Agent, with its fixed task operation. */
export function createDigestTool(
  file: DraftFile,
  submit: Parameters<GenerateDigest>[3],
): ToolDefinition {
  return researchTool({
    name: "stock_submit_digest",
    description:
      "Validate and publish a digest of fixed upstream artifacts. On validation failure, the draft is retained; correct the reported errors and resubmit.",
    parameters: objectSchema({}),
    output: resultOutput(
      objectSchema({
        runId: stringSchema,
        taskId: stringSchema,
        attempt: { type: "integer" },
        refs,
      }),
    ),
    async execute(value, exec) {
      exec.signal.throwIfAborted();
      object(value, []);
      const result = submit(await file.value(exec.signal));
      exec.concludeTurn();
      return result;
    },
  });
}
