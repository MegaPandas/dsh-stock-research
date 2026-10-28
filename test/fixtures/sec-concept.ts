// Artificial protocol samples; amounts and filings are not collected SEC records.
export const SEC_REVENUE_TAG =
  "RevenueFromContractWithCustomerExcludingAssessedTax";

export function secFact(overrides: Record<string, unknown> = {}) {
  return {
    start: "2024-01-01",
    end: "2024-03-31",
    val: 123_456_789,
    accn: "0000000001-24-000001",
    form: "10-Q",
    filed: "2024-05-01",
    // Deliberately different fiscal labels: period dates define the observation.
    fy: 2025,
    fp: "FY",
    frame: "CY2023",
    ...overrides,
  };
}

export function secConcept(
  facts: unknown[] = [secFact()],
  overrides: Record<string, unknown> = {},
) {
  return {
    cik: 1,
    taxonomy: "us-gaap",
    tag: SEC_REVENUE_TAG,
    units: { USD: facts },
    ...overrides,
  };
}
