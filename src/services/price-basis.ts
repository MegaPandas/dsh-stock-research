import type { SourceRef } from "../contracts/data.js";
import type { EvidenceEnvelope } from "../contracts/query.js";
import { numberField } from "./number-fields.js";

export class PriceBasisError extends Error {}
export interface PriceBasisInput {
  estimated: boolean;
  source?: SourceRef;
}
/** Checks a new price-only comparison; committed input values are not revalidated. */
export function verifyPriceBasis(
  first: PriceBasisInput,
  second: PriceBasisInput,
  read: (ref: SourceRef) => EvidenceEnvelope,
): void {
  const profile = (input: PriceBasisInput) => {
    if (input.estimated) return null;
    if (input.source === undefined)
      throw new PriceBasisError(
        "Price inputs need observed prices or an explicit estimate.",
      );
    const price = numberField(read(input.source), input.source.selector).price;
    if (price === undefined)
      throw new PriceBasisError(
        "Return inputs must identify prices, not price-unit indicators.",
      );
    if (price.adjustment === "total_return_adjusted")
      throw new PriceBasisError(
        "Total-return adjusted inputs do not represent a price-only return.",
      );
    return price;
  };
  const a = profile(first);
  const b = profile(second);
  if (a === null || b === null) return;
  if (a.adjustment !== b.adjustment)
    throw new PriceBasisError("Price adjustments differ.");
  if (a.point > b.point)
    throw new PriceBasisError(
      "Observed return prices must follow start-to-end date order.",
    );
  if (
    first.source!.evidenceId !== second.source!.evidenceId ||
    (a.point !== b.point &&
      (a.comparison === null || a.comparison !== b.comparison))
  )
    throw new PriceBasisError(
      "A common price basis across these observations has not been confirmed.",
    );
}
