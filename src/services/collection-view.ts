import type {
  CollectedTableData,
  CollectionReadRequest,
  CollectionReadSource,
  CollectionSummary,
} from "../contracts/collection.js";
import type {
  CandidateClaim,
  DataEnvelope,
  DataGap,
} from "../contracts/data.js";

export function collectionSummary(
  id: string,
  envelope: DataEnvelope<CollectedTableData>,
): CollectionSummary {
  const { data } = envelope;
  return {
    id,
    dataset: envelope.dataset,
    title: data.title,
    recordCount: data.rows.length,
    range:
      data.rows.length === 0
        ? null
        : { from: data.rows[0]!.date, to: data.rows.at(-1)!.date },
    ...(data.interval === undefined ? {} : { interval: data.interval }),
    ...(data.basis === undefined ? {} : { basis: data.basis }),
    quality: {
      stale: envelope.stale,
      historicalKnowledge: envelope.historicalKnowledge,
      missingValues: data.rows.reduce(
        (count, row) =>
          count +
          Object.values(row.values).filter((value) => value === null).length,
        0,
      ),
    },
  };
}

function intersects(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Unindexed constraints apply to the table; indexed gaps follow the selected original paths. */
export function collectionGaps(
  gaps: readonly DataGap[],
  selectors: readonly string[],
): DataGap[] {
  return gaps.filter(
    (gap) =>
      !/^\/data\/rows\/\d+(?:\/|$)/.test(gap.field) ||
      selectors.some((selector) => intersects(selector, gap.field)),
  );
}

export function collectionRowSelectors(index: number): string[] {
  return [
    "date",
    "periodStart",
    "publishedDate",
    "filing",
    "asOf",
    "availableAt",
    "complete",
  ].map((field) => `/data/rows/${index}/${field}`);
}

function valueSelector(index: number, field: string): string {
  const token = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `/data/rows/${index}/values/${token}`;
}

export function readCollectionTable(
  source: CollectionReadSource,
  request: CollectionReadRequest,
) {
  const { envelope, sourceRef } = source;
  const { data } = envelope;
  const metadata = {
    dataset: envelope.dataset,
    source: envelope.source,
    asOf: envelope.asOf,
    availableAt: envelope.availableAt,
    retrievedAt: envelope.retrievedAt,
    cutoff: envelope.cutoff,
    ageMs: envelope.ageMs,
    stale: envelope.stale,
    historicalKnowledge: envelope.historicalKnowledge,
    ...(sourceRef === undefined ? {} : { sourceRef }),
  };
  const description = {
    table: data.table,
    title: data.title,
    ...(data.currency === undefined ? {} : { currency: data.currency }),
    ...(data.adjustment === undefined ? {} : { adjustment: data.adjustment }),
    ...(data.interval === undefined ? {} : { interval: data.interval }),
    ...(data.basis === undefined ? {} : { basis: data.basis }),
    ...(data.attributes === undefined ? {} : { attributes: data.attributes }),
  };
  if (request.kind === "schema") {
    const summary = collectionSummary(source.id, envelope);
    return {
      ...metadata,
      kind: "schema" as const,
      data: { ...description, columns: data.columns },
      recordCount: summary.recordCount,
      range: summary.range,
      quality: summary.quality,
      gaps: collectionGaps(envelope.gaps, []),
    };
  }

  const matching = data.rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        (request.dateFrom === undefined || row.date >= request.dateFrom) &&
        (request.dateTo === undefined || row.date <= request.dateTo),
    );
  const selected = matching.slice(
    request.offset,
    request.offset + request.limit,
  );
  const selectors = selected.flatMap(({ index }) => [
    ...collectionRowSelectors(index),
    ...request.fields.map((field) => valueSelector(index, field)),
  ]);
  const candidateClaims: CandidateClaim[] = [];
  if (sourceRef !== undefined)
    for (const { row, index } of selected)
      for (const field of request.fields) {
        const value = row.values[field]!;
        if (value !== null)
          candidateClaims.push({
            candidateId: `${data.table}.${index}.${field}`,
            label: `${row.periodStart === undefined ? row.date : `${row.periodStart}–${row.date}`} ${data.columns[field]!.label}`,
            value,
            unit: data.columns[field]!.unit,
            asOf: row.asOf,
            source: { ...sourceRef, selector: valueSelector(index, field) },
          });
      }
  return {
    ...metadata,
    kind: "rows" as const,
    data: {
      ...description,
      columns: Object.fromEntries(
        request.fields.map((field) => [field, data.columns[field]!]),
      ),
      rows: selected.map(({ row, index }) => ({
        ...row,
        index,
        values: Object.fromEntries(
          request.fields.map((field) => [field, row.values[field]!]),
        ),
      })),
    },
    totalRows: matching.length,
    offset: request.offset,
    limit: request.limit,
    gaps: collectionGaps(envelope.gaps, selectors),
    ...(sourceRef === undefined ? {} : { candidateClaims }),
  };
}

