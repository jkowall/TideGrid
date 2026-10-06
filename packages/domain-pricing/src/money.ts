/**
 * Integer money arithmetic. Amounts are integer cents and never negative here.
 * Every division rounds half up, which for non-negative values is also half
 * away from zero, as US sales tax rounds. Products of two integers are formed
 * in BigInt, so no intermediate step loses precision.
 */

/** Parts per million: tax rates. 70000 is 7%. */
export const PPM = 1_000_000;
/** Basis points: discounts and refunds. 1000 is 10%. */
export const BASIS_POINTS = 10_000;

function requireCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer, got ${value}`);
  }
}

/** round_half_up(value × numerator ÷ denominator) for non-negative integers. */
export function mulDivHalfUp(value: number, numerator: number, denominator: number): number {
  requireCount(value, "value");
  requireCount(numerator, "numerator");
  requireCount(denominator, "denominator");
  if (denominator === 0) throw new RangeError("denominator must be positive");
  const product = BigInt(value) * BigInt(numerator);
  const d = BigInt(denominator);
  const quotient = product / d;
  const rounded = (product % d) * 2n >= d ? quotient + 1n : quotient;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new RangeError("result exceeds the safe integer range");
  return result;
}

/**
 * Splits `total` into integer parts proportional to `weights` by the largest
 * remainder method. Each part starts at the floor of its exact share; the
 * units left over go one each to the largest fractional remainders, ties to
 * the earlier weight. The parts always sum to `total`. Zero weights get zero.
 */
export function allocateLargestRemainder(total: number, weights: readonly number[]): number[] {
  requireCount(total, "total");
  for (const w of weights) requireCount(w, "weight");
  const sum = weights.reduce((acc, w) => acc + BigInt(w), 0n);
  if (sum === 0n) {
    if (total !== 0) throw new RangeError("cannot allocate a non-zero total over zero weights");
    return weights.map(() => 0);
  }
  const t = BigInt(total);
  const floors = weights.map((w) => (t * BigInt(w)) / sum);
  const remainders = weights.map((w) => (t * BigInt(w)) % sum);
  let left = Number(t - floors.reduce((acc, f) => acc + f, 0n));
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a] ?? 0n;
      const rb = remainders[b] ?? 0n;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
  const parts = floors.map(Number);
  for (const i of order) {
    if (left === 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}
