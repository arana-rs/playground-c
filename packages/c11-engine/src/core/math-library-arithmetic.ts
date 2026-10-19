import {
  BINARY80_PROFILE, binary80Compare, binary80FromRational, binary80Infinity,
  binary80NaN, binary80Zero,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import {
  MAX_EXP_ARGUMENT, SCALE, absolute, bitLength, cbrtRational, exactInteger,
  fixedMultiply, isZero, sqrtRational, toFixed, topExponent,
} from './math-library-primitives.ts';
import { expParts, logBinary80, partsToBinary80 } from './math-library-exponential.ts';
import type { MathError } from './math-library-types.ts';

export function sqrtBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return value.negative ? binary80NaN() : value;
  if (value.significand === 0n) return value;
  if (value.negative) return binary80NaN();
  return sqrtRational(value.significand, value.exponent);
}

export function cbrtBinary80(value: Binary80Value): Binary80Value {
  if (value.classification !== 'finite') return value;
  return cbrtRational(value.significand, value.exponent, value.negative);
}

export function fmodBinary80(left: Binary80Value, right: Binary80Value): Binary80Value {
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

export function hypotBinary80(left: Binary80Value, right: Binary80Value): Binary80Value {
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

export function powBinary80(baseInput: Binary80Value, power: Binary80Value): Binary80Value {
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

export function minimumMaximum(left: Binary80Value, right: Binary80Value, maximum: boolean): Binary80Value {
  if (left.classification === 'nan') return right.classification === 'nan' ? binary80NaN() : right;
  if (right.classification === 'nan') return left;
  const comparison = binary80Compare(left, right);
  if (comparison === 0) {
    if (isZero(left) && isZero(right)) return binary80Zero(maximum ? left.negative && right.negative : left.negative || right.negative);
    return left;
  }
  return (comparison ?? 0) > 0 === maximum ? left : right;
}

export function remainderBinary80(left: Binary80Value, right: Binary80Value): { value: Binary80Value; quotient: bigint } {
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

export function frexpBinary80(value: Binary80Value): { value: Binary80Value; exponent: bigint } {
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

export function modfBinary80(value: Binary80Value): { value: Binary80Value; integral: Binary80Value } {
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

export function scalePowerOfTwo(value: Binary80Value, exponent: bigint): { value: Binary80Value; error?: MathError } {
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

export function logbBinary80(value: Binary80Value): Binary80Value {
  if (value.classification === 'nan') return value;
  if (value.classification === 'infinity') return binary80Infinity();
  if (isZero(value)) return binary80Infinity(true);
  const exponent = topExponent(value);
  return binary80FromRational(BigInt(Math.abs(exponent)), 1n, { negative: exponent < 0 });
}

export function ilogbBinary80(value: Binary80Value): bigint {
  if (value.classification === 'nan' || isZero(value)) return -2_147_483_648n;
  if (value.classification === 'infinity') return 2_147_483_647n;
  return BigInt(topExponent(value));
}
