import { Ajv } from "ajv";
import type { JsonSchema } from "../contracts/json.js";
import { ResearchError } from "../contracts/errors.js";
import { assertJsonValue } from "./value.js";

const validator = new Ajv({
  allErrors: true,
  ownProperties: true,
  strict: true,
});

/** Schemas are module-owned constants so Ajv can reuse their compiled validators. */
export function assertJsonSchema(
  schema: JsonSchema,
  value: unknown,
  label: string,
): void {
  assertJsonValue(value, label);
  if (!validator.validate(schema, value))
    throw new ResearchError(
      "INVALID_INPUT",
      validator
        .errors!.map(
          (error) =>
            `${label}${error.instancePath} ${error.message}${error.keyword === "additionalProperties" ? `: ${JSON.stringify(error.params.additionalProperty)}` : ""}`,
        )
        .join("\n"),
    );
}
