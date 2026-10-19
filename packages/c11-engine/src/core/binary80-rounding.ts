import {
  MAX_NORMAL_EXPONENT, MIN_NORMAL_EXPONENT, MIN_SUBNORMAL_EXPONENT, PRECISION,
  SIGNIFICAND_LIMIT, binary80Infinity, binary80Zero, value,
} from './binary80-value.ts';
import type { Binary80Value } from './binary80-value.ts';

export function bitLength(input: bigint): number {
  return input === 0n ? 0 : input.toString(2).length;
}

export function floorLog2Ratio(numerator: bigint, denominator: bigint): number {
  let exponent = bitLength(numerator) - bitLength(denominator);
  if (exponent >= 0) {
    if (numerator < (denominator << BigInt(exponent))) exponent--;
  } else if ((numerator << BigInt(-exponent)) < denominator) exponent--;
  return exponent;
}

export function roundedQuotient(numerator: bigint, denominator: bigint, sticky: boolean): bigint {
  const quotient = numerator / denominator;
  const twiceRemainder = (numerator % denominator) << 1n;
  return twiceRemainder > denominator ||
    (twiceRemainder === denominator && (sticky || (quotient & 1n) !== 0n))
    ? quotient + 1n : quotient;
}

export interface Binary80RoundingOptions {
  /** Additional power of two applied to numerator / denominator. */
  readonly binaryExponent?: number;
  /** Sign; permits a signed zero when numerator is zero. */
  readonly negative?: boolean;
  /** A discarded, strictly positive tail smaller than the least retained unit. */
  readonly sticky?: boolean;
}

/** Round an exact nonnegative rational to binary80, using round-to-nearest-even. */
export function binary80FromRational(
  numerator: bigint,
  denominator = 1n,
  options: Binary80RoundingOptions = {},
): Binary80Value {
  if (denominator <= 0n) throw new RangeError('The binary80 denominator must be positive.');
  if (!Number.isSafeInteger(options.binaryExponent ?? 0)) throw new RangeError('The binary80 exponent must be a safe integer.');
  const negative = options.negative ?? numerator < 0n;
  let magnitude = numerator < 0n ? -numerator : numerator;
  if (magnitude === 0n) return binary80Zero(negative);

  const binaryExponent = options.binaryExponent ?? 0;
  const topExponent = floorLog2Ratio(magnitude, denominator) + binaryExponent;
  if (topExponent > MAX_NORMAL_EXPONENT) return binary80Infinity(negative);
  if (topExponent < MIN_SUBNORMAL_EXPONENT - 1) return binary80Zero(negative);

  // Below the normal range, all values share the least-subnormal quantum.
  const unitExponent = Math.max(topExponent, MIN_NORMAL_EXPONENT) - (PRECISION - 1);
  const shift = binaryExponent - unitExponent;
  let scaledNumerator = magnitude;
  let scaledDenominator = denominator;
  if (shift >= 0) scaledNumerator <<= BigInt(shift);
  else scaledDenominator <<= BigInt(-shift);

  let significand = roundedQuotient(scaledNumerator, scaledDenominator, !!options.sticky);
  if (significand === 0n) return binary80Zero(negative);
  let exponent = unitExponent;
  if (significand >= SIGNIFICAND_LIMIT) {
    significand >>= 1n;
    exponent++;
  }
  if (exponent + (PRECISION - 1) > MAX_NORMAL_EXPONENT) return binary80Infinity(negative);
  return value('finite', negative, significand, exponent);
}
