import {
  binary80Add, binary80Compare, binary80FromRational, binary80Infinity, binary80NaN,
  binary80Subtract, binary80ToBigIntTrunc, binary80Zero,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import {
  FRACTION_BITS, MAX_EXP_ARGUMENT, SCALE, absolute, bitLength, fixedDivide,
  fixedMultiply, fixedSquareRoot, fromFixed, isZero, roundRatio, scaledRational,
  toFixed, topExponent,
} from './math-library-primitives.ts';

function atanhSeries(value: bigint): bigint {
  if (value === 0n) return 0n;
  const square = fixedMultiply(value, value);
  let power = value;
  let sum = value;
  for (let denominator = 3n; power !== 0n; denominator += 2n) {
    power = fixedMultiply(power, square);
    if (power === 0n) break;
    const term = power / denominator;
    if (term === 0n) break;
    sum += term;
  }
  return sum;
}

let ln2Cache: bigint | undefined;
function ln2Fixed(): bigint {
  if (ln2Cache === undefined) ln2Cache = 2n * atanhSeries(SCALE / 3n);
  return ln2Cache;
}

function logMantissa(mantissa: bigint): bigint {
  const z = fixedDivide(mantissa - SCALE, mantissa + SCALE);
  return 2n * atanhSeries(z);
}

export function logFixed(value: bigint): bigint {
  if (value <= 0n) throw new RangeError('A positive fixed-point value is required.');
  const exponent = bitLength(value) - 1 - FRACTION_BITS;
  const mantissa = exponent >= 0 ? value >> BigInt(exponent) : value << BigInt(-exponent);
  return logMantissa(mantissa) + BigInt(exponent) * ln2Fixed();
}

export function logBinary80(value: Binary80Value): bigint {
  const significandBits = bitLength(value.significand) - 1;
  const mantissa = value.significand << BigInt(FRACTION_BITS - significandBits);
  const exponent = value.exponent + significandBits;
  return logMantissa(mantissa) + BigInt(exponent) * ln2Fixed();
}

interface ExponentialParts { readonly significand: bigint; readonly exponent: number }
export function expParts(value: bigint): ExponentialParts | undefined {
  const bound = MAX_EXP_ARGUMENT * SCALE;
  if (value > bound || value < -bound) return undefined;
  const ln2 = ln2Fixed();
  const exponent = roundRatio(value, ln2);
  const remainder = value - exponent * ln2;
  let term = SCALE;
  let sum = SCALE;
  for (let denominator = 1n; term !== 0n; denominator++) {
    term = (term * remainder / SCALE) / denominator;
    if (term === 0n) break;
    sum += term;
  }
  return { significand: sum, exponent: Number(exponent) - FRACTION_BITS };
}

export function partsToBinary80(parts: ExponentialParts, negative = false): Binary80Value {
  return scaledRational(parts.significand, parts.exponent, negative);
}

export function expBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80Zero() : value;
  if (value.significand === 0n) return binary80FromRational(1n);
  if (topExponent(value) < -64) return binary80FromRational(1n);
  const parts = expParts(toFixed(value));
  if (!parts) return value.negative ? binary80Zero() : binary80Infinity();
  return partsToBinary80(parts);
}

export function expm1Binary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80FromRational(1n, 1n, { negative: true }) : value;
  if (value.significand === 0n) return value;
  if (topExponent(value) < -64) return value;
  const parts = expParts(toFixed(value));
  if (!parts) return value.negative ? binary80FromRational(1n, 1n, { negative: true }) : binary80Infinity();
  const commonExponent = Math.min(parts.exponent, 0);
  const exponential = parts.significand << BigInt(parts.exponent - commonExponent);
  const one = 1n << BigInt(-commonExponent);
  return binary80FromRational(exponential > one ? exponential - one : one - exponential, 1n, {
    binaryExponent: commonExponent,
    negative: exponential < one,
  });
}

export function logBinary80Result(value: Binary80Value, base: 'log' | 'log2' | 'log10'): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80NaN() : value;
  if (value.significand === 0n) return binary80Infinity(true);
  if (value.negative) return binary80NaN();
  if (base === 'log2' && (value.significand & (value.significand - 1n)) === 0n) {
    const exponent = value.exponent + bitLength(value.significand) - 1;
    return binary80FromRational(BigInt(Math.abs(exponent)), 1n, { negative: exponent < 0 });
  }
  const natural = logBinary80(value);
  if (base === 'log') return fromFixed(natural);
  if (base === 'log2') return fromFixed(fixedDivide(natural, ln2Fixed()));
  const ln10 = logFixed(10n * SCALE);
  return fromFixed(fixedDivide(natural, ln10));
}

