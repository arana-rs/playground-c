import {
  BINARY80_PROFILE, assertBinary80, binary80Infinity, binary80NaN, binary80Zero,
} from './binary80-value.ts';
import type {
  Binary80Classification, Binary80Format, Binary80Rational, Binary80Value, BinaryFloatFormat,
} from './binary80-value.ts';
import { binary80Compare } from './binary80-arithmetic.ts';
import { bitLength, floorLog2Ratio, roundedQuotient, binary80FromRational } from './binary80-rounding.ts';

/** Convert an existing binary64 value exactly into the wider binary80 format. */
export function binary80FromNumber(input: number): Binary80Value {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, input, false);
  const bits = view.getBigUint64(0, false);
  const negative = (bits >> 63n) !== 0n;
  const exponentField = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (exponentField === 0x7ff) return fraction === 0n ? binary80Infinity(negative) : binary80NaN(negative);
  if (exponentField === 0 && fraction === 0n) return binary80Zero(negative);
  const significand = exponentField === 0 ? fraction : (1n << 52n) | fraction;
  const exponent = exponentField === 0 ? -1074 : exponentField - 1023 - 52;
  return binary80FromRational(significand, 1n, { binaryExponent: exponent, negative });
}

/** Return the exact rational represented by a finite binary80 value. */
export function binary80ToRational(input: Binary80Value): Binary80Rational {
  const checked = assertBinary80(input);
  if (checked.classification !== 'finite') throw new RangeError('NaN and infinity do not have a finite rational fraction.');
  if (checked.exponent >= 0) {
    return Object.freeze({
      numerator: checked.significand << BigInt(checked.exponent),
      denominator: 1n,
      negative: checked.negative,
    });
  }
  return Object.freeze({
    numerator: checked.significand,
    denominator: 1n << BigInt(-checked.exponent),
    negative: checked.negative,
  });
}

export function binary80ToBigIntTrunc(input: Binary80Value): bigint {
  const checked = assertBinary80(input);
  if (checked.classification !== 'finite') throw new RangeError('NaN and infinity cannot be converted to an integer.');
  const magnitude = checked.exponent >= 0
    ? checked.significand << BigInt(checked.exponent)
    : checked.significand >> BigInt(-checked.exponent);
  return checked.negative ? -magnitude : magnitude;
}

/** Alias emphasizing the C conversion rule: truncate the finite value toward zero. */
export const binary80ToInteger = binary80ToBigIntTrunc;

interface BinaryTargetFormat {
  readonly precision: number;
  readonly minimumNormalExponent: number;
  readonly maximumNormalExponent: number;
}

const targetFormats: Readonly<Record<Binary80Format, BinaryTargetFormat>> = Object.freeze({
  binary32: Object.freeze({ precision: 24, minimumNormalExponent: -126, maximumNormalExponent: 127 }),
  binary64: Object.freeze({ precision: 53, minimumNormalExponent: -1022, maximumNormalExponent: 1023 }),
});

const adjacentFormats: Readonly<Record<BinaryFloatFormat, BinaryTargetFormat & { minimumSubnormalExponent: number }>> = Object.freeze({
  binary32: Object.freeze({ precision: 24, minimumNormalExponent: -126, maximumNormalExponent: 127, minimumSubnormalExponent: -149 }),
  binary64: Object.freeze({ precision: 53, minimumNormalExponent: -1022, maximumNormalExponent: 1023, minimumSubnormalExponent: -1074 }),
  binary80: Object.freeze({
    precision: BINARY80_PROFILE.precision,
    minimumNormalExponent: BINARY80_PROFILE.minimumNormalExponent,
    maximumNormalExponent: BINARY80_PROFILE.maximumNormalExponent,
    minimumSubnormalExponent: BINARY80_PROFILE.minimumSubnormalExponent,
  }),
});

/** Round an exact binary80 value to one of the profile's real floating formats. */
export function binary80RoundToFormat(input: Binary80Value, format: BinaryFloatFormat): Binary80Value {
  const checked = assertBinary80(input);
  if (format === 'binary80') return checked;
  return binary80FromNumber(binary80ToNumber(checked, format));
}

/** Return the adjacent value in `format` toward `direction` without narrowing direction first. */
export function binary80NextAfter(
  input: Binary80Value,
  direction: Binary80Value,
  format: BinaryFloatFormat,
): Binary80Value {
  const from = binary80RoundToFormat(input, format);
  const toward = assertBinary80(direction);
  if (from.classification === 'nan' || toward.classification === 'nan') return binary80NaN();
  const order = binary80Compare(from, toward);
  if (order === undefined) return binary80NaN();
  if (order === 0) return binary80RoundToFormat(toward, format);
  if (from.classification === 'infinity') {
    if (from.negative) return binary80FromRational((1n << BigInt(adjacentFormats[format].precision)) - 1n, 1n, {
      binaryExponent: adjacentFormats[format].maximumNormalExponent - adjacentFormats[format].precision + 1,
      negative: true,
    });
    return binary80FromRational((1n << BigInt(adjacentFormats[format].precision)) - 1n, 1n, {
      binaryExponent: adjacentFormats[format].maximumNormalExponent - adjacentFormats[format].precision + 1,
    });
  }
  if (from.significand === 0n) {
    return binary80FromRational(1n, 1n, {
      binaryExponent: adjacentFormats[format].minimumSubnormalExponent,
      negative: order > 0,
    });
  }

  const target = adjacentFormats[format];
  const exponent = Math.max(from.exponent + bitLength(from.significand) - 1, target.minimumNormalExponent) - (target.precision - 1);
  const commonExponent = Math.min(from.exponent, exponent);
  const magnitude = from.significand << BigInt(from.exponent - commonExponent);
  const step = 1n << BigInt(exponent - commonExponent);
  const movingAwayFromZero = (order < 0) !== from.negative;
  const nextMagnitude = movingAwayFromZero ? magnitude + step : magnitude - step;
  return binary80FromRational(nextMagnitude, 1n, {
    binaryExponent: commonExponent,
    negative: from.negative,
  });
}

