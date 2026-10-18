import { failure } from './internal.ts';
import type { CType, CValue, Location } from './internal.ts';
import {
  binary80Add, binary80Compare, binary80Divide, binary80FromNumber, binary80FromRational, binary80NaN,
  binary80FusedMultiplyAdd, binary80FusedMultiplyAddToNumber, binary80Multiply, binary80Negate, binary80Subtract,
  binary80RoundToFormat, binary80ToBigIntTrunc, binary80ToNumber,
  binary80Truthy, parseBinary80,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import { HEAP_ALLOCATOR_BUILTINS, HEAP_ALLOCATOR_SIGNATURES } from './allocator-builtins.ts';
import { callMathKernel } from './math-library.ts';
import { ERRNO_CODES } from './errno-metadata.ts';
import {
  MATH_BINARY_FUNCTIONS, MATH_CLASSIFICATION_BUILTINS, MATH_CLASSIFICATION_FUNCTIONS, MATH_COMPARISON_BUILTINS,
  MATH_FMA_FUNCTIONS, MATH_INTEGER_RETURN_TYPES, MATH_NAN_FUNCTIONS,
  MATH_OUT_UNARY_FUNCTIONS, MATH_REMQUO_FUNCTIONS, MATH_SCALING_FUNCTIONS,
  MATH_UNARY_FUNCTIONS,
} from './math-metadata.ts';
import {
  aggregateType, canConvertPointerType, compatibleType, enumType, functionType, isArithmetic, isInteger, isPointer,
  pointedToType, pointerTo, pointerType, qualifyType, scalarSize, unqualifiedType,
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

/** Encode one Unicode scalar value as UTF-8 bytes for C11 u8 literals and UCNs. */
export function encodeUtf8Bytes(codePoint: number): number[] {
  if (codePoint <= 0x7f) return [codePoint];
  if (codePoint <= 0x7ff) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  if (codePoint <= 0xffff) return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
  return [0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
}

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
  const bytes: number[] = [];
  const simple: Record<string, number> = { "'": 39, '"': 34, '?': 63, '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  for (let index = 0; index < content.length; index++) {
    let code = content.charCodeAt(index);
    if (content[index] === '\\') {
      const escape = content[++index];
      if (escape === undefined) failure('SYNTAX_ERROR', 'Incomplete escape in character constant.', location);
      if (Object.hasOwn(simple, escape)) code = simple[escape];
      else if (/[0-7]/.test(escape)) {
        let digits = escape;
        while (digits.length < 3 && /[0-7]/.test(content[index + 1] ?? '')) digits += content[++index];
        code = Number.parseInt(digits, 8);
      } else if (escape === 'x') {
        let digits = '';
        while (/[0-9a-fA-F]/.test(content[index + 1] ?? '')) digits += content[++index];
        if (!digits) failure('SYNTAX_ERROR', 'A hexadecimal character escape requires at least one digit.', location);
        code = Number.parseInt(digits, 16);
      } else failure('UNSUPPORTED_FEATURE', 'P2 supports single-byte characters and standard, octal, or hexadecimal escapes.', location);
      if (code > 255) failure('SYNTAX_ERROR', 'The character escape exceeds the target byte range.', location);
    } else if (code > 127) {
      failure('UNSUPPORTED_FEATURE', 'P2 supports ASCII characters in character constants.', location);
    }
    bytes.push(code);
  }
  if (bytes.length === 0) failure('SYNTAX_ERROR', 'An empty character constant is not valid C11.', location);
  if (bytes.length === 1) return { type: 'int', value: BigInt.asIntN(8, BigInt(bytes[0])) };

  // Multi-character constants are implementation-defined in C11. This LP64
  // profile packs bytes left-to-right into int, retaining its low 32 bits.
  let packed = 0n;
  for (const byte of bytes) packed = BigInt.asIntN(32, (packed << 8n) | BigInt(byte));
  return { type: 'int', value: packed };
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
const signView = new DataView(new ArrayBuffer(8));
const isNegative = (value: number) => { signView.setFloat64(0, value); return (signView.getUint8(0) & 0x80) !== 0; };
const classification = new Set<string>(MATH_CLASSIFICATION_FUNCTIONS);
const comparisonBuiltins = new Set<string>(MATH_COMPARISON_BUILTINS);
const nanFunctions = new Set<string>(MATH_NAN_FUNCTIONS);
const classificationBuiltins = new Set<string>(MATH_CLASSIFICATION_BUILTINS);
export function isFloatingClassificationBuiltin(name: string): boolean { return classification.has(name) || classificationBuiltins.has(name); }
export function isFloatingMathBuiltin(name: string): boolean {
  return classification.has(name) || classificationBuiltins.has(name) || comparisonBuiltins.has(name);
}
export const BUILTINS: Record<string, BuiltinSignature> = Object.create(null) as Record<string, BuiltinSignature>;
for (const [names, count] of [[MATH_UNARY_FUNCTIONS, 1], [MATH_BINARY_FUNCTIONS, 2]] as const) {
  for (const name of names) {
    BUILTINS[name] = { returnType: 'double', parameters: Array<CType>(count).fill('double') };
    BUILTINS[`${name}f`] = { returnType: 'float', parameters: Array<CType>(count).fill('float') };
    BUILTINS[`${name}l`] = { returnType: 'long double', parameters: Array<CType>(count).fill('long double') };
  }
}
for (const name of MATH_SCALING_FUNCTIONS) {
  BUILTINS[name] = { returnType: 'double', parameters: ['double', name === 'scalbln' ? 'long' : 'int'] };
  BUILTINS[`${name}f`] = { returnType: 'float', parameters: ['float', name === 'scalbln' ? 'long' : 'int'] };
  BUILTINS[`${name}l`] = { returnType: 'long double', parameters: ['long double', name === 'scalbln' ? 'long' : 'int'] };
}
for (const name of MATH_OUT_UNARY_FUNCTIONS) {
  BUILTINS[name] = { returnType: 'double', parameters: ['double', pointerTo(name === 'frexp' ? 'int' : 'double')] };
  BUILTINS[`${name}f`] = { returnType: 'float', parameters: ['float', pointerTo(name === 'frexp' ? 'int' : 'float')] };
  BUILTINS[`${name}l`] = { returnType: 'long double', parameters: ['long double', pointerTo(name === 'frexp' ? 'int' : 'long double')] };
}
for (const name of MATH_REMQUO_FUNCTIONS) {
  const suffix = name.endsWith('f') ? 'f' : name.endsWith('l') ? 'l' : '';
  const type: CType = suffix === 'f' ? 'float' : suffix === 'l' ? 'long double' : 'double';
  BUILTINS[name] = { returnType: type, parameters: [type, type, pointerTo('int')] };
}
for (const name of ['nexttoward', 'nexttowardf', 'nexttowardl']) {
  const type: CType = name.endsWith('f') ? 'float' : name.endsWith('l') ? 'long double' : 'double';
  BUILTINS[name] = { returnType: type, parameters: [type, 'long double'] };
}
for (const [base, returnType] of Object.entries(MATH_INTEGER_RETURN_TYPES)) {
  for (const [suffix, argumentType] of [['', 'double'], ['f', 'float'], ['l', 'long double']] as const) {
    BUILTINS[`${base}${suffix}`] = { returnType, parameters: [argumentType] };
  }
}
for (const [name, suffix] of [['nan', ''], ['nanf', 'f'], ['nanl', 'l']] as const) {
  const returnType: CType = suffix === 'f' ? 'float' : suffix === 'l' ? 'long double' : 'double';
  BUILTINS[name] = { returnType, parameters: [pointerTo(qualifyType('char', { const: true }))] };
}
BUILTINS.fma = { returnType: 'double', parameters: ['double', 'double', 'double'] };
BUILTINS.fmaf = { returnType: 'float', parameters: ['float', 'float', 'float'] };
BUILTINS.fmal = { returnType: 'long double', parameters: ['long double', 'long double', 'long double'] };
// Classification macros retain their argument's original floating type. Their
// double signature validates scalar calls; callBuiltin handles them before casts.
for (const name of MATH_CLASSIFICATION_FUNCTIONS) BUILTINS[name] = { returnType: 'int', parameters: ['double'] };
for (const name of MATH_CLASSIFICATION_BUILTINS) BUILTINS[name] = { returnType: 'int', parameters: ['double'] };
for (const name of MATH_COMPARISON_BUILTINS) BUILTINS[name] = { returnType: 'int', parameters: ['double', 'double'] };
BUILTINS.__c11_nan = { returnType: 'float', parameters: [] };
BUILTINS.__c11_inf = { returnType: 'float', parameters: [] };
for (const name of HEAP_ALLOCATOR_BUILTINS) {
  const signature = HEAP_ALLOCATOR_SIGNATURES[name];
  BUILTINS[name] = { returnType: signature.returnType, parameters: [...signature.parameters] };
}
BUILTINS.free = { returnType: 'void', parameters: [pointerTo('void')] };
export interface BuiltinCallContext {
  readonly writeOutput?: (argumentIndex: number, value: CValue) => void;
  readonly setErrno?: (value: number) => void;
}

function asBinary80(value: CValue, location: Location): Binary80Value {
  arithmetic(value, location);
  if (isBinary80(value.value)) return value.value;
  if (typeof value.value === 'number') return binary80FromNumber(value.value);
  if (typeof value.value === 'bigint') {
    return binary80FromRational(value.value < 0n ? -value.value : value.value, 1n, { negative: value.value < 0n });
  }
  failure('INVALID_OPERAND_TYPE', 'Math functions require arithmetic operands.', location);
}

function binaryFormat(type: CType): 'binary32' | 'binary64' | 'binary80' {
  return type === 'float' ? 'binary32' : type === 'long double' ? 'binary80' : 'binary64';
}

export function callBuiltin(name: string, args: CValue[], location: Location, context: BuiltinCallContext = {}): CValue {
  const signature = BUILTINS[name];
  if (!signature) failure('UNSUPPORTED_FEATURE', `Function «${name}» is not part of the published math and P2 library profile.`, location);
  if ((HEAP_ALLOCATOR_BUILTINS as readonly string[]).includes(name) || name === 'free') failure('ENGINE_INTERNAL_ERROR', `Function «${name}» must run with the virtual store.`, location);
  if (args.length !== signature.parameters.length) failure('ARGUMENT_COUNT', `«${name}» requires ${signature.parameters.length} arguments.`, location);
  if (name === '__c11_nan') return { type: 'float', value: NaN };
  if (name === '__c11_inf') return { type: 'float', value: Infinity };
  if (nanFunctions.has(name)) {
    if (signature.returnType === 'long double') return { type: 'long double', value: binary80NaN() };
    return floating(NaN, signature.returnType as 'float' | 'double');
  }
  if (classification.has(name) || classificationBuiltins.has(name)) {
    const operation = name.startsWith('__c11_') ? name.slice('__c11_'.length) : name;
    arithmetic(args[0], location);
    if (isBinary80(args[0].value)) {
      const value = args[0].value;
      const finite = value.classification === 'finite';
      const zero = finite && value.significand === 0n;
      const subnormal = finite && value.significand > 0n && value.significand < (1n << 63n);
      if (operation === 'isnan') return int(value.classification === 'nan');
      if (operation === 'isinf') return int(value.classification === 'infinity');
      if (operation === 'isfinite') return int(finite);
      if (operation === 'isnormal') return int(finite && !zero && !subnormal);
      if (operation === 'signbit') return int(value.negative);
      return int(value.classification === 'nan' ? 0 : value.classification === 'infinity' ? 1 : zero ? 2 : subnormal ? 3 : 4);
    }
    const value = Number(args[0].value);
    const absolute = Math.abs(value);
    const subnormal = absolute > 0 && absolute < (args[0].type === 'float' ? 2 ** -126 : 2 ** -1022);
    if (operation === 'isnan') return int(Number.isNaN(value));
    if (operation === 'isinf') return int(!Number.isFinite(value) && !Number.isNaN(value));
    if (operation === 'isfinite') return int(Number.isFinite(value));
    if (operation === 'isnormal') return int(Number.isFinite(value) && value !== 0 && !subnormal);
    if (operation === 'signbit') return int(isNegative(value));
    return int(Number.isNaN(value) ? 0 : !Number.isFinite(value) ? 1 : value === 0 ? 2 : subnormal ? 3 : 4);
  }
  if (comparisonBuiltins.has(name)) {
    const operation = name.slice('__c11_'.length);
    const type = commonType(args[0].type, args[1].type);
    const left = asBinary80(convert(args[0], type, location), location);
    const right = asBinary80(convert(args[1], type, location), location);
    const unordered = left.classification === 'nan' || right.classification === 'nan';
    const order = binary80Compare(left, right);
    if (operation === 'isunordered') return int(unordered);
    if (unordered) return int(false);
    if (operation === 'isgreater') return int(order === 1);
    if (operation === 'isgreaterequal') return int(order === 1 || order === 0);
    if (operation === 'isless') return int(order === -1);
    if (operation === 'islessequal') return int(order === -1 || order === 0);
    return int(order !== 0);
  }
  if ((MATH_FMA_FUNCTIONS as readonly string[]).includes(name)) {
    const type = signature.parameters[0];
    const values = args.map((argument) => convert(argument, type, location));
    const binary80Values = values.map((argument) => {
      if (isBinary80(argument.value)) return argument.value;
      if (typeof argument.value !== 'number') failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» received a non-floating value.`, location);
      return binary80FromNumber(argument.value);
    });
    if (signature.returnType === 'double' || signature.returnType === 'float') {
      const format = signature.returnType === 'float' ? 'binary32' : 'binary64';
      const exact = binary80FusedMultiplyAdd(binary80Values[0], binary80Values[1], binary80Values[2]);
      const result = binary80FusedMultiplyAddToNumber(binary80Values[0], binary80Values[1], binary80Values[2], format);
      if (binary80Values.every((value) => value.classification === 'finite') && exact.classification === 'finite' &&
          (!Number.isFinite(result) || result === 0 && exact.significand !== 0n)) context.setErrno?.(ERRNO_CODES.ERANGE);
      return floating(result, signature.returnType);
    }
    const result = binary80FusedMultiplyAdd(binary80Values[0], binary80Values[1], binary80Values[2]);
    if (binary80Values.every((value) => value.classification === 'finite') && result.classification === 'infinity') {
      context.setErrno?.(ERRNO_CODES.ERANGE);
    }
    return { type: 'long double', value: result };
  }
  const floatingFormat = binaryFormat(signature.parameters[0]);
  const isScaling = MATH_SCALING_FUNCTIONS.some((base) => name === base || name === `${base}f` || name === `${base}l`);
  const isOutputUnary = MATH_OUT_UNARY_FUNCTIONS.some((base) => name === base || name === `${base}f` || name === `${base}l`);
  const isRemquo = MATH_REMQUO_FUNCTIONS.includes(name as typeof MATH_REMQUO_FUNCTIONS[number]);
  const floatingArgumentCount = isScaling || isOutputUnary ? 1 : isRemquo ? 2 : args.length;
  const values = args.slice(0, floatingArgumentCount).map((argument, index) => {
    const converted = convert(argument, signature.parameters[index], location);
    return asBinary80(converted, location);
  });
  let integerArgument: bigint | undefined;
  if (isScaling) {
    const exponent = convert(args[1], signature.parameters[1], location).value;
    if (typeof exponent !== 'bigint') failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» lost its integer exponent.`, location);
    integerArgument = exponent;
  }
  const kernel = callMathKernel(name, values, { format: floatingFormat, integerArgument });
  if (!kernel) failure('UNSUPPORTED_FEATURE', `Math function «${name}» is outside the published math profile.`, location);
  let mathError = kernel.error;
  if (kernel.value && values.every((value) => value.classification === 'finite')) {
    const rounded = binary80RoundToFormat(kernel.value, floatingFormat);
    if (rounded.classification === 'infinity' && kernel.value.classification === 'finite' ||
        rounded.classification === 'finite' && rounded.significand === 0n && kernel.value.classification === 'finite' && kernel.value.significand !== 0n) {
      mathError = 'range';
    }
    const minimumNormalExponent = floatingFormat === 'binary32' ? -126 : floatingFormat === 'binary64' ? -1022 : -16382;
    if (rounded.classification === 'finite' && rounded.significand !== 0n &&
        rounded.exponent + rounded.significand.toString(2).length - 1 < minimumNormalExponent &&
        binary80Compare(rounded, kernel.value) !== 0) {
      mathError = 'range';
    }
  }
  if (mathError) context.setErrno?.(mathError === 'domain' ? ERRNO_CODES.EDOM : ERRNO_CODES.ERANGE);
  if (kernel.output && context.writeOutput && mathError !== 'domain') {
    const output = typeof kernel.output.value === 'bigint'
      ? { type: 'int' as CType, value: kernel.output.value }
      : { type: signature.returnType, value: kernel.output.value };
    context.writeOutput(kernel.output.argumentIndex, output);
  }
  if (kernel.integerValue !== undefined) return { type: signature.returnType, value: kernel.integerValue };
  if (kernel.value) {
    if (signature.returnType === 'long double') return { type: 'long double', value: binary80RoundToFormat(kernel.value, 'binary80') };
    const rounded = binary80ToNumber(kernel.value, floatingFormat as 'binary32' | 'binary64');
    return floating(rounded, signature.returnType as 'float' | 'double');
  }
  failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» did not produce a result.`, location);
}
