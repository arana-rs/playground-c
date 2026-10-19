import { failure } from './internal.ts';
import type { CType, CValue, Location } from './internal.ts';
import { enumType, isArithmetic, isInteger, pointerType, scalarSize, unqualifiedType } from './type-system.ts';

interface IntegerInfo { bits: number; rank: number; unsigned: boolean }
export const integers: Record<string, IntegerInfo | undefined> = {
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
export function bounds(type: CType): { min: bigint; max: bigint } {
  const integerType = integerRepresentationType(type)!;
  const info = integers[integerType]!;
  if (type === '_Bool') return { min: 0n, max: 1n };
  return info.unsigned
    ? { min: 0n, max: (1n << BigInt(info.bits)) - 1n }
    : { min: -(1n << BigInt(info.bits - 1)), max: (1n << BigInt(info.bits - 1)) - 1n };
}
export function normalize(value: bigint, type: CType): bigint {
  const integerType = integerRepresentationType(type)!;
  const info = integers[integerType]!;
  return info.unsigned ? BigInt.asUintN(info.bits, value) : BigInt.asIntN(info.bits, value);
}
export function checked(value: bigint, type: CType, location: Location): CValue {
  type = unqualifiedType(type);
  const integerType = integerRepresentationType(type)!;
  const info = integers[integerType]!;
  if (info.unsigned) return { type, value: normalize(value, type) };
  const range = bounds(type);
  if (value < range.min || value > range.max) failure('SIGNED_OVERFLOW', `Signed ${integerType} overflow for a ${info.bits}-bit integer: undefined behavior in C11.`, location);
  return { type, value };
}
export function int(value: boolean | number): CValue { return { type: 'int', value: BigInt(value ? (typeof value === 'number' ? value : 1) : 0) }; }
export function floating(value: number, type: 'float' | 'double'): CValue { return { type, value: type === 'float' ? Math.fround(value) : value }; }
export function arithmetic(value: CValue, location: Location): void {
  if (!isArithmetic(value.type)) failure('INVALID_OPERAND_TYPE', 'An arithmetic operand is required.', location);
}