const ROW_FIELDS = {
  index: { label: "原始行号", type: "integer" },
  date: { label: "观察日期或报告期末", type: "date" },
  periodStart: { label: "报告期初（来源提供时返回）", type: "date" },
  publishedDate: { label: "公告日期（来源提供时返回，可为空）", type: "date" },
  asOf: { label: "观察时点", type: "datetime" },
  availableAt: { label: "公开可得时点（可为空）", type: "datetime" },
  complete: { label: "观察周期是否完成", type: "boolean" },
} as const;

export function isCollectionRowField(field: string): boolean {
  return Object.hasOwn(ROW_FIELDS, field);
}

const BUSINESS_ATTRIBUTES = [
  "name",
  "sourceName",
  "assetType",
  "calendar",
  "timeBasis",
  "instrument",
  "quoteDirection",
  "exchange",
] as const;

/** Business-only projection of a fixed table; provenance stays in the saved snapshot. */
export function readCollectionData(
  source: CollectionReadSource,
  request: CollectionReadRequest,
) {
  const view = readCollectionTable(
    { id: source.id, envelope: source.envelope },
    request.kind === "schema"
      ? request
      : {
          ...request,
          fields: request.fields.filter(
            (field) => !isCollectionRowField(field),
          ),
        },
  );
  const data = view.data;
  const attributes = Object.fromEntries(
    BUSINESS_ATTRIBUTES.filter(
      (key) => data.attributes?.[key] !== undefined,
    ).map((key) => [key, data.attributes![key]!]),
  );
  const description = {
    table: data.table,
    title: data.title,
    ...(data.currency === undefined ? {} : { currency: data.currency }),
    ...(data.adjustment === undefined ? {} : { adjustment: data.adjustment }),
    ...(data.interval === undefined ? {} : { interval: data.interval }),
    ...(data.basis === undefined ? {} : { basis: data.basis }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    columns: data.columns,
  };
  const applicableGaps = view.gaps.filter((gap) => {
    const token = /^\/data\/columns\/([^/]+)$/.exec(gap.field)?.[1];
    if (request.kind === "schema" || token === undefined) return true;
    const field = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return (
      !Object.hasOwn(source.envelope.data.columns, field) ||
      request.fields.includes(field)
    );
  });
  const metadata = {
    dataset: view.dataset,
    provider: view.source.provider,
    asOf: view.asOf,
    availableAt: view.availableAt,
    retrievedAt: view.retrievedAt,
    cutoff: view.cutoff,
    stale: view.stale,
    historicalKnowledge: view.historicalKnowledge,
    limitations: [
      ...new Map(
        applicableGaps.map(({ code, detail }) => [
          JSON.stringify([code, detail]),
          { code, detail },
        ]),
      ).values(),
    ],
  };
  if (view.kind === "schema")
    return {
      ...metadata,
      kind: "schema" as const,
      data: { ...description, rowFields: ROW_FIELDS },
      recordCount: view.recordCount,
      range: view.range,
      quality: view.quality,
    };
  return {
    ...metadata,
    kind: "rows" as const,
    data: {
      ...description,
      rows: view.data.rows.map((row) => ({
        index: row.index,
        date: row.date,
        ...(row.periodStart === undefined
          ? {}
          : { periodStart: row.periodStart }),
        ...(row.publishedDate === undefined
          ? {}
          : { publishedDate: row.publishedDate }),
        asOf: row.asOf,
        availableAt: row.availableAt,
        complete: row.complete,
        values: row.values,
      })),
    },
    totalRows: view.totalRows,
    offset: view.offset,
    limit: view.limit,
  };
}
