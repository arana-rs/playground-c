import {
  binary80Compare, binary80FromRational, binary80Infinity, binary80NaN, binary80Zero,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import {
  FRACTION_BITS, PI_BITS, PI_LOW_SHIFT, SCALE, absolute, fixedDivide, fixedMultiply,
  fixedSquareRoot, fromFixed, integerSqrt, isZero, roundRatio, scaledRational, toFixed,
  topExponent,
} from './math-library-primitives.ts';

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

export function piFixed(): bigint {
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

export function trigBinary80(name: 'sin' | 'cos' | 'tan', value: Binary80Value): Binary80Value {
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

export function asinBinary80(value: Binary80Value): Binary80Value {
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

export function acosBinary80(value: Binary80Value): Binary80Value {
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

export function atanBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  const halfPi = piFixed() / 2n;
  if (value.classification === 'infinity') return scaledRational(halfPi, -FRACTION_BITS, value.negative);
  if (isZero(value) || topExponent(value) < -64) return value;
  return fromFixed(atanFixed(toFixed(value)));
}

export function atan2Binary80(y: Binary80Value, x: Binary80Value): Binary80Value {
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

export function sinePiFixed(value: Binary80Value): bigint {
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
