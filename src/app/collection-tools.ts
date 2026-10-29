import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type {
  CollectionReadRequest,
  CollectionReadSource,
} from "../contracts/collection.js";
import { ResearchError } from "../contracts/errors.js";
import { parseLocalDate } from "../contracts/time.js";
import {
  isCollectionRowField,
  readCollectionData,
  readCollectionTable,
} from "../services/collection-view.js";
import { researchTool } from "../tools/errors.js";
import {
  invalid,
  object,
  objectSchema,
  stringSchema,
  text,
  resultOutput,
  opaqueObjectSchema,
} from "../tools/parameters.js";

const MAX_PAGE_SIZE = 100;

function readRequest(
  value: unknown,
): Extract<CollectionReadRequest, { kind: "rows" }> {
  const item = object(value, [
    "table",
    "fields",
    "offset",
    "limit",
    "dateFrom",
    "dateTo",
  ]);
  const table = text(item.table, "table");
  if (!Array.isArray(item.fields) || item.fields.length === 0)
    invalid("fields requires a nonempty array of column names.");
  const fields = item.fields.map((field) => text(field, "fields"));
  if (new Set(fields).size !== fields.length)
    invalid("fields must not contain duplicate column names.");
  if (
    !Number.isSafeInteger(item.offset) ||
    (item.offset as number) < 0 ||
    !Number.isSafeInteger(item.limit) ||
    (item.limit as number) < 1 ||
    (item.limit as number) > MAX_PAGE_SIZE
  )
    invalid(
      `offset must be a nonnegative integer and limit an integer from 1 to ${MAX_PAGE_SIZE}.`,
    );
  const dateFrom =
    item.dateFrom === undefined
      ? undefined
      : parseLocalDate(text(item.dateFrom, "dateFrom"));
  const dateTo =
    item.dateTo === undefined
      ? undefined
      : parseLocalDate(text(item.dateTo, "dateTo"));
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo)
    invalid("dateFrom must not be after dateTo.");
  return {
    kind: "rows",
    table,
    fields,
    offset: item.offset as number,
    limit: item.limit as number,
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
  };
}

function createCollectionTools(
  sources: readonly CollectionReadSource[],
  dataOnly: boolean,
): ToolDefinition[] {
  function sourceFor(table: string): CollectionReadSource {
    const source = sources.find((source) => source.id === table);
    if (source === undefined)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        "The requested table is not in this task's captured collection.",
      );
    return source;
  }
  function read(source: CollectionReadSource, request: CollectionReadRequest) {
    return structuredClone(
      dataOnly
        ? readCollectionData(source, request)
        : readCollectionTable(source, request),
    );
  }
  return [
    researchTool({
      name: "stock_describe_collection",
      description: dataOnly
        ? "Inspect numeric fields, units, definitions and date metadata in a fixed snapshot. Read rows with stock_read_collection."
        : "Inspect fields, units, definitions and quality information in a fixed snapshot. Read rows with stock_read_collection.",
      parameters: objectSchema({ table: stringSchema }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["table"]);
        const table = text(item.table, "table");
        return read(sourceFor(table), { kind: "schema", table });
      },
    }),
    researchTool({
      name: "stock_read_collection",
      description: dataOnly
        ? "Read a fixed snapshot without network access. Select columns with fields, filter by dateFrom/dateTo, then paginate from offset. Rows include dates, reporting periods and original row indices; missing values are null. Read field definitions with stock_describe_collection."
        : "Read a fixed snapshot without network access. Select columns with fields, filter by dateFrom/dateTo, then paginate from offset. Return original row indices, relevant gaps and fixed numeric references. Read field definitions with stock_describe_collection.",
      parameters: objectSchema(
        {
          table: stringSchema,
          fields: {
            type: "array",
            items: stringSchema,
            description: dataOnly
              ? "Nonempty, unique field names from columns or rowFields. Date metadata is returned automatically and may also be listed explicitly."
              : "Nonempty, unique field names present in the table schema.",
          },
          offset: {
            type: "integer",
            description: "Zero-based row offset after date filtering.",
          },
          limit: {
            type: "integer",
            description: `Rows per page, from 1 to ${MAX_PAGE_SIZE}.`,
          },
          dateFrom: {
            type: "string",
            description: "Optional inclusive start date, YYYY-MM-DD.",
          },
          dateTo: {
            type: "string",
            description: "Optional inclusive end date, YYYY-MM-DD.",
          },
        },
        ["table", "fields", "offset", "limit"],
      ),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const request = readRequest(value);
        const source = sourceFor(request.table);
        for (const field of request.fields)
          if (
            !Object.hasOwn(source.envelope.data.columns, field) &&
            !(dataOnly && isCollectionRowField(field))
          )
            invalid(
              `Unknown column ${field} in ${request.table}. Read its schema first.`,
            );
        return read(source, request);
      },
    }),
  ];
}

/** Fixed evidence views retain canonical numeric references for reference-based callers. */
export function collectionReadTools(
  sources: readonly CollectionReadSource[],
): ToolDefinition[] {
  return createCollectionTools(sources, false);
}

/** Analysts read business values without repeating provenance or candidate numeric claims. */
export function collectionDataTools(
  sources: readonly CollectionReadSource[],
): ToolDefinition[] {
  return createCollectionTools(sources, true);
}
