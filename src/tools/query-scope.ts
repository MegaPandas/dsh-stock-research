import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

/** Project query entry variants; nested fixed references retain their run identity. */
export function scopedQueryParameters(
  parameters: Record<string, unknown>,
  replay: boolean,
): Record<string, unknown> {
  function project(
    schema: JsonSchemaNode,
  ): JsonSchemaNode & Record<string, unknown> {
    const result = { ...schema };
    if (schema.oneOf !== undefined) result.oneOf = schema.oneOf.map(project);
    if (schema.properties !== undefined) {
      const properties = { ...schema.properties };
      delete properties.runId;
      if (!replay) delete properties.source;
      result.properties = properties;
    }
    return result;
  }
  return project(parameters as JsonSchemaNode);
}
