import {
  BINARY80_PROFILE,
  binary80Add, binary80Compare, binary80FromRational, binary80Infinity, binary80NaN, binary80NextAfter,
  binary80Subtract, binary80ToBigIntTrunc, binary80Zero,
} from './binary80.ts';
import type { Binary80Value, BinaryFloatFormat } from './binary80.ts';
import {
  MATH_BINARY_FUNCTIONS, MATH_INTEGER_RETURN_FUNCTIONS, MATH_OUT_UNARY_FUNCTIONS,
  MATH_SCALING_FUNCTIONS,
  MATH_UNARY_FUNCTIONS,
} from './math-metadata.ts';

const FRACTION_BITS = 256;
const SCALE = 1n << BigInt(FRACTION_BITS);
const SQRT_GUARD_BITS = 112;
const PI_BITS = 16_700;
const PI_LOW_SHIFT = BigInt(PI_BITS - FRACTION_BITS);
const MAX_EXP_ARGUMENT = 12_000n;

function bitLength(value: bigint): number {
  return value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length;
}

function integerSqrt(value: bigint): bigint {
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

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const twice = remainder << 1n;
  if (twice > denominator || (twice === denominator && (quotient & 1n) !== 0n)) quotient++;
  return negative ? -quotient : quotient;
}

function fixedMultiply(left: bigint, right: bigint): bigint {
  return (left * right) / SCALE;
}

function fixedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Fixed-point division by zero.');
  return (numerator * SCALE) / denominator;
}

function toFixed(value: Binary80Value): bigint {
  if (value.classification !== 'finite') throw new RangeError('A finite binary80 value is required.');
  const shift = value.exponent + FRACTION_BITS;
  const magnitude = shift >= 0 ? value.significand << BigInt(shift) : value.significand >> BigInt(-shift);
  return value.negative ? -magnitude : magnitude;
}

function fromFixed(value: bigint, negativeZero = false): Binary80Value {
  if (value === 0n) return binary80Zero(negativeZero);
  return binary80FromRational(value < 0n ? -value : value, 1n, {
    binaryExponent: -FRACTION_BITS,
    negative: value < 0n,
  });
}

function scaledRational(value: bigint, exponent: number, negative = false): Binary80Value {
  if (value === 0n) return binary80Zero(negative);
  return binary80FromRational(value < 0n ? -value : value, 1n, {
    binaryExponent: exponent,
    negative: negative !== (value < 0n),
  });
}

function isZero(value: Binary80Value): boolean {
  return value.classification === 'finite' && value.significand === 0n;
}

function isFinite(value: Binary80Value): boolean {
  return value.classification === 'finite';
}

function topExponent(value: Binary80Value): number {
  return value.significand === 0n ? Number.NEGATIVE_INFINITY : value.exponent + bitLength(value.significand) - 1;
}

function absolute(value: Binary80Value): Binary80Value {
  if (!value.negative) return value;
  return Object.freeze({ ...value, negative: false });
}

function signed(value: Binary80Value, negative: boolean): Binary80Value {
  if (value.negative === negative) return value;
  return Object.freeze({ ...value, negative });
}

