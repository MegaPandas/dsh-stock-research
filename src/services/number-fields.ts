import type { ISOTime, MarketBar, MarketData } from "../contracts/data.js";
import type { IndicatorResult } from "../contracts/indicators.js";
import type {
  MarketIndicatorsData,
  PriceReturnsData,
  EvidenceEnvelope,
} from "../contracts/query.js";
import { ResearchError } from "../contracts/errors.js";
import { INDICATORS_ALGORITHM_VERSION } from "../indicators/index.js";
import { PRICE_RETURN_ALGORITHM_VERSION } from "../indicators/returns.js";

export class SelectorError extends Error {}
export interface NumberTime {
  asOf: ISOTime;
  availableAt: ISOTime | null;
  complete: boolean;
}
export interface NumberField {
  value: number | null;
  unit: string;
  times: NumberTime[];
  dependencies: string[];
  price?: { adjustment: string; point: string; comparison: string | null };
}
const SEC_PERIOD_END = "T23:59:59.999Z";
const CN_PERIOD_END = "T15:59:59.999Z";
const SERIES_DATE = "T00:00:00.000Z";
const PRICE_FIELDS = ["open", "high", "low", "close"];

function bad(detail: string): never {
  throw new SelectorError(detail);
}
export function readPointer(
  value: unknown,
  selector: string,
): { value: unknown; tokens: string[] } {
  if (selector === "") return { value, tokens: [] };
  if (!selector.startsWith("/"))
    bad("A selector must be an absolute JSON Pointer.");
  const tokens = selector
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/.test(token)) bad("Invalid JSON Pointer escape.");
      return token.replace(/~[01]/g, (escape) => (escape === "~0" ? "~" : "/"));
    });
  let current = value;
  for (const token of tokens) {
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(token))
      bad("Invalid array index.");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, token)
    )
      bad("The selector does not identify an existing field.");
    current = (current as Record<string, unknown>)[token];
  }
  return { value: current, tokens };
}