function roundToTarget(
  numerator: bigint,
  denominator: bigint,
  binaryExponent: number,
  negative: boolean,
  target: BinaryTargetFormat,
): { classification: Binary80Classification; negative: boolean; significand: bigint; exponent: number } {
  if (numerator === 0n) return { classification: 'finite', negative, significand: 0n, exponent: 0 };
  const topExponent = floorLog2Ratio(numerator, denominator) + binaryExponent;
  if (topExponent > target.maximumNormalExponent) return { classification: 'infinity', negative, significand: 0n, exponent: 0 };
  const unitExponent = Math.max(topExponent, target.minimumNormalExponent) - (target.precision - 1);
  const shift = binaryExponent - unitExponent;
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let significand = roundedQuotient(scaledNumerator, scaledDenominator, false);
  if (significand === 0n) return { classification: 'finite', negative, significand: 0n, exponent: 0 };
  let exponent = unitExponent;
  if (significand >= (1n << BigInt(target.precision))) {
    significand >>= 1n;
    exponent++;
  }
  if (exponent + (target.precision - 1) > target.maximumNormalExponent) {
    return { classification: 'infinity', negative, significand: 0n, exponent: 0 };
  }
  return { classification: 'finite', negative, significand, exponent };
}

/** Convert directly to binary32 or binary64, without an intermediate Number rounding. */
export function binary80ToNumber(input: Binary80Value, format: Binary80Format): number {
  const checked = assertBinary80(input);
  if (checked.classification === 'nan') return NaN;
  if (checked.classification === 'infinity') return checked.negative ? -Infinity : Infinity;
  const target = targetFormats[format];
  if (!target) throw new RangeError(`Unrecognized floating-point format: ${String(format)}.`);
  const rounded = roundToTarget(
    checked.significand,
    1n,
    checked.exponent,
    checked.negative,
    target,
  );
  if (rounded.classification === 'infinity') return rounded.negative ? -Infinity : Infinity;
  if (rounded.significand === 0n) return rounded.negative ? -0 : 0;
  // The target significand fits exactly in a JS Number; scaling by a power of
  // two constructs the already-rounded target value without a second rounding.
  const magnitude = Number(rounded.significand) * 2 ** rounded.exponent;
  return rounded.negative ? -magnitude : magnitude;
}

/** Convert directly to binary32, returned as its exact JavaScript Number value. */
export function binary80ToBinary32(input: Binary80Value): number {
  return binary80ToNumber(input, 'binary32');
}

/** Convert directly to binary64, returned as its JavaScript Number value. */
export function binary80ToBinary64(input: Binary80Value): number {
  return binary80ToNumber(input, 'binary64');
}

/** Multiply and add exact binary80 operands, rounding only once to binary32 or binary64. */
export function binary80FusedMultiplyAddToNumber(
  leftInput: Binary80Value,
  rightInput: Binary80Value,
  addendInput: Binary80Value,
  format: Binary80Format,
): number {
  const left = assertBinary80(leftInput), right = assertBinary80(rightInput), addend = assertBinary80(addendInput);
  const target = targetFormats[format];
  if (!target) throw new RangeError(`Unrecognized floating-point format: ${String(format)}.`);
  if (left.classification === 'nan' || right.classification === 'nan' || addend.classification === 'nan') return NaN;

  const productNegative = left.negative !== right.negative;
  const leftZero = left.classification === 'finite' && left.significand === 0n;
  const rightZero = right.classification === 'finite' && right.significand === 0n;
  if ((left.classification === 'infinity' && rightZero) || (right.classification === 'infinity' && leftZero)) return NaN;
  if (left.classification === 'infinity' || right.classification === 'infinity') {
    if (addend.classification === 'infinity' && addend.negative !== productNegative) return NaN;
    return productNegative ? -Infinity : Infinity;
  }
  if (addend.classification === 'infinity') return addend.negative ? -Infinity : Infinity;

  const product = left.significand * right.significand;
  if (product === 0n && addend.significand === 0n) {
    const negative = productNegative === addend.negative ? productNegative : false;
    return negative ? -0 : 0;
  }

  const productExponent = left.exponent + right.exponent;
  const commonExponent = Math.min(productExponent, addend.exponent);
  const productInteger = product << BigInt(productExponent - commonExponent);
  const addendInteger = addend.significand << BigInt(addend.exponent - commonExponent);
  const sum = (productNegative ? -productInteger : productInteger) + (addend.negative ? -addendInteger : addendInteger);
  if (sum === 0n) return 0;

  const rounded = roundToTarget(sum < 0n ? -sum : sum, 1n, commonExponent, sum < 0n, target);
  if (rounded.classification === 'infinity') return rounded.negative ? -Infinity : Infinity;
  if (rounded.significand === 0n) return rounded.negative ? -0 : 0;
  const magnitude = Number(rounded.significand) * 2 ** rounded.exponent;
  return rounded.negative ? -magnitude : magnitude;
}