export function log1pBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80NaN() : value;
  if (value.significand === 0n) return value;
  if (value.negative && binary80Compare(absolute(value), binary80FromRational(1n)) !== -1) {
    return isZero(binary80Add(value, binary80FromRational(1n))) ? binary80Infinity(true) : binary80NaN();
  }
  if (topExponent(value) < -64) return value;
  const shifted = binary80Add(binary80FromRational(1n), value);
  return logBinary80Result(shifted, 'log');
}

export function exp2Binary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80Zero() : value;
  if (isZero(value)) return binary80FromRational(1n);
  if (topExponent(value) < -64) return binary80FromRational(1n);
  if (topExponent(value) > 14) return value.negative ? binary80Zero() : binary80Infinity();
  const integer = binary80ToBigIntTrunc(value);
  const integerValue = binary80FromRational(integer < 0n ? -integer : integer, 1n, { negative: integer < 0n });
  const fractional = binary80Subtract(value, integerValue);
  const fractionalFixed = toFixed(fractional);
  const parts = expParts(fixedMultiply(fractionalFixed, ln2Fixed()));
  if (!parts) return binary80Infinity();
  return scaledRational(parts.significand, parts.exponent + Number(integer));
}

export function asinHyperbolic(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80Infinity(true) : value;
  if (isZero(value) || topExponent(value) < -32) return value;
  const magnitude = absolute(value);
  const x = toFixed(magnitude);
  const square = fixedMultiply(x, x);
  const root = fixedSquareRoot(square + SCALE);
  const result = logFixed(x + root);
  return fromFixed(value.negative ? -result : result);
}

export function acosHyperbolic(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.negative || value.classification === 'finite' && binary80Compare(value, binary80FromRational(1n)) === -1) return binary80NaN();
  if (value.classification === 'infinity') return value;
  if (binary80Compare(value, binary80FromRational(1n)) === 0) return binary80Zero();
  if (topExponent(value) > 128) return fromFixed(logBinary80(value));
  const x = toFixed(value);
  const root = fixedSquareRoot(fixedMultiply(x - SCALE, x + SCALE));
  return fromFixed(logFixed(x + root));
}

export function atanhHyperbolic(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return binary80NaN();
  if (isZero(value)) return value;
  const comparison = binary80Compare(absolute(value), binary80FromRational(1n));
  if (comparison !== -1) return comparison === 0 ? binary80Infinity(value.negative) : binary80NaN();
  if (topExponent(value) < -64) return value;
  const fixed = toFixed(value);
  const numerator = SCALE + fixed;
  const denominator = SCALE - fixed;
  return fromFixed(logFixed(fixedDivide(numerator, denominator)) / 2n);
}

export function sinhCoshTanh(value: Binary80Value, name: 'sinh' | 'cosh' | 'tanh'): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') {
    if (name === 'cosh') return binary80Infinity();
    if (name === 'tanh') return binary80FromRational(1n, 1n, { negative: value.negative });
    return value;
  }
  if (isZero(value)) return name === 'cosh' ? binary80FromRational(1n) : value;
  if (topExponent(value) < -32) return name === 'cosh' ? binary80FromRational(1n) : value;
  const magnitude = absolute(value);
  if (name === 'tanh' && topExponent(magnitude) >= 5) return binary80FromRational(1n, 1n, { negative: value.negative });
  const x = toFixed(magnitude);
  if (name === 'tanh') {
    const decay = expParts(-2n * x);
    if (!decay) return binary80FromRational(1n, 1n, { negative: value.negative });
    const commonExponent = Math.min(decay.exponent, 0);
    const small = decay.significand << BigInt(decay.exponent - commonExponent);
    const one = 1n << BigInt(-commonExponent);
    const numerator = one - small;
    const denominator = one + small;
    return binary80FromRational(numerator, denominator, {
      binaryExponent: 0,
      negative: value.negative,
    });
  }
  const positive = expParts(x);
  if (!positive) return name === 'cosh' || !value.negative ? binary80Infinity() : binary80Infinity(true);
  const negative = expParts(-x);
  if (!negative) return binary80Infinity(name === 'sinh' && value.negative);
  const commonExponent = Math.min(positive.exponent, negative.exponent);
  const a = positive.significand << BigInt(positive.exponent - commonExponent);
  const b = negative.significand << BigInt(negative.exponent - commonExponent);
  if (name === 'sinh') {
    const difference = a - b;
    return binary80FromRational(difference, 1n, {
      binaryExponent: commonExponent - 1,
      negative: value.negative,
    });
  }
  return binary80FromRational(a + b, 1n, { binaryExponent: commonExponent - 1 });
}