export function referenceField(
  envelope: EvidenceEnvelope,
  selector: string,
): Pick<NumberField, "times" | "dependencies"> {
  const { tokens } = readPointer(envelope, selector);
  if (tokens.length === 0)
    return { times: allTimes(envelope), dependencies: [selector] };
  if (tokens[0] !== "data")
    bad("Evidence references must identify business data.");
  const fields = tokens.slice(1);
  const data = envelope.data;
  let times = allTimes(envelope);
  const dependencies = [selector];
  if ("table" in data) {
    if (fields[0] === "rows" && fields.length >= 2) {
      const row = data.rows[Number(fields[1])]!;
      times = [
        {
          asOf: row.asOf,
          availableAt: row.availableAt,
          complete: row.complete,
        },
      ];
      dependencies.push(
        ...["asOf", "availableAt", "complete"].map(
          (key) => `/data/rows/${fields[1]}/${key}`,
        ),
      );
    }
  } else if ("market" in data) {
    if (fields.length === 1 && fields[0] === "value") return returnInputs(data);
    if (
      (fields[0] === "start" || fields[0] === "end") &&
      data[fields[0]] !== null
    ) {
      const selected = returnPoint(data, fields[0]);
      times = selected.times;
      dependencies.push(...selected.dependencies);
    } else if (
      fields[0] === "market" &&
      fields[1] === "bars" &&
      fields.length >= 3
    ) {
      times = [barTime(data.market.bars[Number(fields[2])]!)];
      if (fields.length > 3)
        dependencies.push(...temporalPaths(`/data/market/bars/${fields[2]}`));
    } else if (fields[0] === "market") times = data.market.bars.map(barTime);
  } else if ("bars" in data) {
    if (fields[0] === "bars" && fields.length >= 2) {
      times = [barTime(data.bars[Number(fields[1])]!)];
      if (fields.length > 2)
        dependencies.push(...temporalPaths(`/data/bars/${fields[1]}`));
    } else if (
      "indicators" in data &&
      fields[0] === "indicators" &&
      fields[1] === "series" &&
      fields[3] === "values" &&
      fields.length >= 5
    )
      return indicatorInputs(
        data,
        data.indicators.series[Number(fields[2])]!,
        Number(fields[4]),
        selector,
      );
  } else if (
    "concept" in data &&
    fields[0] === "observations" &&
    fields.length >= 2
  ) {
    const point = data.observations[Number(fields[1])]!;
    dependencies.push(
      `/data/observations/${fields[1]}/availableAt`,
      `/data/observations/${fields[1]}/periodEnd`,
    );
    times = [
      {
        asOf: `${point.periodEnd}${SEC_PERIOD_END}`,
        availableAt: point.availableAt,
        complete: true,
      },
    ];
  } else if (
    "fields" in data &&
    fields[0] === "observations" &&
    fields.length >= 2
  ) {
    const point = data.observations[Number(fields[1])]!;
    dependencies.push(
      `/data/observations/${fields[1]}/availableAt`,
      `/data/observations/${fields[1]}/periodEnd`,
    );
    times = [
      {
        asOf: `${point.periodEnd}${CN_PERIOD_END}`,
        availableAt: point.availableAt,
        complete: true,
      },
    ];
  } else if (
    "seriesId" in data &&
    fields[0] === "observations" &&
    fields.length >= 2
  ) {
    const point = data.observations[Number(fields[1])]!;
    dependencies.push(
      `/data/observations/${fields[1]}/availableAt`,
      `/data/observations/${fields[1]}/date`,
    );
    times = [
      {
        asOf: `${point.date}${SERIES_DATE}`,
        availableAt: point.availableAt,
        complete: true,
      },
    ];
  }
  return { times, dependencies };
}
function temporalPaths(base: string): string[] {
  return ["asOf", "availableAt", "sessionComplete"].map(
    (field) => `${base}/${field}`,
  );
}
function returnPoint(
  data: PriceReturnsData,
  field: "start" | "end",
): Pick<NumberField, "times" | "dependencies"> {
  const point = data[field]!;
  const index = data.market.bars.findIndex((bar) => bar.date === point.date);
  const base = `/data/market/bars/${index}`;
  return {
    times: [
      {
        asOf: point.asOf,
        availableAt: point.availableAt,
        complete: data.market.bars[index]!.sessionComplete,
      },
    ],
    dependencies: [
      `/data/${field}/price`,
      ...temporalPaths(`/data/${field}`),
      `${base}/close`,
      ...temporalPaths(base),
      "/data/market/adjustment",
      "/data/market/currency",
    ],
  };
}
function returnInputs(
  data: PriceReturnsData,
): Pick<NumberField, "times" | "dependencies"> {
  if (data.algorithmVersion !== PRICE_RETURN_ALGORITHM_VERSION)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The price-return algorithm version is not available.",
    );
  const inputs = (["start", "end"] as const)
    .filter((field) => data[field] !== null)
    .map((field) => returnPoint(data, field));
  return {
    times: inputs.flatMap((field) => field.times),
    dependencies: [
      "/data/value",
      ...inputs.flatMap((field) => field.dependencies),
    ],
  };
}
function allTimes(envelope: EvidenceEnvelope): NumberTime[] {
  const data = envelope.data;
  let times: NumberTime[];
  if ("table" in data)
    times = data.rows.map((row) => ({
      asOf: row.asOf,
      availableAt: row.availableAt,
      complete: row.complete,
    }));
  else if ("market" in data)
    times = [
      ...data.market.bars.map(barTime),
      ...(["start", "end"] as const)
        .filter((field) => data[field] !== null)
        .flatMap((field) => returnPoint(data, field).times),
    ];
  else if ("bars" in data) times = data.bars.map(barTime);
  else if ("concept" in data)
    times = data.observations.map((point) => ({
      asOf: `${point.periodEnd}${SEC_PERIOD_END}`,
      availableAt: point.availableAt,
      complete: true,
    }));
  else if ("fields" in data)
    times = data.observations.map((point) => ({
      asOf: `${point.periodEnd}${CN_PERIOD_END}`,
      availableAt: point.availableAt,
      complete: true,
    }));
  else if ("seriesId" in data)
    times = data.observations.map((point) => ({
      asOf: `${point.date}${SERIES_DATE}`,
      availableAt: point.availableAt,
      complete: true,
    }));
  else times = [];
  return times.length === 0
    ? [
        {
          asOf: envelope.asOf,
          availableAt: envelope.availableAt,
          complete: true,
        },
      ]
    : times;
}
function barTime(bar: MarketBar): NumberTime {
  return {
    asOf: bar.asOf,
    availableAt: bar.availableAt,
    complete: bar.sessionComplete,
  };
}
function prefixStart(bars: MarketBar[], index: number): number {
  let start = index;
  while (start > 0) {
    const previous = bars[start - 1]!;
    if (
      [previous.open, previous.high, previous.low, previous.close].some(
        (value) => value === null,
      )
    )
      break;
    start--;
  }
  return start;
}
function indicatorStart(
  series: IndicatorResult,
  bars: MarketBar[],
  index: number,
): number {
  if (
    series.kind === "macd" ||
    series.kind === "ema" ||
    series.kind === "rsi" ||
    series.kind === "atr"
  )
    return prefixStart(bars, index);
  return Math.max(0, index - series.period + (series.kind === "mfi" ? 0 : 1));
}
function indicatorInputs(
  data: MarketIndicatorsData,
  series: IndicatorResult,
  index: number,
  selector: string,
): Pick<NumberField, "times" | "dependencies"> {
  if (data.indicators.algorithmVersion !== INDICATORS_ALGORITHM_VERSION)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The indicator algorithm version is not available.",
    );
  const start = indicatorStart(series, data.bars, index);
  const bars = data.bars.slice(start, index + 1);
  const inputs =
    series.kind === "mfi" || series.kind === "vwma"
      ? [...PRICE_FIELDS, "volume"]
      : PRICE_FIELDS;
  return {
    times: bars.map(barTime),
    dependencies: [
      selector,
      "/data/currency",
      "/data/adjustment",
      `${selector.slice(0, selector.indexOf("/values/"))}/unit`,
      ...bars.flatMap((_bar, offset) => [
        ...inputs.map((field) => `/data/bars/${start + offset}/${field}`),
        ...temporalPaths(`/data/bars/${start + offset}`),
      ]),
    ],
  };
}
function marketField(
  market: MarketData,
  tokens: string[],
  path: string,
  value: number | null,
): NumberField {
  if (
    tokens.length !== 3 ||
    tokens[0] !== "bars" ||
    ![...PRICE_FIELDS, "volume"].includes(tokens[2]!)
  )
    bad("The selector is not a normalized market quantity.");
  const bar = market.bars[Number(tokens[1])]!;
  const price = PRICE_FIELDS.includes(tokens[2]!);
  const marketPath = path.slice(0, path.indexOf("/bars/"));
  return {
    value,
    unit: price ? `${market.currency}/share` : "shares",
    times: [barTime(bar)],
    dependencies: [
      path,
      ...temporalPaths(path.slice(0, path.lastIndexOf("/"))),
      ...(price ? [`${marketPath}/currency`, `${marketPath}/adjustment`] : []),
    ],
    ...(price
      ? {
          price: {
            adjustment: market.adjustment,
            point: bar.date,
            comparison: null,
          },
        }
      : {}),
  };
}

