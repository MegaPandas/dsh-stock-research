import type { BollValue, MacdValue } from "../contracts/indicators.js";

export type Series = readonly (number | null)[];

export function rollingSum(values: Series, period: number): (number | null)[] {
  const result: (number | null)[] = [];
  let sum = 0;
  let correction = 0;
  let count = 0;
  let nonzeroCount = 0;
  function add(value: number): void {
    const next = sum + value;
    correction +=
      Math.abs(sum) >= Math.abs(value)
        ? sum - next + value
        : value - next + sum;
    sum = next;
  }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === null) {
      count = 0;
      sum = 0;
      correction = 0;
      nonzeroCount = 0;
      result.push(null);
      continue;
    }
    add(value);
    if (value !== 0) nonzeroCount++;
    count++;
    if (count > period) {
      const removed = values[index - period]!;
      add(-removed);
      if (removed !== 0) nonzeroCount--;
    }
    // An all-zero window is exactly zero; roundoff must not become volume or flow.
    if (nonzeroCount === 0) {
      sum = 0;
      correction = 0;
    }
    result.push(count >= period ? sum + correction : null);
  }
  return result;
}

export function sma(values: Series, period: number): (number | null)[] {
  return rollingSum(values, period).map((sum) =>
    sum === null ? null : sum / period,
  );
}

export function smooth(
  values: Series,
  period: number,
  alpha: number,
): (number | null)[] {
  const result: (number | null)[] = [];
  let seed = 0;
  let count = 0;
  let average = 0;
  for (const value of values) {
    if (value === null) {
      count = 0;
      seed = 0;
      result.push(null);
      continue;
    }
    if (count < period) {
      seed += value;
      count++;
      if (count < period) {
        result.push(null);
        continue;
      }
      average = seed / period;
    } else {
      average += alpha * (value - average);
    }
    result.push(average);
  }
  return result;
}

export function ema(values: Series, period: number): (number | null)[] {
  return smooth(values, period, 2 / (period + 1));
}

export function rsi(values: Series, period: number): (number | null)[] {
  const gains: (number | null)[] = [];
  const losses: (number | null)[] = [];
  let previous: number | null = null;
  for (const value of values) {
    const change =
      value === null || previous === null ? null : value - previous;
    gains.push(change === null ? null : Math.max(change, 0));
    losses.push(change === null ? null : Math.max(-change, 0));
    previous = value;
  }
  const averageGains = smooth(gains, period, 1 / period);
  const averageLosses = smooth(losses, period, 1 / period);
  return averageGains.map((gain, index) => {
    if (gain === null) return null;
    const loss = averageLosses[index]!;
    return gain + loss === 0 ? 50 : (gain / (gain + loss)) * 100;
  });
}

export function macd(
  values: Series,
  fast: number,
  slow: number,
  signalPeriod: number,
): (MacdValue | null)[] {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const differences = slowEma.map((value, index) =>
    value === null ? null : fastEma[index]! - value,
  );
  const signals = ema(differences, signalPeriod);
  return differences.map((difference, index) => {
    if (difference === null) return null;
    const signal = signals[index]!;
    return {
      macd: difference,
      signal,
      histogram: signal === null ? null : difference - signal,
    };
  });
}

export function boll(
  values: Series,
  period: number,
  deviations: number,
): (BollValue | null)[] {
  const result: (BollValue | null)[] = [];
  let count = 0;
  let mean = 0;
  let squaredDeviations = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value === null) {
      count = 0;
      mean = 0;
      squaredDeviations = 0;
      result.push(null);
      continue;
    }
    if (period === 1) {
      result.push({ middle: value, upper: value, lower: value });
      continue;
    }
    // Update centered moments rather than subtracting two large squared sums.
    if (count === period) {
      const removed = values[index - period]!;
      const oldMean = mean;
      mean += (mean - removed) / (period - 1);
      squaredDeviations -= (removed - oldMean) * (removed - mean);
      count--;
    }
    count++;
    const delta = value - mean;
    mean += delta / count;
    squaredDeviations += delta * (value - mean);
    if (count < period) {
      result.push(null);
      continue;
    }
    // Roundoff can leave a tiny negative moment for a constant window.
    const width =
      deviations * Math.sqrt(Math.max(0, squaredDeviations / period));
    result.push({ middle: mean, upper: mean + width, lower: mean - width });
  }
  return result;
}
