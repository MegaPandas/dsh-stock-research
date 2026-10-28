import type { ArtifactInput, NumericClaim } from "../contracts/artifacts.js";

export function inline(text: string): string {
  return text.replace(/[\\`*_[\]<>#|]/g, "\\$&").replace(/\r?\n/g, " ");
}

const DISPLAY_SIGNIFICANT_DIGITS = 6;
const displayNumber = new Intl.NumberFormat("zh-CN", {
  maximumSignificantDigits: DISPLAY_SIGNIFICANT_DIGITS,
  useGrouping: false,
});

export function valueText(value: number, unit: string): string {
  if (unit === "ratio") return `${displayNumber.format(value * 100)}%`;
  if (unit === "percent") return `${displayNumber.format(value)}%`;
  return `${displayNumber.format(value)} ${inline(unit)}`;
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
