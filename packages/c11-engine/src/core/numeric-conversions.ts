import { failure } from './internal.ts';
import type { CType, CValue, Location } from './internal.ts';
import {
  binary80FromNumber, binary80FromRational, binary80ToBigIntTrunc, binary80ToNumber, binary80Truthy,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import { arithmetic, bounds, floating, isInteger, normalize } from './numeric-integers.ts';
import {
  aggregateType, canConvertPointerType, compatibleType, functionType, isArithmetic, pointedToType, pointerType,
  unqualifiedType,
} from './type-system.ts';
import type { AggregateContext } from './type-system.ts';

export function isBinary80(value: unknown): value is Binary80Value {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'binary80';
}

export function numericData(value: CValue, location: Location): bigint | number | Binary80Value {
  if (typeof value.value === 'bigint' || typeof value.value === 'number' || isBinary80(value.value)) return value.value;
  failure('INVALID_OPERAND_TYPE', 'The value is not arithmetic.', location);
}

// Round a positive rational directly to the requested binary format. This avoids
// decimal -> binary64 -> binary32 and bigint -> binary64 -> binary32 double rounding.
// sticky denotes a discarded, strictly positive tail smaller than the last digit.
export function roundedRational(numerator: bigint, denominator: bigint, type: 'float' | 'double', sticky = false): number {
  if (numerator === 0n) return 0;
  const precision = type === 'float' ? 24 : 53;
  const minExponent = type === 'float' ? -126 : -1022;
  const maxExponent = type === 'float' ? 127 : 1023;
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (exponent >= 0 ? numerator < (denominator << BigInt(exponent)) : (numerator << BigInt(-exponent)) < denominator) exponent--;
  if (exponent > maxExponent) return Infinity;
  if (exponent < minExponent - precision) return 0;
  const unitExponent = Math.max(exponent, minExponent) - precision + 1;
  const n = unitExponent < 0 ? numerator << BigInt(-unitExponent) : numerator;
  const d = unitExponent > 0 ? denominator << BigInt(unitExponent) : denominator;
  let significand = n / d;
  const twiceRemainder = (n % d) * 2n;
  if (twiceRemainder > d || (twiceRemainder === d && (sticky || (significand & 1n) !== 0n))) significand++;
  if (exponent === maxExponent && significand === (1n << BigInt(precision))) return Infinity;
  return Number(significand) * 2 ** unitExponent;
}

const defaultLocation: Location = { file: 'main.c', line: 1, column: 1 };
export function truth(value: CValue, location: Location = defaultLocation): boolean {
  if (typeof value.value === 'bigint') return value.value !== 0n;
  if (typeof value.value === 'number') return value.value !== 0;
  if (isBinary80(value.value)) return binary80Truthy(value.value);
  if (value.value === null) return false;
  if (typeof value.value === 'object') {
    if (value.value.kind === 'object-pointer') return true;
    if (value.value.kind === 'function-pointer') return value.value.functionIndex !== null;
  }
  failure('INVALID_OPERAND_TYPE', 'A condition requires a scalar.', location);
}
export function convert(value: CValue, type: CType, location: Location, aggregates: AggregateContext = []): CValue {
  void aggregates;
  type = unqualifiedType(type);
  if (type === 'void') return { type, value: 0n };
  if (type === '_Bool') return { type, value: truth(value, location) ? 1n : 0n };
  if (pointerType(type)) {
    if (pointerType(value.type)) {
      if (!canConvertPointerType(value.type, type)) failure('INVALID_CONVERSION', 'The pointer types are incompatible for this conversion.', location);
      const pointerValue = value.value;
      if (pointerValue !== null && (typeof pointerValue !== 'object' || !['object-pointer', 'function-pointer'].includes(pointerValue.kind))) {
        failure('INVALID_CONVERSION', 'The value does not represent a pointer.', location);
      }
      if (!!functionType(pointedToType(type) ?? 'void') !== (pointerValue !== null && typeof pointerValue === 'object' && pointerValue.kind === 'function-pointer')) {
        failure('INVALID_CONVERSION', 'A function pointer cannot be converted to an object pointer or void*.', location);
      }
      return { type, value: pointerValue as CValue['value'] };
    }
    if (isInteger(value.type) && typeof value.value === 'bigint' && value.value === 0n) return { type, value: null };
    failure('INVALID_CONVERSION', 'A pointer only accepts another compatible pointer or a null pointer constant.', location);
  }
  if (!isArithmetic(type)) {
    if (aggregateType(type) && compatibleType(value.type, type) && typeof value.value === 'object' && value.value !== null && value.value.kind === 'aggregate-value') {
      return { type, value: value.value };
    }
    failure('INVALID_CONVERSION', `Conversion to ${typeof type === 'string' ? type : 'an aggregate type'} is outside the P3 scalar conversions.`, location);
  }
  arithmetic(value, location);
  if (isInteger(type)) {
    const numeric = numericData(value, location);
    if (typeof numeric === 'bigint') return { type, value: normalize(numeric, type) };
    if (isBinary80(numeric)) {
      if (numeric.classification !== 'finite') failure('FLOAT_TO_INTEGER_RANGE', 'NaN or infinity cannot be converted to an integer in C11.', location);
      const truncated = binary80ToBigIntTrunc(numeric);
      const range = bounds(type);
      if (truncated < range.min || truncated > range.max) failure('FLOAT_TO_INTEGER_RANGE', `Truncated floating-point value is not representable as ${type}: undefined behavior in C11.`, location);
      return { type, value: truncated };
    }
    if (!Number.isFinite(numeric)) failure('FLOAT_TO_INTEGER_RANGE', 'NaN or infinity cannot be converted to an integer in C11.', location);
    const truncated = BigInt(Math.trunc(numeric));
    const range = bounds(type);
    if (truncated < range.min || truncated > range.max) failure('FLOAT_TO_INTEGER_RANGE', `Truncated floating-point value is not representable as ${type}: undefined behavior in C11.`, location);
    return { type, value: truncated };
  }
  const numeric = numericData(value, location);
  if (type === 'long double') {
    if (isBinary80(numeric)) return { type, value: numeric };
    if (typeof numeric === 'number') return { type, value: binary80FromNumber(numeric) };
    return { type, value: binary80FromRational(numeric < 0n ? -numeric : numeric, 1n, { negative: numeric < 0n }) };
  }
  if (type !== 'float' && type !== 'double') failure('INVALID_CONVERSION', `Cannot convert to ${String(type)} as a floating-point type.`, location);
  if (typeof numeric === 'number') return floating(numeric, type);
  if (isBinary80(numeric)) return { type, value: binary80ToNumber(numeric, type === 'float' ? 'binary32' : 'binary64') };
  const negative = numeric < 0n;
  const result = roundedRational(negative ? -numeric : numeric, 1n, type);
  return { type, value: negative ? -result : result };
}