export function numberField(
  envelope: EvidenceEnvelope,
  selector: string,
): NumberField {
  const selected = readPointer(envelope, selector);
  if (selected.value !== null && typeof selected.value !== "number")
    bad("The selector does not identify a numeric observation.");
  const value = selected.value as number | null;
  const tokens = selected.tokens;
  if (tokens[0] !== "data")
    bad("Only normalized business data can supply observed numbers.");
  const fields = tokens.slice(1);
  const data = envelope.data;
  if ("table" in data) {
    if (fields.length !== 4 || fields[0] !== "rows" || fields[2] !== "values")
      bad("The selector is not a collected numeric observation.");
    const key = fields[3]!;
    const column = data.columns[key];
    if (column === undefined)
      bad("The selected collection column has no unit contract.");
    const row = data.rows[Number(fields[1])]!;
    return {
      value,
      unit: column.unit,
      times: [
        {
          asOf: row.asOf,
          availableAt: row.availableAt,
          complete: row.complete,
        },
      ],
      dependencies: [
        selector,
        `/data/columns/${key}`,
        `/data/rows/${fields[1]}/asOf`,
        `/data/rows/${fields[1]}/availableAt`,
        `/data/rows/${fields[1]}/complete`,
      ],
      ...(column.price && data.adjustment !== undefined
        ? {
            price: {
              adjustment: data.adjustment,
              point: row.date,
              comparison: null,
            },
          }
        : {}),
    };
  } else if ("market" in data) {
    if (fields[0] === "market")
      return marketField(data.market, fields.slice(1), selector, value);
    if (fields.length === 1 && fields[0] === "value")
      return { value, unit: "ratio", ...returnInputs(data) };
    if (
      fields.length === 2 &&
      (fields[0] === "start" || fields[0] === "end") &&
      fields[1] === "price"
    ) {
      const point = data[fields[0]]!;
      return {
        value,
        unit: `${point.currency}/share`,
        ...returnPoint(data, fields[0]),
        price: {
          adjustment: point.adjustment,
          point: point.date,
          comparison: data.comparable ? "returns" : null,
        },
      };
    }
  } else if ("bars" in data) {
    if (fields[0] === "bars") return marketField(data, fields, selector, value);
    if (
      "indicators" in data &&
      fields[0] === "indicators" &&
      fields[1] === "series" &&
      fields[3] === "values"
    ) {
      const series = data.indicators.series[Number(fields[2])]!;
      const index = Number(fields[4]);
      const valid =
        series.kind === "boll"
          ? fields.length === 6 &&
            ["middle", "upper", "lower"].includes(fields[5]!)
          : series.kind === "macd"
            ? fields.length === 6 &&
              ["macd", "signal", "histogram"].includes(fields[5]!)
            : fields.length === 5;
      if (!valid) bad("The selector is not an indicator component.");
      return {
        value,
        unit: series.unit,
        ...indicatorInputs(data, series, index, selector),
      };
    }
  } else if (
    "concept" in data &&
    fields.length === 3 &&
    fields[0] === "observations" &&
    fields[2] === "value"
  ) {
    const point = data.observations[Number(fields[1])]!;
    return {
      value,
      unit: data.currency,
      times: [
        {
          asOf: `${point.periodEnd}${SEC_PERIOD_END}`,
          availableAt: point.availableAt,
          complete: true,
        },
      ],
      dependencies: [
        selector,
        `/data/observations/${fields[1]}/availableAt`,
        `/data/observations/${fields[1]}/periodEnd`,
        "/data/currency",
      ],
    };
  } else if (
    "fields" in data &&
    fields.length === 4 &&
    fields[0] === "observations" &&
    fields[2] === "values" &&
    data.fields.some((field) => field === fields[3])
  ) {
    const point = data.observations[Number(fields[1])]!;
    return {
      value,
      unit: data.currency,
      times: [
        {
          asOf: `${point.periodEnd}${CN_PERIOD_END}`,
          availableAt: point.availableAt,
          complete: true,
        },
      ],
      dependencies: [
        selector,
        `/data/observations/${fields[1]}/availableAt`,
        `/data/observations/${fields[1]}/periodEnd`,
        "/data/currency",
        "/data/basis",
      ],
    };
  } else if (
    "seriesId" in data &&
    fields.length === 3 &&
    fields[0] === "observations" &&
    fields[2] === "value"
  ) {
    const point = data.observations[Number(fields[1])]!;
    return {
      value,
      unit: data.unit,
      times: [
        {
          asOf: `${point.date}${SERIES_DATE}`,
          availableAt: point.availableAt,
          complete: true,
        },
      ],
      dependencies: [
        selector,
        `/data/observations/${fields[1]}/availableAt`,
        `/data/observations/${fields[1]}/date`,
        "/data/unit",
      ],
    };
  }
  return bad("The selector has no supported numeric field and unit contract.");
}
