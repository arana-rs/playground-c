import { binary80FromRational, binary80Zero } from './binary80.ts';
import type { Binary80Value } from './binary80.ts';

export const FRACTION_BITS = 256;
export const SCALE = 1n << BigInt(FRACTION_BITS);
const SQRT_GUARD_BITS = 112;
export const PI_BITS = 16_700;
export const PI_LOW_SHIFT = BigInt(PI_BITS - FRACTION_BITS);
export const MAX_EXP_ARGUMENT = 12_000n;

export function bitLength(value: bigint): number {
  return value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length;
}

export function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError('Cannot take the integer square root of a negative value.');
  if (value < 2n) return value;
  let estimate = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function integerCubeRoot(value: bigint): bigint {
  if (value < 0n) throw new RangeError('Cannot take the integer cube root of a negative value.');
  if (value < 2n) return value;
  let estimate = 1n << BigInt(Math.ceil(bitLength(value) / 3));
  while (true) {
    const next = (2n * estimate + value / (estimate * estimate)) / 3n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const twice = remainder << 1n;
  if (twice > denominator || (twice === denominator && (quotient & 1n) !== 0n)) quotient++;
  return negative ? -quotient : quotient;
}

export function fixedMultiply(left: bigint, right: bigint): bigint {
  return (left * right) / SCALE;
}

export function fixedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Fixed-point division by zero.');
  return (numerator * SCALE) / denominator;
}

export function toFixed(value: Binary80Value): bigint {
  if (value.classification !== 'finite') throw new RangeError('A finite binary80 value is required.');
  const shift = value.exponent + FRACTION_BITS;
  const magnitude = shift >= 0 ? value.significand << BigInt(shift) : value.significand >> BigInt(-shift);
  return value.negative ? -magnitude : magnitude;
}

export function fromFixed(value: bigint, negativeZero = false): Binary80Value {
  if (value === 0n) return binary80Zero(negativeZero);
  return binary80FromRational(value < 0n ? -value : value, 1n, {
    binaryExponent: -FRACTION_BITS,
    negative: value < 0n,
  });
}

export function scaledRational(value: bigint, exponent: number, negative = false): Binary80Value {
  if (value === 0n) return binary80Zero(negative);
  return binary80FromRational(value < 0n ? -value : value, 1n, {
    binaryExponent: exponent,
    negative: negative !== (value < 0n),
  });
}

export function isZero(value: Binary80Value): boolean {
  return value.classification === 'finite' && value.significand === 0n;
}

function isFinite(value: Binary80Value): boolean {
  return value.classification === 'finite';
}

export function topExponent(value: Binary80Value): number {
  return value.significand === 0n ? Number.NEGATIVE_INFINITY : value.exponent + bitLength(value.significand) - 1;
}

export function absolute(value: Binary80Value): Binary80Value {
  if (!value.negative) return value;
  return Object.freeze({ ...value, negative: false });
}

export function signed(value: Binary80Value, negative: boolean): Binary80Value {
  if (value.negative === negative) return value;
  return Object.freeze({ ...value, negative });
}

export function exactInteger(value: Binary80Value): { integer: bigint; odd: boolean } | undefined {
  if (!isFinite(value)) return undefined;
  if (value.significand === 0n) return { integer: 0n, odd: false };
  let magnitude: bigint;
  if (value.exponent >= 0) magnitude = value.significand << BigInt(value.exponent);
  else {
    const shift = -value.exponent;
    if (shift >= bitLength(value.significand)) return undefined;
    const mask = (1n << BigInt(shift)) - 1n;
    if ((value.significand & mask) !== 0n) return undefined;
    magnitude = value.significand >> BigInt(shift);
  }
  return { integer: value.negative ? -magnitude : magnitude, odd: (magnitude & 1n) !== 0n };
}

export function sqrtRational(numerator: bigint, binaryExponent: number, negative = false): Binary80Value {
  if (numerator === 0n) return binary80Zero(negative);
  const top = bitLength(numerator) - 1 + binaryExponent;
  const rootTop = Math.floor(top / 2);
  const targetBits = 63 + SQRT_GUARD_BITS;
  const shift = binaryExponent + 2 * (targetBits - rootTop);
  const scaled = shift >= 0 ? numerator << BigInt(shift) : numerator >> BigInt(-shift);
  const root = integerSqrt(scaled);
  const exact = shift >= 0
    ? root * root === scaled
    : (root * root << BigInt(-shift)) === numerator;
  return binary80FromRational(root, 1n, {
    binaryExponent: rootTop - targetBits,
    negative,
    sticky: !exact,
  });
}

export function cbrtRational(numerator: bigint, binaryExponent: number, negative = false): Binary80Value {
  if (numerator === 0n) return binary80Zero(negative);
  const top = bitLength(numerator) - 1 + binaryExponent;
  const rootTop = Math.floor(top / 3);
  const targetBits = 63 + SQRT_GUARD_BITS;
  const shift = binaryExponent + 3 * (targetBits - rootTop);
  const scaled = shift >= 0 ? numerator << BigInt(shift) : numerator >> BigInt(-shift);
  const root = integerCubeRoot(scaled);
  const exact = shift >= 0
    ? root * root * root === scaled
    : (root * root * root << BigInt(-shift)) === numerator;
  return binary80FromRational(root, 1n, {
    binaryExponent: rootTop - targetBits,
    negative,
    sticky: !exact,
  });
}

export function roundedIntegral(value: Binary80Value, mode: 'floor' | 'ceil' | 'trunc' | 'round' | 'nearestEven'): Binary80Value {
  if (value.classification !== 'finite' || value.significand === 0n) return value;
  let magnitude: bigint;
  if (value.exponent >= 0) magnitude = value.significand << BigInt(value.exponent);
  else {
    const shift = -value.exponent;
    const integer = value.significand >> BigInt(shift);
    const remainder = value.significand - (integer << BigInt(shift));
    const hasFraction = remainder !== 0n;
    if (mode === 'floor') magnitude = value.negative && hasFraction ? integer + 1n : integer;
    else if (mode === 'ceil') magnitude = !value.negative && hasFraction ? integer + 1n : integer;
    else if (mode === 'round' && (remainder << 1n) >= (1n << BigInt(shift))) magnitude = integer + 1n;
    else if (mode === 'nearestEven' && ((remainder << 1n) > (1n << BigInt(shift)) ||
      (remainder << 1n) === (1n << BigInt(shift)) && (integer & 1n) !== 0n)) magnitude = integer + 1n;
    else magnitude = integer;
  }
  return binary80FromRational(magnitude, 1n, { negative: value.negative });
}

export function roundedInteger(value: Binary80Value, ties: 'even' | 'away'): bigint {
  if (value.classification !== 'finite') throw new RangeError('A finite binary80 value is required.');
  if (value.significand === 0n) return 0n;
  let magnitude: bigint;
  if (value.exponent >= 0) magnitude = value.significand << BigInt(value.exponent);
  else {
    const shift = -value.exponent;
    const integer = value.significand >> BigInt(shift);
    const remainder = value.significand - (integer << BigInt(shift));
    const half = 1n << BigInt(shift - 1);
    const greaterThanHalf = remainder > half;
    const exactlyHalf = remainder === half;
    magnitude = integer + (greaterThanHalf || exactlyHalf && (ties === 'away' || (integer & 1n) !== 0n) ? 1n : 0n);
  }
  return value.negative ? -magnitude : magnitude;
}

export function fixedSquareRoot(value: bigint): bigint {
  return integerSqrt(value * SCALE);
}
