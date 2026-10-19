import type { CType, CValue, Location, ObjectPointerValue } from './internal.ts';
import { ERRNO_CODES, ERRNO_MESSAGES } from './errno-metadata.ts';
import type { LibraryRuntimeContext } from './library.ts';

export const EOF_VALUE = -1;
export const STREAM_READ_CHUNK_BYTES = 4096;
export const ERRNO = ERRNO_CODES;
const intTypes = new Set(['_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long']);
export const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function invalid(context: LibraryRuntimeContext, message: string, at: Location): never {
  return context.fail('LIBRARY_ARGUMENT', message, at);
}

export function argCount(args: readonly CValue[], min: number, max: number, name: string, context: LibraryRuntimeContext, at: Location): void {
  if (args.length < min || args.length > max) invalid(context, `${name} received an invalid number of arguments.`, at);
}

export function integerValue(value: CValue, at: Location, context: LibraryRuntimeContext): bigint {
  if (typeof value.value !== 'bigint') invalid(context, 'Expected an integer argument.', at);
  return value.value;
}

export function pointerValue(value: CValue, at: Location, context: LibraryRuntimeContext, allowNull = false): CValue {
  if (value.value === null && allowNull) return value;
  if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') {
    invalid(context, 'Expected an object pointer.', at);
  }
  return value;
}

export function returnInteger(value: bigint | number, resultType: CType | undefined, context: LibraryRuntimeContext): CValue {
  const type = typeof resultType === 'string' && intTypes.has(resultType) ? resultType : 'int';
  return context.makeInt(value, type);
}

export function returnPointer(pointer: CValue, resultType?: CType): CValue {
  return { type: resultType ?? pointer.type, value: pointer.value as ObjectPointerValue | null };
}

export function returnVoid(): CValue { return { type: 'void', value: 0n }; }

export function cString(value: CValue, at: Location, context: LibraryRuntimeContext, maxBytes?: number): Uint8Array {
  if (value.value === null) invalid(context, 'Cannot read a string from a null pointer.', at);
  return context.readCString(value, at, maxBytes);
}

export function cStringByte(value: CValue, index: number, at: Location, context: LibraryRuntimeContext): number {
  if (value.value === null) invalid(context, 'Cannot read a string from a null pointer.', at);
  return context.readBytes(context.offsetPointer(value, index, at), 1, at)[0] ?? 0;
}

export function makePointerAt(pointer: CValue, offset: number, resultType: CType | undefined, at: Location, context: LibraryRuntimeContext): CValue {
  if (pointer.value === null) return { type: resultType ?? pointer.type, value: null };
  return returnPointer(context.offsetPointer(pointer, offset, at), resultType);
}

export function writeBytes(pointer: CValue, bytes: Uint8Array, at: Location, context: LibraryRuntimeContext): void {
  if (bytes.length === 0) return;
  context.preflightMemoryWrite(pointer, bytes.length, at);
  context.chargeWork(bytes.length, at);
  context.writeBytes(pointer, bytes, at);
}

export function compareBytes(left: Uint8Array, right: Uint8Array, count = Math.min(left.length, right.length)): number {
  for (let index = 0; index < count; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}
export const asciiWhitespace = new Set([9, 10, 11, 12, 13, 32]);

export function checkedSize(value: CValue, name: string, context: LibraryRuntimeContext, at: Location): number {
  const amount = integerValue(value, at, context);
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) invalid(context, `${name} received a size outside the safe range.`, at);
  return Number(amount);
}

export function compareCStringPointers(
  left: CValue,
  right: CValue,
  maxBytes: number | undefined,
  context: LibraryRuntimeContext,
  at: Location,
): { readonly result: number; readonly work: number } {
  for (let index = 0; maxBytes === undefined || index < maxBytes; index++) {
    const leftByte = context.readBytes(context.offsetPointer(left, index, at), 1, at)[0] ?? 0;
    const rightByte = context.readBytes(context.offsetPointer(right, index, at), 1, at)[0] ?? 0;
    if (leftByte !== rightByte) return { result: leftByte < rightByte ? -1 : 1, work: index + 1 };
    if (leftByte === 0) return { result: 0, work: index + 1 };
  }
  return { result: 0, work: maxBytes ?? 0 };
}
export function safeFormatNumber(text: string, context: LibraryRuntimeContext, at: Location): number {
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    context.preflightOutputBytes(Number.MAX_SAFE_INTEGER, at);
    invalid(context, 'The format width or precision exceeds the safe range.', at);
  }
  return Number(value);
}
export function eofMinusOne(resultType: CType | undefined, context: LibraryRuntimeContext): CValue { return returnInteger(-1, resultType, context); }

export function errorMessage(code: number): string { return ERRNO_MESSAGES[code] ?? 'Unknown error'; }
