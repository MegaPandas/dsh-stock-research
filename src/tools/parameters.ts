import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ArtifactRef, SourceRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";

export function invalid(detail: string): never {
  throw new ResearchError("INVALID_INPUT", detail);
}
export function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("Expected an argument object.");
  for (const key of Object.keys(value))
    if (!fields.includes(key)) invalid(`Unexpected field ${key}.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    invalid(`${field} requires nonempty text.`);
  return value;
}
export function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid(`${field} requires a positive safe integer.`);
  return value;
}
export function artifactRef(value: unknown): ArtifactRef {
  const item = object(value, ["runId", "artifactId", "revision"]);
  return {
    runId: text(item.runId, "runId"),
    artifactId: text(item.artifactId, "artifactId"),
    revision: positive(item.revision, "revision"),
  };
}
export function sourceRef(value: unknown): SourceRef {
  const item = object(value, ["runId", "evidenceId", "selector"]);
  if (typeof item.selector !== "string")
    invalid("selector requires a JSON Pointer string.");
  return {
    runId: text(item.runId, "runId"),
    evidenceId: text(item.evidenceId, "evidenceId"),
    selector: item.selector,
  };
}
export const stringSchema = { type: "string" } as const;
export function objectSchema(
  properties: Record<string, JsonSchemaNode>,
  required = Object.keys(properties),
): JsonSchemaNode & Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
export const artifactRefSchema = objectSchema({
  runId: stringSchema,
  artifactId: stringSchema,
  revision: { type: "integer", description: "已登记的正安全整数修订号。" },
});
export const sourceRefSchema = objectSchema({
  runId: stringSchema,
  evidenceId: stringSchema,
  selector: stringSchema,
});
export const opaqueObjectSchema: JsonSchemaNode = {
  type: "object",
  additionalProperties: true,
};
export function resultOutput(schema: JsonSchemaNode): ToolDefinition["output"] {
  return {
    schema,
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}