function exactInteger(value: Binary80Value): { integer: bigint; odd: boolean } | undefined {
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

function sqrtRational(numerator: bigint, binaryExponent: number, negative = false): Binary80Value {
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

function cbrtRational(numerator: bigint, binaryExponent: number, negative = false): Binary80Value {
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

function roundedIntegral(value: Binary80Value, mode: 'floor' | 'ceil' | 'trunc' | 'round' | 'nearestEven'): Binary80Value {
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

function roundedInteger(value: Binary80Value, ties: 'even' | 'away'): bigint {
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

function logFixed(value: bigint): bigint {
  if (value <= 0n) throw new RangeError('A positive fixed-point value is required.');
  const exponent = bitLength(value) - 1 - FRACTION_BITS;
  const mantissa = exponent >= 0 ? value >> BigInt(exponent) : value << BigInt(-exponent);
  return logMantissa(mantissa) + BigInt(exponent) * ln2Fixed();
}

function logBinary80(value: Binary80Value): bigint {
  const significandBits = bitLength(value.significand) - 1;
  const mantissa = value.significand << BigInt(FRACTION_BITS - significandBits);
  const exponent = value.exponent + significandBits;
  return logMantissa(mantissa) + BigInt(exponent) * ln2Fixed();
}

interface ExponentialParts { readonly significand: bigint; readonly exponent: number }
function expParts(value: bigint): ExponentialParts | undefined {
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

function partsToBinary80(parts: ExponentialParts, negative = false): Binary80Value {
  return scaledRational(parts.significand, parts.exponent, negative);
}

function expBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80Zero() : value;
  if (value.significand === 0n) return binary80FromRational(1n);
  if (topExponent(value) < -64) return binary80FromRational(1n);
  const parts = expParts(toFixed(value));
  if (!parts) return value.negative ? binary80Zero() : binary80Infinity();
  return partsToBinary80(parts);
}

function expm1Binary80(value: Binary80Value): Binary80Value {
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

function fixedSquareRoot(value: bigint): bigint {
  return integerSqrt(value * SCALE);
}

function fixedAtanSeries(value: bigint): bigint {
  const square = fixedMultiply(value, value);
  let power = value;
  let sum = value;
  for (let denominator = 3n; power !== 0n; denominator += 2n) {
    power = fixedMultiply(power, square);
    if (power === 0n) break;
    const term = power / denominator;
    if (term === 0n) break;
    sum += denominator % 4n === 3n ? -term : term;
  }
  return sum;
}

function binarySplitPi(a: number, b: number): { p: bigint; q: bigint; t: bigint } {
  if (b - a === 1) {
    if (a === 0) return { p: 1n, q: 1n, t: 13_591_409n };
    const index = BigInt(a);
    const p = BigInt(6 * a - 5) * BigInt(2 * a - 1) * BigInt(6 * a - 1);
    const q = index * index * index * 10_939_058_860_032_000n;
    const t = p * (13_591_409n + 545_140_134n * index);
    return { p, q, t: a % 2 === 0 ? t : -t };
  }
  const middle = (a + b) >> 1;
  const left = binarySplitPi(a, middle);
  const right = binarySplitPi(middle, b);
  return {
    p: left.p * right.p,
    q: left.q * right.q,
    t: left.t * right.q + left.p * right.t,
  };
}

let piScaledCache: bigint | undefined;
function piScaled(): bigint {
  if (piScaledCache !== undefined) return piScaledCache;
  const calculationBits = PI_BITS + 64;
  const terms = Math.ceil(calculationBits / 44) + 4;
  const split = binarySplitPi(0, terms);
  const squareRoot = integerSqrt(10_005n << BigInt(2 * calculationBits));
  const highPrecision = 426_880n * squareRoot * split.q / split.t;
  piScaledCache = highPrecision >> 64n;
  return piScaledCache;
}

function piFixed(): bigint {
  return piScaled() >> PI_LOW_SHIFT;
}

function atanFixed(value: bigint): bigint {
  if (value < 0n) return -atanFixed(-value);
  const one = SCALE;
  const halfPi = piFixed() / 2n;
  if (value > one) return halfPi - atanFixed(fixedDivide(one, value));
  const sqrtTwoMinusOne = fixedSquareRoot(2n * SCALE) - one;
  if (value > sqrtTwoMinusOne) {
    const quarterPi = piFixed() / 4n;
    return quarterPi + atanFixed(fixedDivide(value - one, value + one));
  }
  return fixedAtanSeries(value);
}

function atan2Fixed(y: bigint, x: bigint): bigint {
  const pi = piFixed();
  const halfPi = pi / 2n;
  if (x === 0n) return y < 0n ? -halfPi : halfPi;
  const angle = atanFixed(fixedDivide(y, x));
  if (x > 0n) return angle;
  return y < 0n ? angle - pi : angle + pi;
}

function signedRatioFixed(numerator: Binary80Value, denominator: Binary80Value): bigint {
  const shift = numerator.exponent - denominator.exponent + FRACTION_BITS;
  const bottom = denominator.significand;
  const ratio = shift >= 0 ? (numerator.significand << BigInt(shift)) / bottom
    : numerator.significand / (bottom << BigInt(-shift));
  return numerator.negative !== denominator.negative ? -ratio : ratio;
}

function reducedTrig(value: Binary80Value): { quadrant: number; remainder: bigint } {
  const scaledInput = value.significand << BigInt(value.exponent + PI_BITS);
  const signedInput = value.negative ? -scaledInput : scaledInput;
  const halfPi = piScaled() >> 1n;
  const quadrantIndex = roundRatio(signedInput, halfPi);
  const highRemainder = signedInput - quadrantIndex * halfPi;
  return {
    quadrant: Number((quadrantIndex % 4n + 4n) % 4n),
    remainder: highRemainder >> BigInt(PI_BITS - FRACTION_BITS),
  };
}

function fixedSine(value: bigint): bigint {
  const square = fixedMultiply(value, value);
  let term = value;
  let sum = value;
  for (let index = 1n; term !== 0n; index++) {
    term = -fixedMultiply(term, square) / ((2n * index) * (2n * index + 1n));
    if (term === 0n) break;
    sum += term;
  }
  return sum;
}

function fixedCosine(value: bigint): bigint {
  const square = fixedMultiply(value, value);
  let term = SCALE;
  let sum = SCALE;
  for (let index = 1n; term !== 0n; index++) {
    term = -fixedMultiply(term, square) / ((2n * index - 1n) * (2n * index));
    if (term === 0n) break;
    sum += term;
  }
  return sum;
}

function trigBinary80(name: 'sin' | 'cos' | 'tan', value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return binary80NaN();
  if (isZero(value)) return name === 'cos' ? binary80FromRational(1n) : value;
  if (topExponent(value) < -64) return name === 'cos' ? binary80FromRational(1n) : value;
  const { quadrant, remainder } = reducedTrig(value);
  const sine = fixedSine(remainder);
  const cosine = fixedCosine(remainder);
  if (name === 'sin') return fromFixed(quadrant === 0 ? sine : quadrant === 1 ? cosine : quadrant === 2 ? -sine : -cosine);
  if (name === 'cos') return fromFixed(quadrant === 0 ? cosine : quadrant === 1 ? -sine : quadrant === 2 ? -cosine : sine);
  const numerator = quadrant % 2 === 0 ? sine : cosine;
  const denominator = quadrant % 2 === 0 ? cosine : -sine;
  if (denominator === 0n) return binary80Infinity(numerator < 0n);
  return binary80FromRational(numerator < 0n ? -numerator : numerator, denominator < 0n ? -denominator : denominator, {
    binaryExponent: -FRACTION_BITS,
    negative: (numerator < 0n) !== (denominator < 0n),
  });
}

function asinBinary80(value: Binary80Value): Binary80Value {
  if (value.classification !== 'finite') return value.classification === 'nan' ? value : binary80NaN();
  if (isZero(value)) return value;
  const comparison = binary80Compare(absolute(value), binary80FromRational(1n));
  if (comparison === 1) return binary80NaN();
  if (comparison === 0) return scaledRational(piFixed(), -FRACTION_BITS - 1, value.negative);
  if (topExponent(value) < -64) return value;
  const input = toFixed(value);
  const complement = SCALE - fixedMultiply(input, input);
  const root = fixedSquareRoot(complement);
  return fromFixed(atan2Fixed(input, root));
}

function acosBinary80(value: Binary80Value): Binary80Value {
  if (value.classification !== 'finite') return value.classification === 'nan' ? value : binary80NaN();
  const comparison = binary80Compare(absolute(value), binary80FromRational(1n));
  if (comparison === 1) return binary80NaN();
  if (isZero(value)) return scaledRational(piFixed(), -FRACTION_BITS - 1);
  if (comparison === 0) return value.negative ? scaledRational(piFixed(), -FRACTION_BITS) : binary80Zero();
  const input = toFixed(value);
  const complement = SCALE - fixedMultiply(input, input);
  const root = fixedSquareRoot(complement);
  return fromFixed(atan2Fixed(root, input));
}

function atanBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  const halfPi = piFixed() / 2n;
  if (value.classification === 'infinity') return scaledRational(halfPi, -FRACTION_BITS, value.negative);
  if (isZero(value) || topExponent(value) < -64) return value;
  return fromFixed(atanFixed(toFixed(value)));
}

function logBinary80Result(value: Binary80Value, base: 'log' | 'log2' | 'log10'): Binary80Value {
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

function log1pBinary80(value: Binary80Value): Binary80Value {
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

function exp2Binary80(value: Binary80Value): Binary80Value {
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

function sqrtBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80NaN() : value;
  if (value.significand === 0n) return value;
  if (value.negative) return binary80NaN();
  return sqrtRational(value.significand, value.exponent);
}

function cbrtBinary80(value: Binary80Value): Binary80Value {
  if (value.classification !== 'finite') return value;
  return cbrtRational(value.significand, value.exponent, value.negative);
}

function asinHyperbolic(value: Binary80Value): Binary80Value {
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

function acosHyperbolic(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.negative || value.classification === 'finite' && binary80Compare(value, binary80FromRational(1n)) === -1) return binary80NaN();
  if (value.classification === 'infinity') return value;
  if (binary80Compare(value, binary80FromRational(1n)) === 0) return binary80Zero();
  if (topExponent(value) > 128) return fromFixed(logBinary80(value));
  const x = toFixed(value);
  const root = fixedSquareRoot(fixedMultiply(x - SCALE, x + SCALE));
  return fromFixed(logFixed(x + root));
}

function atanhHyperbolic(value: Binary80Value): Binary80Value {
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

function fmodBinary80(left: Binary80Value, right: Binary80Value): Binary80Value {
  if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN();
  if (left.classification === 'infinity' || isZero(right)) return binary80NaN();
  if (right.classification === 'infinity' || isZero(left)) return left;
  const commonExponent = Math.min(left.exponent, right.exponent);
  const numerator = left.significand << BigInt(left.exponent - commonExponent);
  const denominator = right.significand << BigInt(right.exponent - commonExponent);
  const remainder = numerator % denominator;
  return binary80FromRational(remainder, 1n, {
    binaryExponent: commonExponent,
    negative: left.negative,
  });
}

function hypotBinary80(left: Binary80Value, right: Binary80Value): Binary80Value {
  if (left.classification === 'infinity' || right.classification === 'infinity') return binary80Infinity();
  if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN();
  if (isZero(left) && isZero(right)) return binary80Zero();
  const leftExponent = left.exponent * 2;
  const rightExponent = right.exponent * 2;
  const commonExponent = Math.min(leftExponent, rightExponent);
  const leftSquare = left.significand * left.significand << BigInt(leftExponent - commonExponent);
  const rightSquare = right.significand * right.significand << BigInt(rightExponent - commonExponent);
  return sqrtRational(leftSquare + rightSquare, commonExponent);
}

function powBinary80(baseInput: Binary80Value, power: Binary80Value): Binary80Value {
  const base = baseInput;
  const powerInteger = exactInteger(power);
  if (isZero(power) || base.classification === 'finite' && !base.negative && base.significand === (1n << 63n) && base.exponent === -63) {
    return binary80FromRational(1n);
  }
  if (base.classification === 'nan' || power.classification === 'nan') return binary80NaN();

  const baseMagnitude = absolute(base);
  if (power.classification === 'infinity') {
    const comparison = base.classification === 'infinity' ? 1 : binary80Compare(baseMagnitude, binary80FromRational(1n));
    if (comparison === 0) return binary80FromRational(1n);
    const grows = (comparison ?? 0) > 0 !== power.negative;
    return grows ? binary80Infinity() : binary80Zero();
  }

  if (base.classification === 'infinity') {
    const negativeResult = base.negative && !!powerInteger?.odd;
    return power.negative ? binary80Zero(negativeResult) : binary80Infinity(negativeResult);
  }
  if (isZero(base)) {
    const negativeResult = base.negative && !!powerInteger?.odd;
    return power.negative ? binary80Infinity(negativeResult) : binary80Zero(negativeResult);
  }
  if (base.negative && !powerInteger) return binary80NaN();

  if (powerInteger && powerInteger.integer >= -1024n && powerInteger.integer <= 1024n) {
    const exponent = powerInteger.integer < 0n ? -powerInteger.integer : powerInteger.integer;
    const numerator = baseMagnitude.significand ** exponent;
    const binaryExponent = baseMagnitude.exponent * Number(exponent);
    const negative = base.negative && powerInteger.odd;
    if (powerInteger.integer >= 0n) return binary80FromRational(numerator, 1n, { binaryExponent, negative });
    return binary80FromRational(1n, numerator, { binaryExponent: -binaryExponent, negative });
  }

  const logarithm = logBinary80(baseMagnitude);
  const exponent = fixedMultiply(logarithm, toFixed(power));
  if (exponent > MAX_EXP_ARGUMENT * SCALE) return binary80Infinity(base.negative && !!powerInteger?.odd);
  if (exponent < -MAX_EXP_ARGUMENT * SCALE) return binary80Zero(base.negative && !!powerInteger?.odd);
  const parts = expParts(exponent);
  if (!parts) return exponent < 0n ? binary80Zero(base.negative && !!powerInteger?.odd) : binary80Infinity(base.negative && !!powerInteger?.odd);
  return partsToBinary80(parts, base.negative && !!powerInteger?.odd);
}

function atan2Binary80(y: Binary80Value, x: Binary80Value): Binary80Value {
  if (y.classification === 'nan' || x.classification === 'nan') return binary80NaN();
  const pi = piFixed();
  const halfPi = pi / 2n;
  const quarterPi = pi / 4n;
  if (y.classification === 'infinity' && x.classification === 'infinity') {
    const angle = x.negative ? 3n * quarterPi : quarterPi;
    return scaledRational(angle, -FRACTION_BITS, y.negative);
  }
  if (y.classification === 'infinity') return scaledRational(halfPi, -FRACTION_BITS, y.negative);
  if (x.classification === 'infinity') {
    if (!x.negative) return binary80Zero(y.negative);
    return scaledRational(pi, -FRACTION_BITS, y.negative);
  }
  if (isZero(y)) {
    if (!x.negative) return y;
    return scaledRational(pi, -FRACTION_BITS, y.negative);
  }
  if (isZero(x)) return scaledRational(halfPi, -FRACTION_BITS, y.negative);
  const ratio = signedRatioFixed(y, x);
  return fromFixed(atan2Fixed(ratio, SCALE));
}

function minimumMaximum(left: Binary80Value, right: Binary80Value, maximum: boolean): Binary80Value {
  if (left.classification === 'nan') return right.classification === 'nan' ? binary80NaN() : right;
  if (right.classification === 'nan') return left;
  const comparison = binary80Compare(left, right);
  if (comparison === 0) {
    if (isZero(left) && isZero(right)) return binary80Zero(maximum ? left.negative && right.negative : left.negative || right.negative);
    return left;
  }
  return (comparison ?? 0) > 0 === maximum ? left : right;
}

function remainderBinary80(left: Binary80Value, right: Binary80Value): { value: Binary80Value; quotient: bigint } {
  if (left.classification === 'nan' || right.classification === 'nan' ||
      left.classification === 'infinity' || isZero(right)) {
    return { value: binary80NaN(), quotient: 0n };
  }
  if (right.classification === 'infinity' || isZero(left)) return { value: left, quotient: 0n };
  const exponentDifference = left.exponent - right.exponent;
  const ratioNumerator = exponentDifference >= 0
    ? left.significand << BigInt(exponentDifference) : left.significand;
  const ratioDenominator = exponentDifference >= 0
    ? right.significand : right.significand << BigInt(-exponentDifference);
  let quotientMagnitude = ratioNumerator / ratioDenominator;
  const ratioRemainder = ratioNumerator % ratioDenominator;
  const twiceRemainder = ratioRemainder << 1n;
  if (twiceRemainder > ratioDenominator ||
      twiceRemainder === ratioDenominator && (quotientMagnitude & 1n) !== 0n) quotientMagnitude++;
  const quotient = left.negative !== right.negative ? -quotientMagnitude : quotientMagnitude;

  const commonExponent = Math.min(left.exponent, right.exponent);
  const leftInteger = left.significand << BigInt(left.exponent - commonExponent);
  const rightInteger = right.significand << BigInt(right.exponent - commonExponent);
  const signedLeft = left.negative ? -leftInteger : leftInteger;
  const signedRight = right.negative ? -rightInteger : rightInteger;
  const remainder = signedLeft - quotient * signedRight;
  return {
    value: binary80FromRational(remainder < 0n ? -remainder : remainder, 1n, {
      binaryExponent: commonExponent,
      negative: remainder === 0n ? left.negative : remainder < 0n,
    }),
    quotient,
  };
}

function frexpBinary80(value: Binary80Value): { value: Binary80Value; exponent: bigint } {
  if (value.classification !== 'finite' || isZero(value)) return { value, exponent: 0n };
  const exponent = topExponent(value) + 1;
  return {
    value: binary80FromRational(value.significand, 1n, {
      binaryExponent: value.exponent - exponent,
      negative: value.negative,
    }),
    exponent: BigInt(exponent),
  };
}

function modfBinary80(value: Binary80Value): { value: Binary80Value; integral: Binary80Value } {
  if (value.classification !== 'finite') return { value: value.classification === 'nan' ? value : binary80Zero(value.negative), integral: value };
  if (isZero(value)) return { value, integral: value };
  if (value.exponent >= 0) return { value: binary80Zero(value.negative), integral: value };
  const shift = -value.exponent;
  const integralSignificand = value.significand >> BigInt(shift);
  const remainder = value.significand - (integralSignificand << BigInt(shift));
  return {
    value: binary80FromRational(remainder, 1n, { binaryExponent: value.exponent, negative: value.negative }),
    integral: binary80FromRational(integralSignificand, 1n, { negative: value.negative }),
  };
}

function scalePowerOfTwo(value: Binary80Value, exponent: bigint): { value: Binary80Value; error?: MathError } {
  if (value.classification !== 'finite' || isZero(value)) return { value };
  const scaledExponent = BigInt(value.exponent) + exponent;
  if (scaledExponent > 20_000n) return { value: binary80Infinity(value.negative), error: 'range' };
  if (scaledExponent < -20_000n) return { value: binary80Zero(value.negative), error: 'range' };
  const result = binary80FromRational(value.significand, 1n, {
    binaryExponent: Number(scaledExponent),
    negative: value.negative,
  });
  if (scaledExponent < BigInt(BINARY80_PROFILE.minimumSubnormalExponent)) {
    const discardedBits = BigInt(BINARY80_PROFILE.minimumSubnormalExponent) - scaledExponent;
    const inexact = discardedBits >= BigInt(bitLength(value.significand)) ||
      value.significand % (1n << discardedBits) !== 0n;
    if (inexact) return { value: result, error: 'range' };
  }
  return { value: result };
}

function logbBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return binary80Infinity();
  if (isZero(value)) return binary80Infinity(true);
  const exponent = topExponent(value);
  return binary80FromRational(BigInt(Math.abs(exponent)), 1n, { negative: exponent < 0 });
}

function ilogbBinary80(value: Binary80Value): bigint {
  if (value.classification === 'nan' || isZero(value)) return -2_147_483_648n;
  if (value.classification === 'infinity') return 2_147_483_647n;
  return BigInt(topExponent(value));
}

function erfSeries(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return binary80FromRational(1n, 1n, { negative: value.negative });
  if (isZero(value)) return value;
  const magnitude = absolute(value);
  if (topExponent(magnitude) > 8) return binary80FromRational(1n, 1n, { negative: value.negative });
  const x = toFixed(magnitude);
  const square = fixedMultiply(x, x);
  let power = x;
  let sum = x;
  for (let index = 1n; power !== 0n; index++) {
    power = -fixedMultiply(power, square) / index;
    if (power === 0n) break;
    const term = power / (2n * index + 1n);
    if (term === 0n) break;
    sum += term;
  }
  const factor = fixedDivide(2n * SCALE, fixedSquareRoot(piFixed()));
  const result = fixedMultiply(factor, sum);
  return fromFixed(value.negative ? -result : result);
}

function erfcTail(value: Binary80Value): Binary80Value {
  const x = toFixed(value);
  const square = fixedMultiply(x, x);
  let denominator = square;
  for (let index = 127n; index >= 0n; index--) {
    const inner = SCALE + fixedDivide((index + 1n) * SCALE, denominator);
    const numerator = ((2n * index + 1n) * SCALE) / 2n;
    denominator = square + fixedDivide(numerator, inner);
  }
  const exponential = expParts(-square);
  if (!exponential || denominator <= 0n) return binary80Zero();
  const scaledComplement = fixedDivide(fixedDivide(x, denominator), fixedSquareRoot(piFixed()));
  return binary80FromRational(exponential.significand * scaledComplement, 1n, {
    binaryExponent: exponential.exponent - FRACTION_BITS,
  });
}

function erfcBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80FromRational(2n) : binary80Zero();
  if (isZero(value)) return binary80FromRational(1n);
  const magnitude = absolute(value);
  let result: Binary80Value;
  if (topExponent(magnitude) < 0) {
    result = binary80Subtract(binary80FromRational(1n), absolute(erfSeries(magnitude)));
  } else if (topExponent(magnitude) < 7) {
    result = erfcTail(magnitude);
  } else result = binary80Zero();
  return value.negative ? binary80Subtract(binary80FromRational(2n), result) : result;
}

const SPOUGE_A = 40n;
let spougeCoefficients: readonly bigint[] | undefined;

function exponentialFixed(value: bigint): bigint {
  const parts = expParts(value);
  if (!parts) throw new RangeError('The Spouge coefficient is outside the exponential range.');
  const shift = parts.exponent + FRACTION_BITS;
  return shift >= 0 ? parts.significand << BigInt(shift) : parts.significand >> BigInt(-shift);
}

function spougeFixedCoefficients(): readonly bigint[] {
  if (spougeCoefficients) return spougeCoefficients;
  const coefficients: bigint[] = [fixedSquareRoot(2n * piFixed())];
  let factorial = 1n;
  for (let index = 1n; index < SPOUGE_A; index++) {
    const aMinusK = SPOUGE_A - index;
    if (index > 1n) factorial *= index - 1n;
    let power = SCALE;
    for (let exponent = 1n; exponent < index; exponent++) power = fixedMultiply(power, aMinusK * SCALE);
    const squareRoot = fixedSquareRoot(aMinusK * SCALE);
    const exponential = exponentialFixed(aMinusK * SCALE);
    let coefficient = fixedMultiply(fixedMultiply(power, squareRoot), exponential) / factorial;
    if ((index & 1n) === 0n) coefficient = -coefficient;
    coefficients.push(coefficient);
  }
  spougeCoefficients = Object.freeze(coefficients);
  return spougeCoefficients;
}

function logGammaPositive(value: Binary80Value): bigint {
  const integer = exactInteger(value);
  if (integer && integer.integer >= 1n && integer.integer <= 1757n) {
    let factorial = 1n;
    for (let factor = 2n; factor < integer.integer; factor++) factorial *= factor;
    return logFixed(factorial << BigInt(FRACTION_BITS));
  }
  const z = toFixed(value) - SCALE;
  const t = z + SPOUGE_A * SCALE;
  const coefficients = spougeFixedCoefficients();
  let sum = coefficients[0] ?? 0n;
  for (let index = 1; index < coefficients.length; index++) {
    sum += fixedDivide(coefficients[index] ?? 0n, z + BigInt(index) * SCALE);
  }
  return fixedMultiply(z + SCALE / 2n, logFixed(t)) - t + logFixed(sum);
}

function sinePiFixed(value: Binary80Value): bigint {
  if (value.exponent >= 0) return 0n;
  const shift = -value.exponent;
  const denominator = 1n << BigInt(shift);
  const period = denominator << 1n;
  let remainder = value.significand % period;
  if (value.negative) remainder = -remainder;
  if (remainder > denominator) remainder -= period;
  else if (remainder < -denominator) remainder += period;
  const angleMagnitude = piFixed() * (remainder < 0n ? -remainder : remainder) / denominator;
  return fixedSine(remainder < 0n ? -angleMagnitude : angleMagnitude);
}

function logGammaBinary80(value: Binary80Value): { value: Binary80Value; sign: boolean } {
  if (value.classification === 'nan') return { value, sign: false };
  if (value.classification === 'infinity') return { value: binary80Infinity(), sign: !value.negative };
  const integer = exactInteger(value);
  if (isZero(value) || value.negative && integer) return { value: binary80Infinity(), sign: false };
  if (!value.negative) return { value: fromFixed(logGammaPositive(value)), sign: false };

  if (topExponent(absolute(value)) < -32) {
    const nearZeroCorrection = logGammaPositive(binary80Subtract(binary80FromRational(1n), value));
    return { value: fromFixed(-logBinary80(absolute(value)) - nearZeroCorrection), sign: true };
  }
  const sine = sinePiFixed(value);
  if (sine === 0n) return { value: binary80Infinity(), sign: false };
  const reflectedInput = binary80Subtract(binary80FromRational(1n), value);
  const logPi = logFixed(piFixed());
  const logSine = logFixed(sine < 0n ? -sine : sine);
  const reflectedGamma = logGammaPositive(reflectedInput);
  return {
    value: fromFixed(logPi - logSine - reflectedGamma),
    sign: sine < 0n,
  };
}

function gammaBinary80(value: Binary80Value, logarithmic: boolean): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') {
    if (value.negative) return logarithmic ? binary80Infinity() : binary80NaN();
    return value;
  }
  if (!logarithmic) {
    const integer = exactInteger(value);
    if (integer && integer.integer >= 1n && integer.integer <= 1757n) {
      let factorial = 1n;
      for (let factor = 2n; factor < integer.integer; factor++) factorial *= factor;
      return binary80FromRational(factorial);
    }
  }
  const result = logGammaBinary80(value);
  if (logarithmic) return result.value;
  if (result.value.classification === 'infinity') return result.sign ? binary80Infinity(true) : result.value;
  if (result.value.classification === 'nan') return result.value;
  const fixed = toFixed(result.value);
  const parts = expParts(fixed);
  if (!parts) return fixed < 0n ? binary80Zero(result.sign) : binary80Infinity(result.sign);
  return partsToBinary80(parts, result.sign);
}

function unaryMath(name: string, value: Binary80Value): Binary80Value | undefined {
  switch (name) {
    case 'sqrt': return sqrtBinary80(value);
    case 'fabs': return absolute(value);
    case 'sin': case 'cos': case 'tan': return trigBinary80(name, value);
    case 'asin': return asinBinary80(value);
    case 'acos': return acosBinary80(value);
    case 'atan': return atanBinary80(value);
    case 'sinh': case 'cosh': case 'tanh': return sinhCoshTanh(value, name);
    case 'asinh': return asinHyperbolic(value);
    case 'acosh': return acosHyperbolic(value);
    case 'atanh': return atanhHyperbolic(value);
    case 'exp': return expBinary80(value);
    case 'exp2': return exp2Binary80(value);
    case 'expm1': return expm1Binary80(value);
    case 'log': case 'log2': case 'log10': return logBinary80Result(value, name);
    case 'log1p': return log1pBinary80(value);
    case 'floor': case 'ceil': case 'trunc': case 'round': return roundedIntegral(value, name);
    case 'nearbyint': case 'rint': return roundedIntegral(value, 'nearestEven');
    case 'logb': return logbBinary80(value);
    case 'erf': return erfSeries(value);
    case 'erfc': return erfcBinary80(value);
    case 'lgamma': return gammaBinary80(value, true);
    case 'tgamma': return gammaBinary80(value, false);
    case 'cbrt': return cbrtBinary80(value);
    default: return undefined;
  }
}

function binaryMath(
  name: string,
  left: Binary80Value,
  right: Binary80Value,
  format: BinaryFloatFormat = 'binary80',
): Binary80Value | undefined {
  switch (name) {
    case 'fmod': return fmodBinary80(left, right);
    case 'remainder': return remainderBinary80(left, right).value;
    case 'nextafter': return binary80NextAfter(left, right, format);
    case 'pow': return powBinary80(left, right);
    case 'atan2': return atan2Binary80(left, right);
    case 'hypot': return hypotBinary80(left, right);
    case 'fmin': return minimumMaximum(left, right, false);
    case 'fmax': return minimumMaximum(left, right, true);
    case 'fdim': {
      if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN();
      return binary80Compare(left, right) === 1 ? binary80Subtract(left, right) : binary80Zero();
    }
    case 'copysign': return signed(absolute(left), right.negative);
    default: return undefined;
  }
}

export type MathError = 'domain' | 'range';
export interface MathKernelResult {
  readonly value?: Binary80Value;
  readonly integerValue?: bigint;
  readonly output?: { readonly argumentIndex: number; readonly value: Binary80Value | bigint };
  readonly error?: MathError;
}

export interface MathKernelOptions {
  readonly format: BinaryFloatFormat;
  readonly integerArgument?: bigint;
}

function variant(name: string, bases: readonly string[]): { base: string; format: BinaryFloatFormat } | undefined {
  for (const base of bases) {
    if (name === base) return { base, format: 'binary64' };
    if (name === `${base}f`) return { base, format: 'binary32' };
    if (name === `${base}l`) return { base, format: 'binary80' };
  }
  return undefined;
}

function mathError(
  base: string,
  args: readonly Binary80Value[],
  result: Binary80Value | undefined,
): MathError | undefined {
  const x = args[0];
  const y = args[1];
  const one = binary80FromRational(1n);
  const absX = x ? absolute(x) : undefined;
  const absCmp = absX ? binary80Compare(absX, one) : undefined;
  const negativeX = !!x && x.classification !== 'nan' && x.negative && !isZero(x);
  const xIsInteger = x ? exactInteger(x) !== undefined : false;

  if (base === 'sqrt' && negativeX ||
      (base === 'asin' || base === 'acos') && absCmp === 1 ||
      base === 'acosh' && x && x.classification !== 'nan' && binary80Compare(x, one) === -1 ||
      base === 'atanh' && absCmp === 1 ||
      (base === 'log' || base === 'log2' || base === 'log10') && negativeX ||
      base === 'log1p' && x && x.classification !== 'nan' && binary80Compare(x, binary80FromRational(1n, 1n, { negative: true })) === -1 ||
      (base === 'fmod' || base === 'remainder') && y && isZero(y) ||
      base === 'pow' && x && y && x.classification === 'finite' && y.classification === 'finite' && x.negative && !xIsInteger) {
    return 'domain';
  }
  if ((base === 'log' || base === 'log2' || base === 'log10') && x && isZero(x) ||
      base === 'log1p' && x && binary80Compare(x, binary80FromRational(1n, 1n, { negative: true })) === 0 ||
      base === 'atanh' && absCmp === 0 ||
      base === 'pow' && x && y && isZero(x) && y.negative && !isZero(y) ||
      (base === 'lgamma' || base === 'tgamma') && x && (isZero(x) || x.negative && xIsInteger)) {
    return 'range';
  }
  if (base === 'ilogb' && x && (isZero(x) || x.classification === 'nan')) return 'domain';

  const rangeSensitive = new Set([
    'exp', 'exp2', 'expm1', 'sinh', 'cosh', 'pow', 'hypot', 'ldexp', 'scalbn', 'scalbln',
    'nextafter', 'nexttoward', 'erfc', 'tgamma',
  ]);
  if (rangeSensitive.has(base) && result && args.every((argument) => argument.classification === 'finite')) {
    if (result.classification === 'infinity') return 'range';
    if (base !== 'nextafter' && base !== 'nexttoward' && isZero(result) && args.some((argument) => !isZero(argument)) &&
        (base !== 'pow' || !x || !isZero(x))) return 'range';
  }
  return undefined;
}

function floatingError(base: string, args: readonly Binary80Value[], result: Binary80Value): MathError | undefined {
  return mathError(base, args, result);
}

export function callMathKernel(
  name: string,
  args: readonly Binary80Value[],
  options: MathKernelOptions,
): MathKernelResult | undefined {
  const unary = variant(name, MATH_UNARY_FUNCTIONS);
  if (unary) {
    const value = unaryMath(unary.base, args[0]);
    return value ? { value, error: floatingError(unary.base, args, value) } : undefined;
  }
  const binary = variant(name, MATH_BINARY_FUNCTIONS);
  if (binary) {
    const value = binaryMath(binary.base, args[0], args[1], options.format);
    return value ? { value, error: floatingError(binary.base, args, value) } : undefined;
  }
  const scaling = variant(name, MATH_SCALING_FUNCTIONS);
  if (scaling) {
    const exponent = options.integerArgument ?? 0n;
    const result = scalePowerOfTwo(args[0], exponent);
    return { value: result.value, error: result.error ?? floatingError(scaling.base, [args[0]], result.value) };
  }
  const outputUnary = variant(name, MATH_OUT_UNARY_FUNCTIONS);
  if (outputUnary) {
    if (outputUnary.base === 'frexp') {
      const result = frexpBinary80(args[0]);
      return { value: result.value, output: { argumentIndex: 1, value: result.exponent } };
    }
    const result = modfBinary80(args[0]);
    return { value: result.value, output: { argumentIndex: 1, value: result.integral } };
  }
  const remquo = variant(name, ['remquo']);
  if (remquo) {
    const result = remainderBinary80(args[0], args[1]);
    const quotient = result.quotient < 0n ? -( (-result.quotient) % 8n ) : result.quotient % 8n;
    return {
      value: result.value,
      output: { argumentIndex: 2, value: quotient },
      error: floatingError('remainder', args.slice(0, 2), result.value),
    };
  }
  const nexttoward = variant(name, ['nexttoward']);
  if (nexttoward) {
    const value = binary80NextAfter(args[0], args[1], options.format);
    return { value, error: floatingError('nexttoward', args, value) };
  }
  const integerReturn = variant(name, MATH_INTEGER_RETURN_FUNCTIONS);
  if (integerReturn) {
    if (integerReturn.base === 'ilogb') return { integerValue: ilogbBinary80(args[0]), error: mathError('ilogb', args, undefined) };
    const ties = integerReturn.base === 'lround' || integerReturn.base === 'llround' ? 'away' : 'even';
    if (args[0].classification !== 'finite') {
      const minimum = integerReturn.base.startsWith('ll') ? -(1n << 63n) : -(1n << 63n);
      return { integerValue: minimum, error: 'range' };
    }
    return { integerValue: roundedInteger(args[0], ties) };
  }
  return undefined;
}

export function callLongDoubleMath(name: string, args: readonly Binary80Value[]): Binary80Value | undefined {
  if (!name.endsWith('l')) return undefined;
  const result = callMathKernel(name, args, { format: 'binary80' });
  return result?.value;
}

function sinhCoshTanh(value: Binary80Value, name: 'sinh' | 'cosh' | 'tanh'): Binary80Value {
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
