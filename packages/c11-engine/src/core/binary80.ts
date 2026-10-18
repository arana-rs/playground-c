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

const PRECISION = 64;
const SIGNIFICAND_LIMIT = 1n << 64n;
const INTEGER_BIT = 1n << 63n;
const QUIET_NAN = INTEGER_BIT | (1n << 62n);
const MIN_NORMAL_EXPONENT = BINARY80_PROFILE.minimumNormalExponent;
const MAX_NORMAL_EXPONENT = BINARY80_PROFILE.maximumNormalExponent;
const MIN_SUBNORMAL_EXPONENT = BINARY80_PROFILE.minimumSubnormalExponent;
// A binary80 midpoint can have about 11,500 significant decimal digits near
// the least subnormal. Keep enough exact decimal digits to distinguish those
// halfway cases before the sticky-tail shortcut is used.
const MAX_DECIMAL_SIGNIFICANT_DIGITS = 12_000;
const MAX_HEX_SIGNIFICANT_DIGITS = 4200;

function value(
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

function assertBinary80(input: Binary80Value): Binary80Value {
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

function bitLength(input: bigint): number {
  return input === 0n ? 0 : input.toString(2).length;
}

function floorLog2Ratio(numerator: bigint, denominator: bigint): number {
  let exponent = bitLength(numerator) - bitLength(denominator);
  if (exponent >= 0) {
    if (numerator < (denominator << BigInt(exponent))) exponent--;
  } else if ((numerator << BigInt(-exponent)) < denominator) exponent--;
  return exponent;
}

function roundedQuotient(numerator: bigint, denominator: bigint, sticky: boolean): bigint {
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

function finiteSignedInteger(input: Binary80Value, commonExponent: number): bigint {
  const magnitude = input.significand << BigInt(input.exponent - commonExponent);
  return input.negative ? -magnitude : magnitude;
}

function compareFiniteMagnitude(left: Binary80Value, right: Binary80Value): number {
  if (left.significand === 0n) return right.significand === 0n ? 0 : -1;
  if (right.significand === 0n) return 1;
  const commonExponent = Math.min(left.exponent, right.exponent);
  const a = left.significand << BigInt(left.exponent - commonExponent);
  const b = right.significand << BigInt(right.exponent - commonExponent);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare values; `undefined` is the unordered result for either NaN. */
export function binary80Compare(leftInput: Binary80Value, rightInput: Binary80Value): -1 | 0 | 1 | undefined {
  const left = assertBinary80(leftInput), right = assertBinary80(rightInput);
  if (left.classification === 'nan' || right.classification === 'nan') return undefined;
  if (left.classification === 'infinity' || right.classification === 'infinity') {
    if (left.classification === 'infinity' && right.classification === 'infinity') {
      return left.negative === right.negative ? 0 : left.negative ? -1 : 1;
    }
    if (left.classification === 'infinity') return left.negative ? -1 : 1;
    return right.negative ? 1 : -1;
  }
  if (left.significand === 0n && right.significand === 0n) return 0;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const magnitude = compareFiniteMagnitude(left, right);
  return (left.negative ? -magnitude : magnitude) as -1 | 0 | 1;
}

export function binary80Negate(input: Binary80Value): Binary80Value {
  const checked = assertBinary80(input);
  return value(checked.classification, !checked.negative, checked.significand, checked.exponent);
}

export function binary80Add(leftInput: Binary80Value, rightInput: Binary80Value): Binary80Value {
  const left = assertBinary80(leftInput), right = assertBinary80(rightInput);
  if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN();
  if (left.classification === 'infinity' || right.classification === 'infinity') {
    if (left.classification === 'infinity' && right.classification === 'infinity' && left.negative !== right.negative) return binary80NaN();
    return left.classification === 'infinity' ? left : right;
  }
  if (left.significand === 0n && right.significand === 0n) return binary80Zero(left.negative && right.negative);
  const commonExponent = Math.min(left.exponent, right.exponent);
  const sum = finiteSignedInteger(left, commonExponent) + finiteSignedInteger(right, commonExponent);
  if (sum === 0n) return binary80Zero();
  return binary80FromRational(sum < 0n ? -sum : sum, 1n, { binaryExponent: commonExponent, negative: sum < 0n });
}

export function binary80Subtract(left: Binary80Value, right: Binary80Value): Binary80Value {
  return binary80Add(left, binary80Negate(right));
}

export function binary80Multiply(leftInput: Binary80Value, rightInput: Binary80Value): Binary80Value {
  const left = assertBinary80(leftInput), right = assertBinary80(rightInput);
  const negative = left.negative !== right.negative;
  if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN(negative);
  const leftZero = left.classification === 'finite' && left.significand === 0n;
  const rightZero = right.classification === 'finite' && right.significand === 0n;
  if ((left.classification === 'infinity' && rightZero) || (right.classification === 'infinity' && leftZero)) return binary80NaN(negative);
  if (left.classification === 'infinity' || right.classification === 'infinity') return binary80Infinity(negative);
  if (leftZero || rightZero) return binary80Zero(negative);
  return binary80FromRational(left.significand * right.significand, 1n, {
    binaryExponent: left.exponent + right.exponent,
    negative,
  });
}

export function binary80Divide(leftInput: Binary80Value, rightInput: Binary80Value): Binary80Value {
  const left = assertBinary80(leftInput), right = assertBinary80(rightInput);
  const negative = left.negative !== right.negative;
  if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN(negative);
  const leftZero = left.classification === 'finite' && left.significand === 0n;
  const rightZero = right.classification === 'finite' && right.significand === 0n;
  if ((left.classification === 'infinity' && right.classification === 'infinity') || (leftZero && rightZero)) return binary80NaN(negative);
  if (left.classification === 'infinity' || rightZero) return binary80Infinity(negative);
  if (right.classification === 'infinity' || leftZero) return binary80Zero(negative);
  return binary80FromRational(left.significand, right.significand, {
    binaryExponent: left.exponent - right.exponent,
    negative,
  });
}

export function binary80Truthy(input: Binary80Value): boolean {
  const checked = assertBinary80(input);
  return checked.classification !== 'finite' || checked.significand !== 0n;
}

function signedSpecial(text: string, negative: boolean): Binary80Value | undefined {
  if (/^inf(?:inity)?$/i.test(text)) return binary80Infinity(negative);
  if (/^nan(?:\([a-z0-9_]*\))?$/i.test(text)) return binary80NaN(negative);
  return undefined;
}

function parseExponent(text: string): bigint {
  const negative = text.startsWith('-');
  const digits = text.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  // Source/token limits are around one million characters. Larger exponent
  // fields are already far outside that range, so saturate before BigInt parse.
  if (digits.length > 7) return negative ? -2_000_001n : 2_000_001n;
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

function parseDecimal(text: string, negative: boolean): Binary80Value | undefined {
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const whole = match[1] ?? '';
  const fractional = match[2] ?? match[3] ?? '';
  let digits = `${whole}${fractional}`.replace(/^0+/, '');
  if (!digits) return binary80Zero(negative);

  let decimalScale = parseExponent(match[4] ?? '0') - BigInt(fractional.length);
  const trailingZeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros);
    decimalScale += BigInt(trailingZeros);
  }

  let sticky = false;
  if (digits.length > MAX_DECIMAL_SIGNIFICANT_DIGITS) {
    const retained = digits.slice(0, MAX_DECIMAL_SIGNIFICANT_DIGITS);
    const tail = digits.slice(MAX_DECIMAL_SIGNIFICANT_DIGITS);
    sticky = /[1-9]/.test(tail);
    decimalScale += BigInt(tail.length);
    digits = retained;
  }

  const decimalOrder = BigInt(digits.length) + decimalScale - 1n;
  if (decimalOrder > 5000n) return binary80Infinity(negative);
  if (decimalOrder < -5000n) return binary80Zero(negative);
  const scale = Number(decimalScale);
  const numerator = BigInt(digits);
  if (scale >= 0) {
    return binary80FromRational(numerator * 10n ** BigInt(scale), 1n, { negative, sticky });
  }
  return binary80FromRational(numerator, 10n ** BigInt(-scale), { negative, sticky });
}

function parseHexadecimal(text: string, negative: boolean): Binary80Value | undefined {
  const match = /^0[xX]((?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP]([+-]?\d+)$/.exec(text);
  if (!match) return undefined;
  const point = match[1].indexOf('.');
  const fractionalLength = point < 0 ? 0 : match[1].length - point - 1;
  let digits = match[1].replace('.', '').replace(/^0+/, '');
  if (!digits) return binary80Zero(negative);

  let binaryExponent = parseExponent(match[2]) - BigInt(fractionalLength * 4);
  const trailingZeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros);
    binaryExponent += BigInt(trailingZeros * 4);
  }

  let sticky = false;
  if (digits.length > MAX_HEX_SIGNIFICANT_DIGITS) {
    const retained = digits.slice(0, MAX_HEX_SIGNIFICANT_DIGITS);
    const tail = digits.slice(MAX_HEX_SIGNIFICANT_DIGITS);
    sticky = /[1-9a-f]/i.test(tail);
    binaryExponent += BigInt(tail.length * 4);
    digits = retained;
  }

  const numerator = BigInt(`0x${digits}`);
  const topExponent = BigInt(bitLength(numerator) - 1) + binaryExponent;
  if (topExponent > 16383n) return binary80Infinity(negative);
  if (topExponent < -16447n) return binary80Zero(negative);
  return binary80FromRational(numerator, 1n, {
    binaryExponent: Number(binaryExponent),
    negative,
    sticky,
  });
}

/** Parse a C decimal or hexadecimal floating value directly into binary80. */
export function parseBinary80(input: string): Binary80Value {
  let text = input.trim();
  if (/[lL]$/.test(text)) text = text.slice(0, -1);
  let negative = false;
  if (text.startsWith('+') || text.startsWith('-')) {
    negative = text.startsWith('-');
    text = text.slice(1);
  }
  const special = signedSpecial(text, negative);
  if (special) return special;
  const parsed = /^0[xX]/.test(text) ? parseHexadecimal(text, negative) : parseDecimal(text, negative);
  if (!parsed) throw new SyntaxError(`Invalid binary80 floating-point literal: «${input}».`);
  return parsed;
}

/** Raw 80-bit x87 payload, little-endian: 64-bit significand then sign/exponent. */
export function binary80Encode80(input: Binary80Value): Uint8Array {
  const checked = assertBinary80(input);
  let significand: bigint;
  let exponentField: number;
  if (checked.classification === 'infinity') {
    significand = INTEGER_BIT;
    exponentField = 0x7fff;
  } else if (checked.classification === 'nan') {
    significand = QUIET_NAN;
    exponentField = 0x7fff;
  } else if (checked.significand === 0n) {
    significand = 0n;
    exponentField = 0;
  } else {
    const unbiasedExponent = checked.exponent + 63;
    if (checked.significand < INTEGER_BIT) {
      significand = checked.significand;
      exponentField = 0;
    } else {
      exponentField = unbiasedExponent + BINARY80_PROFILE.bias;
      if (exponentField <= 0 || exponentField >= 0x7fff) throw new RangeError('binary80 exponent out of range.');
      significand = checked.significand;
    }
  }

  const result = new Uint8Array(10);
  for (let index = 0; index < 8; index++) result[index] = Number((significand >> BigInt(index * 8)) & 0xffn);
  const signExponent = BigInt(exponentField | (checked.negative ? 0x8000 : 0));
  result[8] = Number(signExponent & 0xffn);
  result[9] = Number((signExponent >> 8n) & 0xffn);
  return result;
}

/** Decode a raw x87 80-bit payload (or the first ten bytes of 16-byte storage). */
export function binary80Decode80(input: ArrayLike<number>): Binary80Value {
  if (input.length < 10) throw new RangeError('The binary80 payload requires at least 10 bytes.');
  let significand = 0n;
  for (let index = 0; index < 8; index++) significand |= BigInt(input[index] & 0xff) << BigInt(index * 8);
  const signExponent = (input[8] & 0xff) | ((input[9] & 0xff) << 8);
  const negative = (signExponent & 0x8000) !== 0;
  const exponentField = signExponent & 0x7fff;

  if (exponentField === 0x7fff) {
    if (significand === INTEGER_BIT) return binary80Infinity(negative);
    return binary80NaN(negative);
  }
  if (exponentField === 0) {
    if (significand === 0n) return binary80Zero(negative);
    // Pseudo-denormals have the same value as the corresponding least normal.
    return value('finite', negative, significand, MIN_SUBNORMAL_EXPONENT);
  }
  if (significand < INTEGER_BIT) {
    // x87's unnormal encodings are not valid finite C values.
    return binary80NaN(negative);
  }
  return value('finite', negative, significand, exponentField - BINARY80_PROFILE.bias - 63);
}

function roundedHexFraction(fraction: bigint, discardedBits: number): bigint {
  if (discardedBits <= 0) return fraction << BigInt(-discardedBits);
  const shift = BigInt(discardedBits);
  const quotient = fraction >> shift;
  const remainder = fraction & ((1n << shift) - 1n);
  const halfway = 1n << (shift - 1n);
  return remainder > halfway || (remainder === halfway && (quotient & 1n) !== 0n)
    ? quotient + 1n : quotient;
}

/** Exact `%a`-style rendering, including sign and specials, without Number conversion. */
export function formatBinary80Hex(input: Binary80Value, precision?: number, uppercase = false): string {
  const checked = assertBinary80(input);
  if (precision !== undefined && (!Number.isSafeInteger(precision) || precision < 0 || precision > 100_000)) {
    throw new RangeError('The binary80 hexadecimal precision must be between 0 and 100000.');
  }
  const sign = checked.negative ? '-' : '';
  const prefix = uppercase ? '0X' : '0x';
  const marker = uppercase ? 'P' : 'p';
  const casing = (text: string): string => uppercase ? text.toUpperCase() : text;
  if (checked.classification === 'nan') return `${sign}${casing('nan')}`;
  if (checked.classification === 'infinity') return `${sign}${casing('inf')}`;
  if (checked.significand === 0n) {
    const fraction = precision === undefined || precision === 0 ? '' : `.${'0'.repeat(precision)}`;
    return `${sign}${prefix}0${fraction}${marker}+0`;
  }

  const normal = checked.significand >= INTEGER_BIT;
  const exponent = normal ? checked.exponent + 63 : MIN_NORMAL_EXPONENT;
  if (precision === 0) {
    let leading = roundedQuotient(checked.significand, INTEGER_BIT, false);
    let adjustedExponent = exponent;
    if (normal && leading >= 2n) {
      leading = 1n;
      adjustedExponent++;
    }
    return `${sign}${prefix}${leading}${marker}${adjustedExponent < 0 ? '' : '+'}${adjustedExponent}`;
  }
  const fractionBits = normal ? checked.significand - INTEGER_BIT : checked.significand;
  let leadingDigit = normal ? 1n : 0n;
  let fractionDigits: string;

  if (precision === undefined) {
    const nibbleCount = Math.ceil((PRECISION - 1) / 4);
    const padded = fractionBits << BigInt(nibbleCount * 4 - (PRECISION - 1));
    fractionDigits = padded.toString(16).padStart(nibbleCount, '0').replace(/0+$/, '');
  } else {
    const fractionWidth = precision * 4;
    const rounded = roundedHexFraction(fractionBits, (PRECISION - 1) - fractionWidth);
    const limit = 1n << BigInt(fractionWidth);
    let fraction = rounded;
    let adjustedExponent = exponent;
    if (fraction >= limit) {
      leadingDigit = 1n;
      fraction = 0n;
      if (normal) adjustedExponent++;
    }
    const exactExponent = adjustedExponent;
    fractionDigits = precision === 0 ? '' : fraction.toString(16).padStart(precision, '0');
    const body = `${leadingDigit}${precision ? `.${casing(fractionDigits)}` : ''}`;
    return `${sign}${prefix}${body}${marker}${exactExponent < 0 ? '' : '+'}${exactExponent}`;
  }

  const body = `${leadingDigit}${fractionDigits ? `.${casing(fractionDigits)}` : ''}`;
  return `${sign}${prefix}${body}${marker}${exponent < 0 ? '' : '+'}${exponent}`;
}
