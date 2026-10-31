export const PRICE_RATING_POLICY = "absolute-price-6m/1";
export const PRICE_RATING_MONTHS = 6;
export const PRICE_RATING_BANDS = [
  { rating: "buy", label: "买入", interval: "r > 15%" },
  { rating: "overweight", label: "增持", interval: "5% < r <= 15%" },
  { rating: "neutral", label: "中性", interval: "-5% <= r <= 5%" },
  { rating: "underweight", label: "减持", interval: "-15% <= r < -5%" },
  { rating: "sell", label: "卖出", interval: "r < -15%" },
] as const;
export type PriceRating = (typeof PRICE_RATING_BANDS)[number]["rating"];
