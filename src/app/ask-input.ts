import type { ResearchScope, Security } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { parseLocalDate } from "../contracts/time.js";
import type { RunDefinition } from "../contracts/workflow.js";

export interface AskInput {
  scope: ResearchScope;
  question: string;
}

export interface ResearchInput {
  security: string;
  scope: ResearchScope;
}

export function securityFor(symbol: string): Security {
  const normalized = symbol.replace(/^(SH|SZ)\.(\d{6})$/, "$2.$1");
  const cn = /^(?:CN:)?(\d{6})\.(SH|SZ)$/.exec(normalized);
  if (cn !== null) {
    const code = cn[1]!;
    const exchange = cn[2]!;
    const canonical = `${code}.${exchange}`;
    return {
      id: `CN:${canonical}`,
      market: "CN",
      symbol: canonical,
      exchange,
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    };
  }
  const us = /^(NASDAQ|NYSE):([A-Z][A-Z0-9-]*)$/.exec(symbol);
  if (us !== null)
    return {
      id: `US:${us[2]!}`,
      market: "US",
      symbol: us[2]!,
      exchange: us[1]!,
      currency: "USD",
      timeZone: "America/New_York",
    };
  throw new ResearchError(
    "INVALID_INPUT",
    "Use SZ.002594, CN:600519.SH, NASDAQ:NVDA or NYSE:IBM; the exchange must be explicit.",
  );
}

function dayEnd(date: string, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const nominal = Date.parse(`${date}T23:59:59.999Z`);
  let end = nominal;
  // Resolve the offset at the actual end, including DST and historical offsets.
  for (;;) {
    const offset = formatter
      .formatToParts(new Date(end))
      .find((part) => part.type === "timeZoneName")!.value;
    const [hours, minutes, seconds = 0] = offset
      .slice(4)
      .split(":")
      .map(Number);
    const offsetMs =
      (hours! * 3600 + minutes! * 60 + seconds) *
      1000 *
      (offset[3] === "+" ? 1 : -1);
    const resolved = nominal - offsetMs;
    if (resolved === end) return end;
    end = resolved;
  }
}

/** Parse only at the human command boundary; downstream tools inherit this scope. */
export function parseAskInput(rawInput: string, startedAt: Date): AskInput {
  const match = /^\s*(\S+)\s+(\S+)\s+([\s\S]*\S)\s*$/.exec(rawInput);
  if (match === null)
    throw new ResearchError(
      "INVALID_INPUT",
      "Usage: /stock-ask <exchange.symbol> <YYYY-MM-DD> <question>",
    );
  return {
    scope: researchScope(match[1]!, match[2]!, startedAt),
    question: match[3]!.trim(),
  };
}

export function parseResearchInput(
  rawInput: string,
  startedAt: Date,
  mode: RunDefinition["mode"],
): ResearchInput {
  const match = /^\s*(\S+)\s+(\S+)\s*$/.exec(rawInput);
  if (match === null)
    throw new ResearchError(
      "INVALID_INPUT",
      `Usage: /stock-${mode} <exchange.symbol> <YYYY-MM-DD>`,
    );
  return {
    security: match[1]!,
    scope: researchScope(match[1]!, match[2]!, startedAt),
  };
}

export function researchCutoff(
  scope: Pick<ResearchScope, "security" | "date">,
  startedAt: Date,
): string {
  return new Date(
    Math.min(startedAt.getTime(), dayEnd(scope.date, scope.security.timeZone)),
  ).toISOString();
}

function researchScope(
  symbol: string,
  inputDate: string,
  startedAt: Date,
): ResearchScope {
  return scopeAtDate(securityFor(symbol), inputDate, startedAt);
}

export function scopeAtDate(
  security: Security,
  inputDate: string,
  startedAt: Date,
): ResearchScope {
  const date = parseLocalDate(inputDate);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: security.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(startedAt);
  if (date > today)
    throw new ResearchError(
      "INVALID_INPUT",
      "Research date cannot be in the future in the target market.",
    );
  return {
    security,
    date,
    cutoff: researchCutoff({ security, date }, startedAt),
  };
}
