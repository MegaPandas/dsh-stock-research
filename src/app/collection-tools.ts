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
        ? "查看固定采集表的数值字段、单位、口径及自动附带的日期元字段，不返回数据行，不发起网络请求。"
        : "查看固定采集表的字段、单位、口径及质量信息，不返回数据行，不发起网络请求。",
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
        ? "只读固定采集表的业务数据。按fields选择字段，先按dateFrom/dateTo筛选，再从offset分页读取1至100行。日期、报告期和原始行号随每行自动返回；缺失值保持null，不发起网络请求。字段口径用stock_describe_collection查看。"
        : "只读固定采集表的数据行。按fields选择字段，先按dateFrom/dateTo筛选，再从offset分页读取1至100行。返回原始行号、相关缺口和适用的固定数字引用，不发起网络请求。字段口径用stock_describe_collection查看。",
      parameters: objectSchema(
        {
          table: stringSchema,
          fields: {
            type: "array",
            items: stringSchema,
            description: dataOnly
              ? "非空、不重复的字段名，须存在于columns或rowFields。日期元字段随行自动返回，也可显式列出。"
              : "非空、不重复的字段名，须存在于表结构中。",
          },
          offset: {
            type: "integer",
            description: "日期筛选后的行偏移，从0开始。",
          },
          limit: {
            type: "integer",
            description: `每页1至${MAX_PAGE_SIZE}行。`,
          },
          dateFrom: {
            type: "string",
            description: "可选起始日期YYYY-MM-DD，包含当天。",
          },
          dateTo: {
            type: "string",
            description: "可选结束日期YYYY-MM-DD，包含当天。",
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
