import { failure } from './internal.ts';
import type { CValue, Location } from './internal.ts';
import {
  binary80Add, binary80Compare, binary80Divide, binary80Multiply, binary80Negate, binary80Subtract,
} from './binary80.ts';
import { arithmetic, bounds, checked, commonType, floating, int, integers, normalize, promote } from './numeric-integers.ts';
import { convert, isBinary80, numericData, truth } from './numeric-conversions.ts';
import { compatibleType, isInteger, isPointer } from './type-system.ts';

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
