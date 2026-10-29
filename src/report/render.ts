import type { ArtifactInput, NumericClaim } from "../contracts/artifacts.js";

export function inline(text: string): string {
  return text.replace(/[\\`*_[\]<>#|]/g, "\\$&").replace(/\r?\n/g, " ");
}

const DISPLAY_SIGNIFICANT_DIGITS = 6;
const displayNumber = new Intl.NumberFormat("zh-CN", {
  maximumSignificantDigits: DISPLAY_SIGNIFICANT_DIGITS,
  useGrouping: false,
});
const DISPLAY_SCALES = [
  { value: 100_000_000, label: "亿" },
  { value: 10_000, label: "万" },
];

export function formatNumber(value: number): string {
  return displayNumber.format(value === 0 ? 0 : value);
}

function displayUnit(unit: string): string {
  switch (unit) {
    case "year":
      return "年";
    case "share":
      return "股";
    case "multiple":
      return "倍";
    default:
      return unit.endsWith("/share") ? `${unit.slice(0, -6)}/股` : unit;
  }
}

export function valueText(value: number, unit: string): string {
  if (unit === "ratio") return `${formatNumber(value * 100)}%`;
  if (unit === "percent") return `${formatNumber(value)}%`;
  const magnitude = Math.abs(Number(formatNumber(value)));
  const scale =
    /^[A-Z]{3}$/.test(unit) || unit === "share"
      ? DISPLAY_SCALES.find(({ value: threshold }) => magnitude >= threshold)
      : undefined;
  return `${formatNumber(value / (scale?.value ?? 1))} ${scale?.label ?? ""}${inline(displayUnit(unit))}`;
}

export function numberText(claim: NumericClaim): string {
  const value = valueText(claim.value, claim.unit);
  return claim.kind === "estimated" ? `${value}（估计）` : value;
}

export function renderArtifactBody(input: ArtifactInput): string {
  const claims = new Map(input.claims.map((claim) => [claim.id, claim]));
  return input.body.replace(
    /\{\{number:([^{}]+)\}\}/g,
    (_token: string, id: string) => numberText(claims.get(id)!),
  );
}

export function renderArtifact(input: ArtifactInput): string {
  return `# ${inline(input.title)}\n\n${renderArtifactBody(input)}\n`;
}
