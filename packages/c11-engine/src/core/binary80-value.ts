/**
 * Software representation of the x87 extended-precision value used by the
 * x86-64 Linux profile. The value payload has 64 significand bits and a
 * 15-bit exponent; object storage and alignment are both 16 bytes.
 *
 * Finite values are represented exactly as
 *   (-1)^negative * significand * 2^exponent.
 * Normal values have a 64-bit significand. Subnormals use exponent -16445.
 * Signed zero is represented by a zero significand and the `negative` flag.
 * BigInt is kept throughout; this module never approximates binary80 through
 * a JavaScript Number.
 */

export type Binary80Classification = 'finite' | 'infinity' | 'nan';

export interface Binary80Value {
  readonly kind: 'binary80';
  readonly classification: Binary80Classification;
  readonly negative: boolean;
  /** Explicit x87 significand for finite values; canonical quiet-NaN payload for NaN. */
  readonly significand: bigint;
  /** Power of two applied to `significand`; zero and specials use zero. */
  readonly exponent: number;
}

export type Binary80Format = 'binary32' | 'binary64';
export type BinaryFloatFormat = Binary80Format | 'binary80';

export interface Binary80Rational {
  /** Magnitude numerator; `negative` carries the sign separately. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly negative: boolean;
}

export interface Binary80Parts {
  readonly classification: Binary80Classification;
  readonly negative: boolean;
  readonly significand: bigint;
  readonly exponent: number;
}

export const BINARY80_PROFILE = Object.freeze({
  valueBits: 80,
  significandBits: 64,
  exponentBits: 15,
  precision: 64,
  bias: 16383,
  minimumNormalExponent: -16382,
  maximumNormalExponent: 16383,
  minimumSubnormalExponent: -16445,
  storageBytes: 16,
  alignmentBytes: 16,
  payloadBytes: 10,
});

export const PRECISION = 64;
export const SIGNIFICAND_LIMIT = 1n << 64n;
export const INTEGER_BIT = 1n << 63n;
export const QUIET_NAN = INTEGER_BIT | (1n << 62n);
export const MIN_NORMAL_EXPONENT = BINARY80_PROFILE.minimumNormalExponent;
export const MAX_NORMAL_EXPONENT = BINARY80_PROFILE.maximumNormalExponent;
export const MIN_SUBNORMAL_EXPONENT = BINARY80_PROFILE.minimumSubnormalExponent;

export function value(
  classification: Binary80Classification,
  negative: boolean,
  significand: bigint,
  exponent: number,
): Binary80Value {
  return Object.freeze({ kind: 'binary80', classification, negative, significand, exponent });
}

export function binary80Zero(negative = false): Binary80Value {
  return value('finite', negative, 0n, 0);
}

export function binary80Infinity(negative = false): Binary80Value {
  return value('infinity', negative, INTEGER_BIT, 0);
}

export function binary80NaN(negative = false): Binary80Value {
  return value('nan', negative, QUIET_NAN, 0);
}

export function decomposeBinary80(input: Binary80Value): Binary80Parts {
  const checked = assertBinary80(input);
  return Object.freeze({
    classification: checked.classification,
    negative: checked.negative,
    significand: checked.significand,
    exponent: checked.exponent,
  });
}

export function assertBinary80(input: Binary80Value): Binary80Value {
  if (!input || input.kind !== 'binary80' || !['finite', 'infinity', 'nan'].includes(input.classification) ||
      typeof input.negative !== 'boolean' || typeof input.significand !== 'bigint' || !Number.isSafeInteger(input.exponent)) {
    throw new TypeError('Expected a valid binary80 value.');
  }
  if (input.classification === 'finite') {
    const significand = input.significand;
    const validZero = significand === 0n && input.exponent === 0;
    const validSubnormal = significand > 0n && significand < INTEGER_BIT && input.exponent === MIN_SUBNORMAL_EXPONENT;
    const validNormal = significand >= INTEGER_BIT && significand < SIGNIFICAND_LIMIT &&
      input.exponent >= MIN_SUBNORMAL_EXPONENT && input.exponent <= MAX_NORMAL_EXPONENT - 63;
    if (!validZero && !validSubnormal && !validNormal) {
      throw new TypeError('The finite binary80 representation is not normalized.');
    }
  } else if (input.exponent !== 0 || input.significand !==
      (input.classification === 'infinity' ? INTEGER_BIT : QUIET_NAN)) {
    throw new TypeError('The special binary80 representation is not normalized.');
  }
  return input;
}
