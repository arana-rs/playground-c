import { failure } from './internal.ts';
import type { CType, CValue, Location } from './internal.ts';
import {
  binary80Add, binary80Compare, binary80Divide, binary80FromNumber, binary80FromRational,
  binary80Multiply, binary80Negate, binary80Subtract, binary80ToBigIntTrunc, binary80ToNumber,
  binary80Truthy, parseBinary80,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import { HEAP_ALLOCATOR_BUILTINS, HEAP_ALLOCATOR_SIGNATURES } from './allocator-builtins.ts';
import {
  aggregateType, canConvertPointerType, compatibleType, enumType, functionType, isArithmetic, isInteger, isPointer,
  pointedToType, pointerTo, pointerType, scalarSize, unqualifiedType,
} from './type-system.ts';
import type { AggregateContext } from './type-system.ts';

// Fixed P2 target: x86-64 LP64, signed plain char, two's-complement integers.
// Conversion to a signed integer outside its range preserves the low bits;
// right shift of a negative signed integer is arithmetic (C11 implementation choices).
interface IntegerInfo { bits: number; rank: number; unsigned: boolean }
const integers: Record<string, IntegerInfo | undefined> = {
  _Bool: { bits: 8, rank: 0, unsigned: true },
  char: { bits: 8, rank: 1, unsigned: false },
  'signed char': { bits: 8, rank: 1, unsigned: false },
  'unsigned char': { bits: 8, rank: 1, unsigned: true },
  short: { bits: 16, rank: 2, unsigned: false },
  'unsigned short': { bits: 16, rank: 2, unsigned: true },
  int: { bits: 32, rank: 3, unsigned: false },
  'unsigned int': { bits: 32, rank: 3, unsigned: true },
  long: { bits: 64, rank: 4, unsigned: false },
  'unsigned long': { bits: 64, rank: 4, unsigned: true },
  'long long': { bits: 64, rank: 5, unsigned: false },
  'unsigned long long': { bits: 64, rank: 5, unsigned: true },
};

export { isInteger };
function integerRepresentationType(type: CType): string | undefined {
  const enumeration = enumType(type);
  if (enumeration) return enumeration.integerType;
  const unqualified = unqualifiedType(type);
  return typeof unqualified === 'string' ? unqualified : undefined;
}
export function sizeOf(type: CType): number {
  const unqualified = unqualifiedType(type);
  return pointerType(unqualified) ? 8 : scalarSize(unqualified);
}
export function promote(type: CType): CType {
  const unqualified = unqualifiedType(type);
  const enumeration = enumType(unqualified);
  if (enumeration) return enumeration.integerType;
  return integers[String(unqualified)] && integers[String(unqualified)]!.rank < 3 ? 'int' : unqualified;
}
export function commonType(left: CType, right: CType): CType {
  left = unqualifiedType(left);
  right = unqualifiedType(right);
  if (!isArithmetic(left) || !isArithmetic(right)) return 'void';
  if (left === 'long double' || right === 'long double') return 'long double';
  if (left === 'double' || right === 'double') return 'double';
  if (left === 'float' || right === 'float') return 'float';
  const a = promote(left), b = promote(right);
  if (a === b) return a;
  const ai = integers[String(a)], bi = integers[String(b)];
  if (!ai || !bi) return 'void';
  if (ai.unsigned === bi.unsigned) return ai.rank > bi.rank ? a : b;
  const signed = ai.unsigned ? b : a, unsigned = ai.unsigned ? a : b;
  const si = integers[String(signed)]!, ui = integers[String(unsigned)]!;
  if (ui.rank >= si.rank) return unsigned;
  if (si.bits > ui.bits) return signed;
  return `unsigned ${signed}` as CType;
}
function bounds(type: CType): { min: bigint; max: bigint } {
  const integerType = integerRepresentationType(type)!;
  const info = integers[integerType]!;
  if (type === '_Bool') return { min: 0n, max: 1n };
  return info.unsigned
    ? { min: 0n, max: (1n << BigInt(info.bits)) - 1n }
    : { min: -(1n << BigInt(info.bits - 1)), max: (1n << BigInt(info.bits - 1)) - 1n };
}
function normalize(value: bigint, type: CType): bigint {
  const integerType = integerRepresentationType(type)!;
  const info = integers[integerType]!;
  return info.unsigned ? BigInt.asUintN(info.bits, value) : BigInt.asIntN(info.bits, value);
}
function checked(value: bigint, type: CType, location: Location): CValue {
  type = unqualifiedType(type);
  const integerType = integerRepresentationType(type)!;
  const info = integers[integerType]!;
  if (info.unsigned) return { type, value: normalize(value, type) };
  const range = bounds(type);
  if (value < range.min || value > range.max) failure('SIGNED_OVERFLOW', `Signed ${integerType} overflow for a ${info.bits}-bit integer: undefined behavior in C11.`, location);
  return { type, value };
}
function int(value: boolean | number): CValue { return { type: 'int', value: BigInt(value ? (typeof value === 'number' ? value : 1) : 0) }; }
function floating(value: number, type: 'float' | 'double'): CValue { return { type, value: type === 'float' ? Math.fround(value) : value }; }
function arithmetic(value: CValue, location: Location): void {
  if (!isArithmetic(value.type)) failure('INVALID_OPERAND_TYPE', 'An arithmetic operand is required.', location);
}

function isBinary80(value: unknown): value is Binary80Value {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'binary80';
}

function numericData(value: CValue, location: Location): bigint | number | Binary80Value {
  if (typeof value.value === 'bigint' || typeof value.value === 'number' || isBinary80(value.value)) return value.value;
  failure('INVALID_OPERAND_TYPE', 'The value is not arithmetic.', location);
}

// Round a positive rational directly to the requested binary format. This avoids
// decimal -> binary64 -> binary32 and bigint -> binary64 -> binary32 double rounding.
// sticky denotes a discarded, strictly positive tail smaller than the last digit.
function roundedRational(numerator: bigint, denominator: bigint, type: 'float' | 'double', sticky = false): number {
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

function character(text: string, location: Location): CValue {
  if (!text.startsWith("'") || !text.endsWith("'")) failure('UNSUPPORTED_FEATURE', 'P2 does not implement wide-character or Unicode character constants.', location);
  const content = text.slice(1, -1);
  let code: number;
  if (content.startsWith('\\')) {
    const escape = content.slice(1);
    const simple: Record<string, number> = { "'": 39, '"': 34, '?': 63, '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
    if (Object.hasOwn(simple, escape)) code = simple[escape];
    else if (/^[0-7]{1,3}$/.test(escape)) code = Number.parseInt(escape, 8);
    else if (/^x[0-9a-fA-F]+$/.test(escape)) code = Number.parseInt(escape.slice(1), 16);
    else failure('UNSUPPORTED_FEATURE', 'P2 supports single-byte characters and standard, octal, or hexadecimal escapes.', location);
    if (code > 255) failure('SYNTAX_ERROR', 'The character escape exceeds the target byte range.', location);
  } else {
    if (content.length !== 1 || content.charCodeAt(0) > 127) failure('UNSUPPORTED_FEATURE', 'P2 supports one ASCII character per character constant.', location);
    code = content.charCodeAt(0);
  }
  return { type: 'int', value: BigInt.asIntN(8, BigInt(code)) };
}
function parseFloating(text: string, location: Location): CValue {
  const hex = /^0[xX]/.test(text);
  const pattern = hex
    ? /^0[xX]((?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP]([+-]?[0-9]+)([fFlL]?)$/
    : /^((?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)([fFlL]?)$/;
  const match = pattern.exec(text);
  if (!match) failure('SYNTAX_ERROR', `Invalid C11 floating-point constant: «${text}».`, location);
  const suffix = match[hex ? 3 : 2];
  if (/^[lL]$/.test(suffix)) {
    const value = parseBinary80(text);
    if (value.classification === 'infinity') failure('FLOAT_LITERAL_RANGE', 'Literal exceeds the long double binary80 range.', location);
    return { type: 'long double', value };
  }
  const type = /^[fF]$/.test(suffix) ? 'float' : 'double';
  let significand: string, exponent: number;
  if (hex) { significand = match[1]; exponent = Number(match[2]); }
  else {
    const parts = match[1].split(/[eE]/);
    significand = parts[0]; exponent = parts.length === 2 ? Number(parts[1]) : 0;
  }
  const point = significand.indexOf('.');
  const fractionalDigits = point < 0 ? 0 : significand.length - point - 1;
  let digits = significand.replace('.', '').replace(/^0+/, '');
  if (!digits) return { type, value: 0 };
  exponent -= fractionalDigits * (hex ? 4 : 1);
  const order = exponent + digits.length * (hex ? 4 : 1);
  if (order > (hex ? 1100 : 310)) failure('FLOAT_LITERAL_RANGE', `Literal exceeds the ${type} range.`, location);
  if (order < (hex ? -1100 : -330)) return { type, value: 0 };
  // Every binary32/64 halfway point has a terminating decimal representation
  // shorter than 1200 significant digits (or 300 hex digits). Additional digits
  // can therefore affect a tie only, and a sticky bit suffices without huge BigInts.
  const retainedDigits = hex ? 300 : 1200;
  const tail = digits.slice(retainedDigits);
  const sticky = /[1-9a-fA-F]/.test(tail);
  if (tail) { digits = digits.slice(0, retainedDigits); exponent += tail.length * (hex ? 4 : 1); }
  let numerator = BigInt(hex ? `0x${digits}` : digits), denominator = 1n;
  if (exponent >= 0) numerator = hex ? numerator << BigInt(exponent) : numerator * 10n ** BigInt(exponent);
  else denominator = hex ? 1n << BigInt(-exponent) : 10n ** BigInt(-exponent);
  const result = roundedRational(numerator, denominator, type, sticky);
  if (!Number.isFinite(result)) failure('FLOAT_LITERAL_RANGE', `Literal exceeds the ${type} range.`, location);
  return { type, value: result };
}
export function parseLiteral(text: string, location: Location): CValue {
  if (text.includes("'")) return character(text, location);
  if (/^0[bB]/.test(text)) failure('UNSUPPORTED_FEATURE', 'Binary 0b literals are not part of C11; P2 supports decimal, octal, and hexadecimal bases.', location);
  const hex = /^0[xX]/.test(text);
  if (hex ? /[.pP]/.test(text) : /[.eE]/.test(text)) return parseFloating(text, location);
  const match = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uU](?:[lL]|ll|LL)?|(?:[lL]|ll|LL)[uU]?)?$/.exec(text);
  if (!match) failure('SYNTAX_ERROR', `Invalid C11 integer constant: «${text}».`, location);
  const decimal = /^[1-9]/.test(match[1]);
  const suffix = (match[2] ?? '').toLowerCase();
  const unsigned = suffix.includes('u'), longs = suffix.replace('u', '').length;
  let candidates: CType[];
  if (unsigned) candidates = longs === 2 ? ['unsigned long long'] : longs === 1 ? ['unsigned long', 'unsigned long long'] : ['unsigned int', 'unsigned long', 'unsigned long long'];
  else if (longs === 2) candidates = decimal ? ['long long'] : ['long long', 'unsigned long long'];
  else if (longs === 1) candidates = decimal ? ['long', 'long long'] : ['long', 'unsigned long', 'long long', 'unsigned long long'];
  else candidates = decimal ? ['int', 'long', 'long long'] : ['int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long'];
  const digits = match[1].replace(/^0[xX]/, '').replace(/^0+/, '') || '0';
  if (digits.length > (hex ? 16 : decimal ? 20 : 22)) failure('UNSUPPORTED_FEATURE', 'The literal requires an extended integer type, outside the P2 LP64 target.', location);
  const value = BigInt(hex ? `0x${digits}` : decimal ? digits : `0o${digits}`);
  for (const type of candidates) if (value <= bounds(type).max) return { type, value };
  failure('UNSUPPORTED_FEATURE', 'The literal is not representable by the candidate C11 integer types on the LP64 target.', location);
}

export function unary(operator: string, value: CValue, location: Location): CValue {
  if (operator === '!') return int(!truth(value, location));
  arithmetic(value, location);
  const type = promote(value.type);
  const promoted = convert(value, type, location);
  if (operator === '+') return promoted;
  if (operator === '-') {
    const numeric = numericData(promoted, location);
    if (typeof numeric === 'bigint') return checked(-numeric, type, location);
    if (isBinary80(numeric)) return { type: 'long double', value: binary80Negate(numeric) };
    if (type !== 'float' && type !== 'double') failure('ENGINE_INTERNAL_ERROR', 'The long double operand lost its binary80 representation.', location);
    return floating(-numeric, type);
  }
  if (operator === '~') {
    if (!isInteger(type)) failure('INVALID_OPERAND_TYPE', 'The ~ operator requires an integer type.', location);
    return { type, value: normalize(~(numericData(promoted, location) as bigint), type) };
  }
  failure('UNSUPPORTED_FEATURE', `Unimplemented unary operator: «${operator}».`, location);
}
export function binary(operator: string, left: CValue, right: CValue, location: Location): CValue {
  if (operator === ',') return right;
  if (operator === '&&') return int(truth(left, location) && truth(right, location));
  if (operator === '||') return int(truth(left, location) || truth(right, location));
  if (['==', '!=', '<', '>', '<=', '>='].includes(operator) && (isPointer(left.type) || isPointer(right.type))) {
    return comparePointers(operator, left, right, location);
  }
  arithmetic(left, location); arithmetic(right, location);
  if (operator === '<<' || operator === '>>') {
    if (!isInteger(left.type) || !isInteger(right.type)) failure('INVALID_OPERAND_TYPE', 'Shift operations require two integer operands.', location);
    const type = promote(left.type), countType = promote(right.type);
    const value = numericData(convert(left, type, location), location) as bigint;
    const count = numericData(convert(right, countType, location), location) as bigint;
    const info = integers[String(type)]!;
    if (count < 0n || count >= BigInt(info.bits)) failure('INVALID_SHIFT', 'The shift count is negative or reaches the width of the promoted operand, which is undefined behavior in C11.', location);
    if (operator === '>>') return { type, value: value >> count };
    if (!info.unsigned && value < 0n) failure('INVALID_SHIFT', 'Left-shifting a negative signed integer is undefined behavior in C11.', location);
    return checked(value << count, type, location);
  }
  const type = commonType(left.type, right.type);
  if (type === 'void') failure('INVALID_OPERAND_TYPE', `The operand types for «${operator}» are incompatible.`, location);
  const a = numericData(convert(left, type, location), location), b = numericData(convert(right, type, location), location);
  if (isBinary80(a) || isBinary80(b)) {
    if (!isBinary80(a) || !isBinary80(b) || type !== 'long double') {
      failure('ENGINE_INTERNAL_ERROR', 'The binary80 operands did not retain a common long double type.', location);
    }
    if (['==', '!=', '<', '>', '<=', '>='].includes(operator)) {
      const comparison = binary80Compare(a, b);
      if (comparison === undefined) return int(operator === '!=');
      switch (operator) {
        case '==': return int(comparison === 0);
        case '!=': return int(comparison !== 0);
        case '<': return int(comparison < 0);
        case '>': return int(comparison > 0);
        case '<=': return int(comparison <= 0);
        case '>=': return int(comparison >= 0);
      }
    }
    switch (operator) {
      case '+': return { type, value: binary80Add(a, b) };
      case '-': return { type, value: binary80Subtract(a, b) };
      case '*': return { type, value: binary80Multiply(a, b) };
      case '/': return { type, value: binary80Divide(a, b) };
      default: failure('INVALID_OPERAND_TYPE', `Operator «${operator}» requires integer operands.`, location);
    }
  }
  switch (operator) {
    case '==': return int(a === b);
    case '!=': return int(a !== b);
    case '<': return int(a < b);
    case '>': return int(a > b);
    case '<=': return int(a <= b);
    case '>=': return int(a >= b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (type !== 'float' && type !== 'double') failure('ENGINE_INTERNAL_ERROR', 'The long double value does not contain a binary80 representation.', location);
    switch (operator) {
      case '+': return floating(a + b, type);
      case '-': return floating(a - b, type);
      case '*': return floating(a * b, type);
      case '/': return floating(a / b, type);
      default: failure('INVALID_OPERAND_TYPE', `Operator «${operator}» requires integer operands.`, location);
    }
  }
  if (type === 'long double') failure('ENGINE_INTERNAL_ERROR', 'The long double value does not contain a binary80 representation.', location);
  const x = a as bigint, y = b as bigint;
  if ((operator === '/' || operator === '%') && y === 0n) failure('DIVISION_BY_ZERO', 'Integer division or remainder by zero: undefined behavior in C11.', location);
  if ((operator === '/' || operator === '%') && !integers[String(type)]!.unsigned && x === bounds(type).min && y === -1n) failure('SIGNED_OVERFLOW', `The minimum ${type} value divided by -1 is not representable.`, location);
  switch (operator) {
    case '+': return checked(x + y, type, location);
    case '-': return checked(x - y, type, location);
    case '*': return checked(x * y, type, location);
    case '/': return checked(x / y, type, location);
    case '%': return checked(x % y, type, location);
    case '&': return { type, value: normalize(x & y, type) };
    case '|': return { type, value: normalize(x | y, type) };
    case '^': return { type, value: normalize(x ^ y, type) };
    default: failure('UNSUPPORTED_FEATURE', `Unimplemented binary operator: «${operator}».`, location);
  }
}

function comparePointers(operator: string, left: CValue, right: CValue, location: Location): CValue {
  const leftPointer = isPointer(left.type), rightPointer = isPointer(right.type);
  if (operator === '==' || operator === '!=') {
    if (leftPointer && rightPointer && !compatibleType(left.type, right.type)) failure('INVALID_OPERAND_TYPE', 'The comparison requires compatible pointers.', location);
    const nullLeft = leftPointer && typeof right.value === 'bigint' && right.value === 0n;
    const nullRight = rightPointer && typeof left.value === 'bigint' && left.value === 0n;
    if (!(leftPointer && rightPointer) && !nullLeft && !nullRight) failure('INVALID_OPERAND_TYPE', 'Pointer comparison requires two compatible pointers or a null pointer constant.', location);
    const a = nullLeft ? null : left.value;
    const b = nullRight ? null : right.value;
    let equal = false;
    if (a === null || b === null) equal = a === null && b === null;
    else if (typeof a === 'object' && typeof b === 'object') {
      if (a.kind === 'object-pointer' && b.kind === 'object-pointer') equal = a.allocationId === b.allocationId && a.byteOffset === b.byteOffset;
      else if (a.kind === 'function-pointer' && b.kind === 'function-pointer') equal = a.functionIndex === b.functionIndex;
      else failure('INVALID_OPERAND_TYPE', 'Function pointers cannot be compared with object pointers.', location);
    }
    return int(operator === '==' ? equal : !equal);
  }
  if (!leftPointer || !rightPointer || !compatibleType(left.type, right.type) ||
      typeof left.value !== 'object' || left.value === null || left.value.kind !== 'object-pointer' ||
      typeof right.value !== 'object' || right.value === null || right.value.kind !== 'object-pointer') {
    failure('INVALID_OPERAND_TYPE', 'Relational comparison requires pointers to elements of the same array.', location);
  }
  if (left.value.allocationId !== right.value.allocationId || left.value.arrayId !== right.value.arrayId) {
    failure('INVALID_POINTER_COMPARISON', 'Relational comparison of pointers to distinct objects is undefined.', location);
  }
  const a = left.value.byteOffset, b = right.value.byteOffset;
  return int(operator === '<' ? a < b : operator === '>' ? a > b : operator === '<=' ? a <= b : a >= b);
}

export interface BuiltinSignature { returnType: CType; parameters: CType[] }
const unaryMath: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, fabs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  exp: Math.exp, exp2: x => 2 ** x, expm1: Math.expm1,
  log: Math.log, log2: Math.log2, log10: Math.log10, log1p: Math.log1p,
  floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
  round: x => {
    const whole = Math.trunc(x);
    return Math.abs(x - whole) >= 0.5 ? whole + (x < 0 ? -1 : 1) : whole;
  },
  cbrt: Math.cbrt,
};
const signView = new DataView(new ArrayBuffer(8));
const isNegative = (value: number) => { signView.setFloat64(0, value); return (signView.getUint8(0) & 0x80) !== 0; };
const binaryMath: Record<string, (x: number, y: number) => number> = {
  fmod: (x, y) => x % y,
  // Match the selected libm special cases that differ from JavaScript Math.pow.
  pow: (x, y) => x === 1 || (Math.abs(x) === 1 && !Number.isFinite(y) && !Number.isNaN(y)) ? 1 : Math.pow(x, y),
  atan2: Math.atan2, hypot: Math.hypot,
  fmin: (x, y) => Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.min(x, y),
  fmax: (x, y) => Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.max(x, y),
  fdim: (x, y) => Number.isNaN(x) || Number.isNaN(y) ? NaN : x > y ? x - y : 0,
  copysign: (x, y) => isNegative(y) ? -Math.abs(x) : Math.abs(x),
};
const classification = new Set(['isnan', 'isinf', 'isfinite', 'isnormal', 'signbit', 'fpclassify']);
export function isFloatingClassificationBuiltin(name: string): boolean { return classification.has(name); }
export const BUILTINS: Record<string, BuiltinSignature> = Object.create(null) as Record<string, BuiltinSignature>;
for (const [collection, count] of [[unaryMath, 1], [binaryMath, 2]] as const) {
  for (const name of Object.keys(collection)) {
    BUILTINS[name] = { returnType: 'double', parameters: Array<CType>(count).fill('double') };
    BUILTINS[`${name}f`] = { returnType: 'float', parameters: Array<CType>(count).fill('float') };
  }
}
// Classification macros retain their argument's original floating type. Their
// double signature validates scalar calls; callBuiltin handles them before casts.
for (const name of classification) BUILTINS[name] = { returnType: 'int', parameters: ['double'] };
BUILTINS.__c11_nan = { returnType: 'float', parameters: [] };
BUILTINS.__c11_inf = { returnType: 'float', parameters: [] };
for (const name of HEAP_ALLOCATOR_BUILTINS) {
  const signature = HEAP_ALLOCATOR_SIGNATURES[name];
  BUILTINS[name] = { returnType: signature.returnType, parameters: [...signature.parameters] };
}
BUILTINS.free = { returnType: 'void', parameters: [pointerTo('void')] };
export function callBuiltin(name: string, args: CValue[], location: Location): CValue {
  const signature = BUILTINS[name];
  if (!signature) failure('UNSUPPORTED_FEATURE', `Function «${name}» is not part of the P2 library.`, location);
  if ((HEAP_ALLOCATOR_BUILTINS as readonly string[]).includes(name) || name === 'free') failure('ENGINE_INTERNAL_ERROR', `Function «${name}» must run with the virtual store.`, location);
  if (args.length !== signature.parameters.length) failure('ARGUMENT_COUNT', `«${name}» requires ${signature.parameters.length} arguments.`, location);
  if (name === '__c11_nan') return { type: 'float', value: NaN };
  if (name === '__c11_inf') return { type: 'float', value: Infinity };
  if (classification.has(name)) {
    arithmetic(args[0], location);
    if (isBinary80(args[0].value)) {
      const value = args[0].value;
      const finite = value.classification === 'finite';
      const zero = finite && value.significand === 0n;
      const subnormal = finite && value.significand > 0n && value.significand < (1n << 63n);
      if (name === 'isnan') return int(value.classification === 'nan');
      if (name === 'isinf') return int(value.classification === 'infinity');
      if (name === 'isfinite') return int(finite);
      if (name === 'isnormal') return int(finite && !zero && !subnormal);
      if (name === 'signbit') return int(value.negative);
      return int(value.classification === 'nan' ? 0 : value.classification === 'infinity' ? 1 : zero ? 2 : subnormal ? 3 : 4);
    }
    const value = Number(args[0].value);
    const absolute = Math.abs(value);
    const subnormal = absolute > 0 && absolute < (args[0].type === 'float' ? 2 ** -126 : 2 ** -1022);
    if (name === 'isnan') return int(Number.isNaN(value));
    if (name === 'isinf') return int(!Number.isFinite(value) && !Number.isNaN(value));
    if (name === 'isfinite') return int(Number.isFinite(value));
    if (name === 'isnormal') return int(Number.isFinite(value) && value !== 0 && !subnormal);
    if (name === 'signbit') return int(isNegative(value));
    return int(Number.isNaN(value) ? 0 : !Number.isFinite(value) ? 1 : value === 0 ? 2 : subnormal ? 3 : 4);
  }
  const values = args.map((value, index) => convert(value, signature.parameters[index], location).value as number);
  const base = signature.returnType === 'float' ? name.slice(0, -1) : name;
  const result = unaryMath[base] ? unaryMath[base](values[0]) : binaryMath[base](values[0], values[1]);
  if (signature.returnType !== 'float' && signature.returnType !== 'double') {
    failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» has an unsupported return type.`, location);
  }
  return floating(result, signature.returnType);
}
