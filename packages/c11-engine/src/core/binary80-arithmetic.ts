import {
  assertBinary80, binary80Infinity, binary80NaN, binary80Zero, value,
} from './binary80-value.ts';
import type { Binary80Value } from './binary80-value.ts';
import { binary80FromRational } from './binary80-rounding.ts';

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

/** Multiply and add exact binary80 operands, rounding only the final result. */
export function binary80FusedMultiplyAdd(
  leftInput: Binary80Value,
  rightInput: Binary80Value,
  addendInput: Binary80Value,
): Binary80Value {
  const left = assertBinary80(leftInput), right = assertBinary80(rightInput), addend = assertBinary80(addendInput);
  if (left.classification === 'nan' || right.classification === 'nan' || addend.classification === 'nan') return binary80NaN();

  const productNegative = left.negative !== right.negative;
  const leftZero = left.classification === 'finite' && left.significand === 0n;
  const rightZero = right.classification === 'finite' && right.significand === 0n;
  if ((left.classification === 'infinity' && rightZero) || (right.classification === 'infinity' && leftZero)) return binary80NaN();

  if (left.classification === 'infinity' || right.classification === 'infinity') {
    if (addend.classification === 'infinity' && addend.negative !== productNegative) return binary80NaN();
    return binary80Infinity(productNegative);
  }
  if (addend.classification === 'infinity') return addend;

  const product = left.significand * right.significand;
  if (product === 0n && addend.significand === 0n) {
    return binary80Zero(productNegative === addend.negative ? productNegative : false);
  }

  const productExponent = left.exponent + right.exponent;
  const commonExponent = Math.min(productExponent, addend.exponent);
  const productInteger = product << BigInt(productExponent - commonExponent);
  const addendInteger = addend.significand << BigInt(addend.exponent - commonExponent);
  const sum = (productNegative ? -productInteger : productInteger) + (addend.negative ? -addendInteger : addendInteger);
  if (sum === 0n) return binary80Zero();
  return binary80FromRational(sum < 0n ? -sum : sum, 1n, {
    binaryExponent: commonExponent,
    negative: sum < 0n,
  });
}

export function binary80Truthy(input: Binary80Value): boolean {
  const checked = assertBinary80(input);
  return checked.classification !== 'finite' || checked.significand !== 0n;
}
