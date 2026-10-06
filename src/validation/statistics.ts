export interface Distribution {
  readonly count: number;
  readonly average: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

function percentile(
  sorted: readonly number[],
  percentileValue: number,
): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? null;
}

export function distribution(values: readonly number[]): Distribution {
  const finite = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (finite.length === 0) {
    return {
      count: 0,
      average: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      max: null,
    };
  }
  return {
    count: finite.length,
    average: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    p50: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max: finite.at(-1) ?? null,
  };
}
