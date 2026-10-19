import {
  binary80FromRational, binary80Infinity, binary80NaN, binary80Subtract, binary80Zero,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import {
  FRACTION_BITS, SCALE, absolute, exactInteger, fixedDivide, fixedMultiply,
  fixedSquareRoot, fromFixed, isZero, toFixed, topExponent,
} from './math-library-primitives.ts';
import { expParts, logBinary80, logFixed, partsToBinary80 } from './math-library-exponential.ts';
import { piFixed, sinePiFixed } from './math-library-trigonometric.ts';

export function erfSeries(value: Binary80Value): Binary80Value {
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

export function erfcBinary80(value: Binary80Value): Binary80Value {
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

export function gammaBinary80(value: Binary80Value, logarithmic: boolean): Binary80Value {
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
