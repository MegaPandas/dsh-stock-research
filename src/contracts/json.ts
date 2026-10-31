export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  description?: string;
}
