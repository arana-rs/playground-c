import type { AggregateValue, CType, CValue, Location, ObjectPointerValue } from './internal.ts';
import { binary80FromNumber, binary80ToRational, formatBinary80Hex, parseBinary80 } from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import { isValidVirtualOpenMode } from './virtual-io.ts';
import { normalizeVirtualPath } from './virtual-path.ts';
import type { VirtualByteRead, VirtualIO, VirtualStream } from './virtual-io.ts';

const EOF_VALUE = -1;
const INPUT_NEEDED = 'input-needed' as const;
const STREAM_READ_CHUNK_BYTES = 4096;
const ERRNO = Object.freeze({ EIO: 5, ENOENT: 2, EBADF: 9, EINVAL: 22, ERANGE: 34, EILSEQ: 84 });
const intTypes = new Set(['_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long']);
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export type ResumableLibraryBuiltin = Generator<typeof INPUT_NEEDED, CValue, void>;
export type LibraryBuiltinResult = CValue | ResumableLibraryBuiltin;

function invalid(context: LibraryRuntimeContext, message: string, at: Location): never {
  return context.fail('LIBRARY_ARGUMENT', message, at);
}

function argCount(args: readonly CValue[], min: number, max: number, name: string, context: LibraryRuntimeContext, at: Location): void {
  if (args.length < min || args.length > max) invalid(context, `${name} recibió una cantidad de argumentos no válida.`, at);
}

function integerValue(value: CValue, at: Location, context: LibraryRuntimeContext): bigint {
  if (typeof value.value !== 'bigint') invalid(context, 'Se esperaba un argumento entero.', at);
  return value.value;
}

function pointerValue(value: CValue, at: Location, context: LibraryRuntimeContext, allowNull = false): CValue {
  if (value.value === null && allowNull) return value;
  if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') {
    invalid(context, 'Se esperaba un puntero a objeto.', at);
  }
  return value;
}

function returnInteger(value: bigint | number, resultType: CType | undefined, context: LibraryRuntimeContext): CValue {
  const type = typeof resultType === 'string' && intTypes.has(resultType) ? resultType : 'int';
  return context.makeInt(value, type);
}

function returnPointer(pointer: CValue, resultType?: CType): CValue {
  return { type: resultType ?? pointer.type, value: pointer.value as ObjectPointerValue | null };
}

function returnVoid(): CValue { return { type: 'void', value: 0n }; }

function cString(value: CValue, at: Location, context: LibraryRuntimeContext): Uint8Array {
  if (value.value === null) invalid(context, 'No se puede leer una cadena desde un puntero nulo.', at);
  return context.readCString(value, at);
}

function makePointerAt(pointer: CValue, offset: number, resultType: CType | undefined, at: Location, context: LibraryRuntimeContext): CValue {
  if (pointer.value === null) return { type: resultType ?? pointer.type, value: null };
  return returnPointer(context.offsetPointer(pointer, offset, at), resultType);
}

function writeBytes(pointer: CValue, bytes: Uint8Array, at: Location, context: LibraryRuntimeContext): void {
  if (bytes.length === 0) return;
  context.preflightMemoryWrite(pointer, bytes.length, at);
  context.chargeWork(bytes.length, at);
  context.writeBytes(pointer, bytes, at);
}

function compareBytes(left: Uint8Array, right: Uint8Array, count = Math.min(left.length, right.length)): number {
  for (let index = 0; index < count; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function inSet(byte: number, set: ReadonlySet<number>): boolean { return set.has(byte); }
const asciiWhitespace = new Set([9, 10, 11, 12, 13, 32]);

function ctype(name: string, byte: number): number {
  if (byte < 0 || byte > 255) return name === 'tolower' || name === 'toupper' ? byte : 0;
  const alpha = byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122;
  const digit = byte >= 48 && byte <= 57;
  const control = byte < 32 || byte === 127;
  const whitespace = inSet(byte, asciiWhitespace);
  const lower = byte >= 97 && byte <= 122;
  const upper = byte >= 65 && byte <= 90;
  switch (name) {
    case 'isalnum': return alpha || digit ? 1 : 0;
    case 'isalpha': return alpha ? 1 : 0;
    case 'isblank': return byte === 9 || byte === 32 ? 1 : 0;
    case 'iscntrl': return control ? 1 : 0;
    case 'isdigit': return digit ? 1 : 0;
    case 'isgraph': return byte >= 33 && byte <= 126 ? 1 : 0;
    case 'islower': return lower ? 1 : 0;
    case 'isprint': return byte >= 32 && byte <= 126 ? 1 : 0;
    case 'ispunct': return byte >= 33 && byte <= 126 && !alpha && !digit ? 1 : 0;
    case 'isspace': return whitespace ? 1 : 0;
    case 'isupper': return upper ? 1 : 0;
    case 'isxdigit': return digit || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102 ? 1 : 0;
    case 'tolower': return upper ? byte + 32 : byte;
    case 'toupper': return lower ? byte - 32 : byte;
    default: return 0;
  }
}

function strtokBuiltin(args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  argCount(args, 2, 2, 'strtok', context, at);
  const delimiterBytes = cString(args[1], at, context);
  const delimiters = new Set(delimiterBytes);
  let source: CValue;
  if (args[0].value !== null) {
    source = args[0];
    strtokState.set(context.io, source);
  } else {
    source = strtokState.get(context.io) ?? { type: args[0].type, value: null };
  }
  if (source.value === null) return { type: resultType ?? args[0].type, value: null };
  const bytes = cString(source, at, context);
  context.chargeWork(bytes.length, at);
  let start = 0;
  while (start < bytes.length && delimiters.has(bytes[start])) start++;
  if (start === bytes.length) { strtokState.delete(context.io); return { type: resultType ?? args[0].type, value: null }; }
  let end = start;
  while (end < bytes.length && !delimiters.has(bytes[end])) end++;
  const token = context.offsetPointer(source, start, at);
  if (end < bytes.length) {
    context.writeBytes(context.offsetPointer(source, end, at), new Uint8Array([0]), at);
    strtokState.set(context.io, context.offsetPointer(source, end + 1, at));
  } else strtokState.delete(context.io);
  return returnPointer(token, resultType);
}

const strtokState = new WeakMap<VirtualIO, CValue>();

/** Runtime services supplied by execute.ts; no host I/O or DOM APIs cross this boundary. */
export interface LibraryRuntimeContext {
  readonly at: Location;
  readonly io: VirtualIO;
  readBytes(pointer: CValue, count: number, at: Location): Uint8Array;
  writeBytes(pointer: CValue, bytes: Uint8Array, at: Location): void;
  readCString(pointer: CValue, at: Location): Uint8Array;
  copyBytes(destination: CValue, source: CValue, count: number, at: Location): void;
  writeScalar(pointer: CValue, value: CValue, at: Location): void;
  formatPointer(value: CValue, at: Location): string;
  /** Converts only pointer spellings the selected VM profile can round-trip safely. */
  parsePointer?(text: string, at: Location): CValue;
  openFile(path: string, mode: string, at: Location): CValue | null;
  streamFor(file: CValue, at: Location): VirtualStream | null;
  standardFile(kind: 'stdin' | 'stdout' | 'stderr', at: Location): CValue;
  makeFilePointer(stream: VirtualStream, at: Location): CValue;
  closeFilePointer(file: CValue, at: Location): number;
  errno: { get(): number; set(value: number): void };
  makeErrnoPointer(): CValue;
  makeInt(value: bigint | number, type?: CType): CValue;
  chargeWork(count: number, at: Location): void;
  /** Checks a planned temporary/formatted output before allocating it. */
  preflightOutputBytes(count: number, at: Location): void;
  /** Checks the destination object before a library routine materializes a write. */
  preflightMemoryWrite(pointer: CValue, count: number, at: Location): void;
  offsetPointer(pointer: CValue, byteOffset: number, at: Location): CValue;
  makeString(bytes: Uint8Array, at: Location): CValue;
  fail(code: string, message: string, at: Location): never;
}

/**
 * Handle a P4 library routine. Returning undefined lets execute.ts continue to
 * the existing VM intrinsic dispatcher (malloc/free and numeric builtins).
 */
export function dispatchLibraryBuiltin(
  name: string,
  args: readonly CValue[],
  resultType: CType | undefined,
  context: LibraryRuntimeContext,
): LibraryBuiltinResult | undefined {
  const at = context.at;
  if (name === '__c11_nan' || name === '__c11_inf') {
    argCount(args, 0, 0, name, context, at);
    return { type: resultType ?? 'float', value: name === '__c11_nan' ? NaN : Infinity };
  }
  if (name === '__c11_stdin' || name === '__c11_stdout' || name === '__c11_stderr') {
    argCount(args, 0, 0, name, context, at);
    const kind = name === '__c11_stdin' ? 'stdin' : name === '__c11_stdout' ? 'stdout' : 'stderr';
    return returnPointer(context.standardFile(kind, at), resultType);
  }
  if (name === '__c11_errno_location') {
    argCount(args, 0, 0, name, context, at);
    return returnPointer(context.makeErrnoPointer(), resultType);
  }
  if (name === '__c11_assert_fail') {
    argCount(args, 3, 3, name, context, at);
    const expression = decodeUtf8(cString(args[0], at, context));
    const file = decodeUtf8(cString(args[1], at, context));
    const line = integerValue(args[2], at, context);
    return context.fail('ASSERTION_FAILED', `Falló assert(${expression}) en ${file}:${line}.`, at);
  }
  if (name.startsWith('is') && ['isalnum', 'isalpha', 'isblank', 'iscntrl', 'isdigit', 'isgraph', 'islower', 'isprint', 'ispunct', 'isspace', 'isupper', 'isxdigit'].includes(name) || name === 'tolower' || name === 'toupper') {
    argCount(args, 1, 1, name, context, at);
    return returnInteger(ctype(name, Number(integerValue(args[0], at, context))), resultType, context);
  }
  if (name === 'strlen') {
    argCount(args, 1, 1, name, context, at);
    const bytes = cString(args[0], at, context);
    context.chargeWork(bytes.length, at);
    return returnInteger(bytes.length, resultType, context);
  }
  if (name === 'memcpy' || name === 'memmove') {
    argCount(args, 3, 3, name, context, at);
    const count = checkedSize(args[2], name, context, at);
    if (count) {
      context.preflightMemoryWrite(args[0], count, at);
      context.chargeWork(count, at);
      context.copyBytes(args[0], args[1], count, at);
    }
    return returnPointer(args[0], resultType);
  }
  if (name === 'memset') {
    argCount(args, 3, 3, name, context, at);
    const count = checkedSize(args[2], name, context, at);
    if (count) {
      context.preflightMemoryWrite(args[0], count, at);
      context.chargeWork(count, at);
      const bytes = new Uint8Array(count);
      bytes.fill(Number(BigInt.asUintN(8, integerValue(args[1], at, context))));
      context.writeBytes(args[0], bytes, at);
    }
    return returnPointer(args[0], resultType);
  }
  if (name === 'memcmp') {
    argCount(args, 3, 3, name, context, at);
    const count = checkedSize(args[2], name, context, at);
    if (!count) return returnInteger(0, resultType, context);
    const left = context.readBytes(args[0], count, at);
    const right = context.readBytes(args[1], count, at);
    context.chargeWork(count, at);
    return returnInteger(compareBytes(left, right, count), resultType, context);
  }
  if (name === 'strcpy' || name === 'strcat' || name === 'strncpy' || name === 'strncat') {
    argCount(args, name.endsWith('ncpy') || name === 'strncat' ? 3 : 2, name.endsWith('ncpy') || name === 'strncat' ? 3 : 2, name, context, at);
    const source = cString(args[1], at, context);
    const bounded = name === 'strncpy' || name === 'strncat';
    const count = bounded ? checkedSize(args[2], name, context, at) : source.length;
    context.chargeWork(Math.min(count, source.length) + 1, at);
    if (name === 'strcpy') {
      const output = new Uint8Array(source.length + 1); output.set(source);
      writeBytes(args[0], output, at, context);
    } else if (name === 'strncpy') {
      context.preflightMemoryWrite(args[0], count, at);
      const output = new Uint8Array(count);
      output.set(source.subarray(0, count));
      context.writeBytes(args[0], output, at);
    } else {
      const destination = cString(args[0], at, context);
      const append = name === 'strcat' ? source : source.subarray(0, count);
      const padded = name === 'strncat' ? append.subarray(0, append.findIndex((byte) => byte === 0) < 0 ? append.length : append.findIndex((byte) => byte === 0)) : append;
      const output = new Uint8Array(padded.length + 1); output.set(padded);
      writeBytes(context.offsetPointer(args[0], destination.length, at), output, at, context);
    }
    return returnPointer(args[0], resultType);
  }
  if (name === 'strcmp' || name === 'strncmp') {
    argCount(args, name === 'strcmp' ? 2 : 3, name === 'strcmp' ? 2 : 3, name, context, at);
    const left = cString(args[0], at, context), right = cString(args[1], at, context);
    const count = name === 'strncmp' ? checkedSize(args[2], name, context, at) : Math.max(left.length, right.length) + 1;
    context.chargeWork(Math.min(count, Math.max(left.length, right.length) + 1), at);
    return returnInteger(compareCStringBytes(left, right, count), resultType, context);
  }
  if (name === 'strchr' || name === 'strrchr') {
    argCount(args, 2, 2, name, context, at);
    const source = cString(args[0], at, context), needle = Number(BigInt.asUintN(8, integerValue(args[1], at, context)));
    context.chargeWork(source.length, at);
    let found = -1;
    for (let index = 0; index <= source.length; index++) if ((source[index] ?? 0) === needle) {
      found = index;
      if (name === 'strchr') break;
    }
    return found < 0 ? { type: resultType ?? args[0].type, value: null } : makePointerAt(args[0], found, resultType, at, context);
  }
  if (name === 'strspn' || name === 'strcspn') {
    argCount(args, 2, 2, name, context, at);
    const source = cString(args[0], at, context), set = new Set(cString(args[1], at, context));
    let index = 0;
    while (index < source.length && (name === 'strspn' ? set.has(source[index]) : !set.has(source[index]))) index++;
    context.chargeWork(index, at);
    return returnInteger(index, resultType, context);
  }
  if (name === 'strpbrk') {
    argCount(args, 2, 2, name, context, at);
    const source = cString(args[0], at, context), set = new Set(cString(args[1], at, context));
    let index = 0; while (index < source.length && !set.has(source[index])) index++;
    context.chargeWork(index + 1, at);
    return index === source.length ? { type: resultType ?? args[0].type, value: null } : makePointerAt(args[0], index, resultType, at, context);
  }
  if (name === 'strstr') {
    argCount(args, 2, 2, name, context, at);
    const source = cString(args[0], at, context), needle = cString(args[1], at, context);
    context.chargeWork(source.length + needle.length, at);
    let found = 0;
    if (needle.length) {
      found = -1;
      outer: for (let index = 0; index + needle.length <= source.length; index++) {
        for (let part = 0; part < needle.length; part++) if (source[index + part] !== needle[part]) continue outer;
        found = index; break;
      }
    }
    return found < 0 ? { type: resultType ?? args[0].type, value: null } : makePointerAt(args[0], found, resultType, at, context);
  }
  if (name === 'strtok') return strtokBuiltin(args, resultType, context, at);
  if (name === 'strerror') {
    argCount(args, 1, 1, name, context, at);
    const code = Number(integerValue(args[0], at, context));
    const message = code === 0 ? 'Success' : code === ERRNO.ENOENT ? 'No such file or directory' : code === ERRNO.EBADF ? 'Bad file descriptor' : code === ERRNO.EINVAL ? 'Invalid argument' : code === ERRNO.ERANGE ? 'Result out of range' : code === ERRNO.EIO ? 'Input/output error' : 'Unknown error';
    return returnPointer(context.makeString(new TextEncoder().encode(message), at), resultType);
  }
  if (name === 'imaxabs') {
    argCount(args, 1, 1, name, context, at);
    const value = integerValue(args[0], at, context);
    return returnInteger(value < 0n ? -value : value, resultType, context);
  }
  if (name === 'imaxdiv') {
    argCount(args, 2, 2, name, context, at);
    const numerator = integerValue(args[0], at, context);
    const denominator = integerValue(args[1], at, context);
    if (denominator === 0n) return context.fail('DIVISION_BY_ZERO', 'imaxdiv no puede dividir entre cero.', at);
    if (numerator === -(1n << 63n) && denominator === -1n) {
      return context.fail('SIGNED_OVERFLOW', 'El cociente de imaxdiv excede intmax_t.', at);
    }
    if (!resultType || typeof resultType !== 'object' || resultType.kind !== 'aggregate') {
      return context.fail('ENGINE_INTERNAL_ERROR', 'imaxdiv necesita su tipo agregado de retorno.', at);
    }
    const value: AggregateValue = {
      kind: 'aggregate-value',
      snapshot: {
        initialized: true,
        children: {
          0: { initialized: true, value: numerator / denominator },
          1: { initialized: true, value: numerator % denominator },
        },
      },
    };
    return { type: resultType, value };
  }
  if (name === 'strtoimax' || name === 'strtoumax') return parseMaximumInteger(args, name, resultType, context, at);
  if (name === 'fopen') return fopenBuiltin(args, resultType, context, at);
  if (name.startsWith('printf') || name === 'fprintf' || name === 'sprintf' || name === 'snprintf') {
    return printfBuiltin(name, args, resultType, context, at);
  }
  if (['scanf', 'fscanf', 'sscanf'].includes(name)) return scanfBuiltin(name, args, resultType, context, at);
  if (['fgetc', 'getc', 'getchar', 'fgets', 'fread'].includes(name)) {
    return streamInputBuiltin(name, args, resultType, context, at);
  }
  if (['fclose', 'fflush', 'fputc', 'putc', 'putchar', 'fputs', 'puts', 'fwrite', 'fseek', 'ftell', 'rewind', 'ungetc', 'feof', 'ferror', 'clearerr', 'perror'].includes(name)) {
    return streamBuiltin(name, args, resultType, context, at);
  }
  return undefined;
}

function checkedSize(value: CValue, name: string, context: LibraryRuntimeContext, at: Location): number {
  const amount = integerValue(value, at, context);
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) invalid(context, `${name} recibió un tamaño fuera del rango seguro.`, at);
  return Number(amount);
}

function compareCStringBytes(left: Uint8Array, right: Uint8Array, count: number): number {
  for (let index = 0; index < count; index++) {
    const a = left[index] ?? 0, b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
    if (a === 0) return 0;
  }
  return 0;
}

function parseMaximumInteger(args: readonly CValue[], name: string, resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  argCount(args, 3, 3, name, context, at);
  const source = cString(args[0], at, context);
  let base = Number(integerValue(args[2], at, context));
  if (base !== 0 && (base < 2 || base > 36)) {
    context.errno.set(ERRNO.EINVAL);
    return context.makeInt(0n, resultType);
  }
  context.chargeWork(source.length, at);
  let index = 0;
  while (index < source.length && asciiWhitespace.has(source[index])) index++;
  let negative = false;
  if (source[index] === 43 || source[index] === 45) negative = source[index++] === 45;
  if ((base === 0 || base === 16) && source[index] === 48 && (source[index + 1] === 120 || source[index + 1] === 88) && digitForBase(source[index + 2] ?? -1, 16) >= 0) {
    base = 16; index += 2;
  } else if (base === 0) base = source[index] === 48 ? 8 : 10;
  const firstDigit = index;
  let magnitude = 0n;
  const maximum = name === 'strtoumax' ? (1n << 64n) - 1n : negative ? 1n << 63n : (1n << 63n) - 1n;
  let overflow = false;
  while (index < source.length) {
    const digit = digitForBase(source[index], base);
    if (digit < 0) break;
    const next = magnitude * BigInt(base) + BigInt(digit);
    if (next > maximum) { overflow = true; magnitude = maximum; }
    else if (!overflow) magnitude = next;
    index++;
  }
  // C requires endptr to retain the original nptr when no conversion occurs,
  // including when leading whitespace or a sign was consumed while probing.
  let end = firstDigit === index ? 0 : index;
  if (firstDigit === index) magnitude = 0n;
  let value = negative ? -magnitude : magnitude;
  if (name === 'strtoumax') value = BigInt.asUintN(64, value);
  else value = BigInt.asIntN(64, value);
  if (overflow) {
    context.errno.set(ERRNO.ERANGE);
    value = name === 'strtoumax' ? (1n << 64n) - 1n : negative ? -(1n << 63n) : (1n << 63n) - 1n;
  }
  if (args[1].value !== null) {
    const endPointer = context.offsetPointer(args[0], end, at);
    context.writeScalar(args[1], endPointer, at);
  }
  return context.makeInt(value, resultType);
}

function digitForBase(byte: number, base: number): number {
  const digit = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 90 ? byte - 55 : byte >= 97 && byte <= 122 ? byte - 87 : -1;
  return digit >= 0 && digit < base ? digit : -1;
}

function fopenBuiltin(args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  argCount(args, 2, 2, 'fopen', context, at);
  const path = decodeUtf8(cString(args[0], at, context));
  const mode = decodeUtf8(cString(args[1], at, context));
  if (!isValidVirtualOpenMode(mode) || !normalizeVirtualPath(path)) {
    context.errno.set(ERRNO.EINVAL);
    return { type: resultType ?? args[0].type, value: null };
  }
  const file = context.openFile(path, mode, at);
  if (!file) context.errno.set(ERRNO.ENOENT);
  return file ? returnPointer(file, resultType) : { type: resultType ?? args[0].type, value: null };
}

function printfBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  let formatIndex = 0;
  let destination: CValue | undefined;
  let capacity: number | undefined;
  let stream = context.io.stdout;
  if (name === 'fprintf') {
    argCount(args, 2, Number.MAX_SAFE_INTEGER, name, context, at);
    stream = context.streamFor(args[0], at)!;
    formatIndex = 1;
  } else if (name === 'sprintf') {
    argCount(args, 2, Number.MAX_SAFE_INTEGER, name, context, at);
    destination = args[0]; formatIndex = 1;
  } else if (name === 'snprintf') {
    argCount(args, 3, Number.MAX_SAFE_INTEGER, name, context, at);
    destination = args[0]; capacity = checkedSize(args[1], name, context, at); formatIndex = 2;
  } else {
    argCount(args, 1, Number.MAX_SAFE_INTEGER, name, context, at);
  }
  if (name === 'fprintf' && !stream) { context.errno.set(ERRNO.EBADF); return returnInteger(-1, resultType, context); }
  const formatted = formatOutput(args[formatIndex], args.slice(formatIndex + 1), context, at);
  if (formatted === null) {
    if (!destination) stream.markError();
    return returnInteger(-1, resultType, context);
  }
  if (destination) {
    const count = capacity === undefined ? formatted.length : Math.min(formatted.length, Math.max(0, capacity - 1));
    if (capacity === undefined || capacity > 0) {
      const output = new Uint8Array(count + 1);
      output.set(formatted.subarray(0, count));
      context.preflightMemoryWrite(destination, output.length, at);
      context.chargeWork(output.length, at);
      context.writeBytes(destination, output, at);
    }
  } else {
    const wrote = stream.writeBytes(formatted, at);
    if (wrote !== formatted.length) { context.errno.set(ERRNO.EIO); return returnInteger(-1, resultType, context); }
  }
  return returnInteger(formatted.length, resultType, context);
}

function formatOutput(formatValue: CValue, args: readonly CValue[], context: LibraryRuntimeContext, at: Location): Uint8Array | null {
  const format = decodeUtf8(cString(formatValue, at, context));
  context.chargeWork(format.length, at);
  let argumentIndex = 0;
  let total = 0;
  const pieces: Uint8Array[] = [];
  const reserve = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total + count)) invalid(context, 'El resultado de formato excede el rango seguro.', at);
    context.preflightOutputBytes(total + count, at);
  };
  const append = (bytes: Uint8Array): void => {
    reserve(bytes.length);
    pieces.push(bytes); total += bytes.length;
  };
  const take = (): CValue => {
    const value = args[argumentIndex++];
    if (!value) invalid(context, 'La cadena de formato requiere más argumentos.', at);
    return value;
  };
  const takeInteger = (): bigint => integerValue(take(), at, context);

  for (let index = 0; index < format.length;) {
    if (format[index] !== '%') {
      const start = index++;
      while (index < format.length && format[index] !== '%') index++;
      append(new TextEncoder().encode(format.slice(start, index)));
      continue;
    }
    index++;
    if (format[index] === '%') { append(new Uint8Array([37])); index++; continue; }
    let flags = '';
    while (index < format.length && '-+ #0\''.includes(format[index])) flags += format[index++];
    let widthText = '';
    let width: number | undefined;
    if (format[index] === '*') { const raw = Number(takeInteger()); width = Math.abs(raw); if (raw < 0) flags += '-'; index++; }
    else {
      while (index < format.length && /[0-9]/.test(format[index])) widthText += format[index++];
      if (widthText) width = safeFormatNumber(widthText, context, at);
    }
    let precision: number | undefined;
    if (format[index] === '.') {
      index++;
      if (format[index] === '*') { precision = Number(takeInteger()); index++; if (precision < 0) precision = undefined; }
      else {
        let precisionText = '';
        while (index < format.length && /[0-9]/.test(format[index])) precisionText += format[index++];
        precision = precisionText ? safeFormatNumber(precisionText, context, at) : 0;
      }
    }
    let length = '';
    for (const candidate of ['hh', 'll', 'h', 'l', 'j', 'z', 't', 'L']) if (format.startsWith(candidate, index)) { length = candidate; index += candidate.length; break; }
    const specifier = format[index++];
    if (!specifier) invalid(context, 'La cadena de formato termina dentro de una conversión.', at);
    if (specifier === 'n') {
      const pointer = take();
      context.writeScalar(pointer, context.makeInt(total, printfCountType(length)), at);
      continue;
    }
    const value = take();
    const longDouble = length === 'L' && 'fFeEgGaA'.includes(specifier) ? asBinary80(value) : undefined;
    if (length === 'L' && 'fFeEgGaA'.includes(specifier) && !longDouble) {
      return context.fail('LIBRARY_ARGUMENT', `La conversión «%L${specifier}» requiere un argumento long double.`, at);
    }
    let core: Uint8Array;
    let isNumeric = false;
    if ('diuoxX'.includes(specifier)) {
      isNumeric = true;
      const signed = specifier === 'd' || specifier === 'i';
      const bits = length === 'hh' ? 8 : length === 'h' ? 16 : ['l', 'll', 'j', 'z', 't'].includes(length) ? 64 : 32;
      let integer = integerValue(value, at, context);
      integer = signed ? BigInt.asIntN(bits, integer) : BigInt.asUintN(bits, integer);
      const negative = signed && integer < 0n;
      let digits = (negative ? -integer : integer).toString(specifier === 'o' ? 8 : specifier === 'x' || specifier === 'X' ? 16 : 10);
      if (specifier === 'X') digits = digits.toUpperCase();
      if (precision === 0 && integer === 0n) digits = '';
      const sign = negative ? '-' : signed && flags.includes('+') ? '+' : signed && flags.includes(' ') ? ' ' : '';
      const prefix = flags.includes('#') && integer !== 0n ? specifier === 'o' ? '0' : specifier === 'x' ? '0x' : specifier === 'X' ? '0X' : '' : '';
      const zeroPrecision = Math.max(0, (precision ?? 0) - digits.length);
      reserve(Math.max(width ?? 0, sign.length + prefix.length + zeroPrecision + digits.length));
      const body = '0'.repeat(zeroPrecision) + digits;
      core = encodePadded(sign + prefix, body, width ?? 0, flags, true, context, at);
    } else if ('aA'.includes(specifier)) {
      isNumeric = true;
      if (precision !== undefined && precision > 100_000) return context.fail('UNSUPPORTED_FEATURE', 'La precisión hexadecimal supera el máximo implementado (100000 dígitos).', at);
      reserve(Math.max(width ?? 0, (precision ?? 64) + 32));
      const uppercase = specifier === 'A';
      const { prefix, digits, negative, finite } = formatHexFloatValue(value, longDouble, precision, flags.includes('#'), uppercase, context, at);
      const sign = negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      core = encodePadded(sign + prefix, digits, width ?? 0, flags, finite, context, at);
    } else if (length === 'L' && 'fFeEgG'.includes(specifier)) {
      isNumeric = true;
      const requestedPrecision = precision ?? 6;
      if (requestedPrecision > 100) return context.fail('UNSUPPORTED_FEATURE', 'La precisión decimal supera el máximo implementado (100 dígitos).', at);
      const formatted = formatBinary80Decimal(longDouble!, specifier.toLowerCase() as 'f' | 'e' | 'g', requestedPrecision, flags.includes('#'));
      let digits = formatted.digits;
      if (specifier === specifier.toUpperCase()) digits = digits.toUpperCase();
      const sign = formatted.negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      reserve(Math.max(width ?? 0, sign.length + digits.length));
      core = encodePadded(sign, digits, width ?? 0, flags, formatted.finite, context, at);
    } else if ('fFeEgG'.includes(specifier)) {
      isNumeric = true;
      const numeric = typeof value.value === 'number' ? value.value : typeof value.value === 'bigint' ? Number(value.value) : NaN;
      const requestedPrecision = precision ?? 6;
      const estimated = Math.max(32, requestedPrecision + 32);
      reserve(Math.max(width ?? 0, estimated));
      if (requestedPrecision > 100) return context.fail('UNSUPPORTED_FEATURE', 'La precisión decimal supera el máximo implementado (100 dígitos).', at);
      let digits: string;
      if (!Number.isFinite(numeric)) {
        digits = Number.isNaN(numeric) ? 'nan' : 'inf';
      } else switch (specifier.toLowerCase()) {
        case 'f': digits = formatFixedFloat(Math.abs(numeric), requestedPrecision); break;
        case 'e': digits = normalizeDecimalExponent(Math.abs(numeric).toExponential(requestedPrecision)); break;
        case 'g': digits = formatGeneralFloat(Math.abs(numeric), requestedPrecision === 0 ? 1 : requestedPrecision, flags.includes('#')); break;
        default: return context.fail('ENGINE_INTERNAL_ERROR', 'Conversión de formato flotante no reconocida.', at);
      }
      if (specifier === specifier.toUpperCase()) digits = digits.toUpperCase();
      if (flags.includes('#') && Number.isFinite(numeric) && !digits.includes('.')) {
        const exponentIndex = digits.search(/[eE]/);
        digits = exponentIndex < 0 ? `${digits}.` : `${digits.slice(0, exponentIndex)}.${digits.slice(exponentIndex)}`;
      }
      const sign = numeric < 0 || Object.is(numeric, -0) ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      if (sign === '-' && digits.startsWith('-')) digits = digits.slice(1);
      reserve(Math.max(width ?? 0, sign.length + digits.length));
      core = encodePadded(sign, digits, width ?? 0, flags, true, context, at);
    } else if (specifier === 's') {
      let bytes = length === 'l'
        ? wideStringToBytes(value, precision, total, context, at)
        : cString(value, at, context);
      if (bytes === null) return null;
      if (precision !== undefined) bytes = bytes.subarray(0, precision);
      core = padBytes(bytes, width ?? 0, flags.includes('-'), context, at, total);
    } else if (specifier === 'c') {
      if (length === 'l') {
        const byte = wideCharacterToByte(integerValue(value, at, context), context, at);
        if (byte === null) return null;
        core = padBytes(new Uint8Array([byte]), width ?? 0, flags.includes('-'), context, at, total);
        append(core);
        continue;
      }
      const byte = Number(BigInt.asUintN(8, integerValue(value, at, context)));
      core = padBytes(new Uint8Array([byte]), width ?? 0, flags.includes('-'), context, at, total);
    } else if (specifier === 'p') {
      const text = context.formatPointer(value, at);
      core = padBytes(new TextEncoder().encode(text), width ?? 0, flags.includes('-'), context, at, total);
    } else invalid(context, `La conversión «%${length}${specifier}» no está implementada.`, at);
    if (isNumeric && flags.includes('0') && !flags.includes('-') && precision === undefined) {
      // Numeric fields are padded in encodePadded before allocation.
    }
    append(core);
  }
  context.preflightOutputBytes(total, at);
  context.chargeWork(total, at);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of pieces) { result.set(part, offset); offset += part.length; }
  return result;
}

function wideCharacterToByte(value: bigint, context: LibraryRuntimeContext, at: Location): number | null {
  const scalar = Number(BigInt.asUintN(32, value));
  context.chargeWork(1, at);
  if (scalar > 0x7f) {
    context.errno.set(ERRNO.EILSEQ);
    return null;
  }
  return scalar;
}

function wideStringToBytes(
  value: CValue,
  precision: number | undefined,
  total: number,
  context: LibraryRuntimeContext,
  at: Location,
): Uint8Array | null {
  if (value.value === null) invalid(context, 'No se puede leer una cadena wide desde un puntero nulo.', at);
  const bytes: number[] = [];
  while (precision === undefined || bytes.length < precision) {
    const scalarBytes = context.readBytes(context.offsetPointer(value, bytes.length * 4, at), 4, at);
    const scalar = new DataView(scalarBytes.buffer, scalarBytes.byteOffset, scalarBytes.byteLength).getUint32(0, true);
    if (scalar === 0) break;
    context.chargeWork(1, at);
    if (scalar > 0x7f) {
      context.errno.set(ERRNO.EILSEQ);
      return null;
    }
    bytes.push(scalar);
    context.preflightOutputBytes(total + bytes.length, at);
  }
  return Uint8Array.from(bytes);
}

function asBinary80(value: CValue): Binary80Value | undefined {
  if (typeof value.value !== 'object' || value.value === null) return undefined;
  const candidate = value.value as unknown as Partial<Binary80Value>;
  return candidate.kind === 'binary80' ? candidate as Binary80Value : undefined;
}

function formatHexFloatValue(
  value: CValue,
  longDouble: Binary80Value | undefined,
  precision: number | undefined,
  alternate: boolean,
  uppercase: boolean,
  context: LibraryRuntimeContext,
  at: Location,
): { prefix: string; digits: string; negative: boolean; finite: boolean } {
  const binary = longDouble ?? binary80FromNumber(
    typeof value.value === 'number' ? value.value : typeof value.value === 'bigint' ? Number(value.value) : NaN,
  );
  const rendered = formatBinary80Hex(binary, precision, uppercase);
  const negative = rendered.startsWith('-');
  let unsigned = negative ? rendered.slice(1) : rendered;
  const finite = binary.classification === 'finite';
  if (alternate && finite && !unsigned.includes('.')) {
    const markerIndex = unsigned.search(/[pP]/);
    unsigned = markerIndex < 0 ? `${unsigned}.` : `${unsigned.slice(0, markerIndex)}.${unsigned.slice(markerIndex)}`;
  }
  const prefix = unsigned.startsWith('0x') || unsigned.startsWith('0X') ? unsigned.slice(0, 2) : '';
  const digits = prefix ? unsigned.slice(2) : unsigned;
  void context; void at;
  return { prefix, digits, negative, finite };
}

function formatBinary80Decimal(
  value: Binary80Value,
  conversion: 'f' | 'e' | 'g',
  precision: number,
  alternate: boolean,
): { digits: string; negative: boolean; finite: boolean } {
  if (value.classification !== 'finite') {
    return { digits: value.classification === 'nan' ? 'nan' : 'inf', negative: value.negative, finite: false };
  }
  const { numerator, denominator, negative } = binary80ToRational(value);
  if (numerator === 0n) {
    if (conversion === 'f') return { digits: precision === 0 ? alternate ? '0.' : '0' : `0.${'0'.repeat(precision)}`, negative, finite: true };
    if (conversion === 'e') return { digits: `${precision === 0 ? alternate ? '0.' : '0' : `0.${'0'.repeat(precision)}`}e+00`, negative, finite: true };
    const count = precision === 0 ? 1 : precision;
    const digits = alternate && count > 1 ? `0.${'0'.repeat(count - 1)}` : alternate ? '0.' : '0';
    return { digits, negative, finite: true };
  }
  if (conversion === 'f') return { digits: formatRationalFixed(numerator, denominator, precision, alternate), negative, finite: true };
  if (conversion === 'e') return { digits: formatRationalScientific(numerator, denominator, precision, alternate), negative, finite: true };

  const significantDigits = precision === 0 ? 1 : precision;
  const rounded = roundedSignificand(numerator, denominator, significantDigits);
  const useScientific = rounded.exponent < -4 || rounded.exponent >= significantDigits;
  if (useScientific) {
    const coefficient = rounded.coefficient.toString().padStart(significantDigits, '0');
    let fraction = coefficient.slice(1);
    if (!alternate) fraction = fraction.replace(/0+$/, '');
    const mantissa = fraction.length ? `${coefficient[0]}.${fraction}` : alternate ? `${coefficient[0]}.` : coefficient[0];
    return { digits: `${mantissa}e${rounded.exponent < 0 ? '-' : '+'}${String(Math.abs(rounded.exponent)).padStart(2, '0')}`, negative, finite: true };
  }
  const decimalPosition = rounded.exponent + 1;
  const coefficient = rounded.coefficient.toString().padStart(significantDigits, '0');
  let whole: string, fraction: string;
  if (decimalPosition >= significantDigits) {
    whole = coefficient + '0'.repeat(decimalPosition - significantDigits); fraction = '';
  } else if (decimalPosition > 0) {
    whole = coefficient.slice(0, decimalPosition); fraction = coefficient.slice(decimalPosition);
  } else {
    whole = '0'; fraction = '0'.repeat(-decimalPosition) + coefficient;
  }
  if (!alternate) fraction = fraction.replace(/0+$/, '');
  const digits = fraction.length ? `${whole}.${fraction}` : alternate ? `${whole}.` : whole;
  return { digits, negative, finite: true };
}

function formatRationalFixed(numerator: bigint, denominator: bigint, precision: number, alternate: boolean): string {
  const rounded = roundRationalScaled(numerator, denominator, precision);
  if (precision === 0) return alternate ? `${rounded}.` : String(rounded);
  const digits = rounded.toString().padStart(precision + 1, '0');
  return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}

function formatRationalScientific(numerator: bigint, denominator: bigint, precision: number, alternate: boolean): string {
  let exponent = floorLog10Rational(numerator, denominator);
  let rounded = roundRationalScaled(numerator, denominator, precision - exponent);
  const carry = 10n ** BigInt(precision + 1);
  if (rounded >= carry) { rounded /= 10n; exponent++; }
  const digits = rounded.toString().padStart(precision + 1, '0');
  const fraction = digits.slice(1);
  const mantissa = precision === 0
    ? alternate ? `${digits[0]}.` : digits[0]
    : `${digits[0]}.${fraction}`;
  return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

function roundedSignificand(numerator: bigint, denominator: bigint, precision: number): { exponent: number; coefficient: bigint } {
  let exponent = floorLog10Rational(numerator, denominator);
  let coefficient = roundRationalScaled(numerator, denominator, precision - 1 - exponent);
  if (coefficient >= 10n ** BigInt(precision)) { coefficient /= 10n; exponent++; }
  return { exponent, coefficient };
}

function floorLog10Rational(numerator: bigint, denominator: bigint): number {
  let exponent = numerator.toString().length - denominator.toString().length;
  if (exponent >= 0) {
    if (numerator < denominator * 10n ** BigInt(exponent)) exponent--;
  } else if (numerator * 10n ** BigInt(-exponent) < denominator) exponent--;
  return exponent;
}

function roundRationalScaled(numerator: bigint, denominator: bigint, decimalScale: number): bigint {
  let scaledNumerator = numerator, scaledDenominator = denominator;
  if (decimalScale >= 0) scaledNumerator *= 10n ** BigInt(decimalScale);
  else scaledDenominator *= 10n ** BigInt(-decimalScale);
  const quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const twice = remainder * 2n;
  return twice > scaledDenominator || twice === scaledDenominator && (quotient & 1n) === 1n ? quotient + 1n : quotient;
}

function safeFormatNumber(text: string, context: LibraryRuntimeContext, at: Location): number {
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    context.preflightOutputBytes(Number.MAX_SAFE_INTEGER, at);
    invalid(context, 'El ancho o la precisión de formato excede el rango seguro.', at);
  }
  return Number(value);
}

function printfCountType(length: string): CType {
  if (length === 'hh') return 'signed char';
  if (length === 'h') return 'short';
  if (length === 'l' || length === 'j' || length === 'z' || length === 't') return 'long';
  if (length === 'll') return 'long long';
  return 'int';
}

/** Format a finite binary64 value with fixed precision using exact integer arithmetic. */
function formatFixedFloat(value: number, precision: number): string {
  if (value === 0) return precision === 0 ? '0' : `0.${'0'.repeat(precision)}`;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const exponentBits = (high >>> 20) & 0x7ff;
  let significand = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent2: number;
  if (exponentBits === 0) exponent2 = -1022 - 52;
  else {
    significand |= 1n << 52n;
    exponent2 = exponentBits - 1023 - 52;
  }
  const scaledNumerator = significand * 5n ** BigInt(precision);
  const shift = exponent2 + precision;
  let rounded: bigint;
  if (shift >= 0) rounded = scaledNumerator << BigInt(shift);
  else {
    const denominator = 1n << BigInt(-shift);
    const quotient = scaledNumerator / denominator;
    const remainder = scaledNumerator % denominator;
    const twiceRemainder = remainder * 2n;
    rounded = twiceRemainder > denominator || twiceRemainder === denominator && (quotient & 1n) === 1n
      ? quotient + 1n : quotient;
  }
  let digits = rounded.toString();
  if (!precision) return digits;
  digits = digits.padStart(precision + 1, '0');
  return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}

function encodePadded(prefix: string, digits: string, width: number, flags: string, numeric: boolean, context: LibraryRuntimeContext, at: Location): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix), digitBytes = new TextEncoder().encode(digits);
  const padding = Math.max(0, width - prefixBytes.length - digitBytes.length);
  const zero = numeric && flags.includes('0') && !flags.includes('-');
  context.preflightOutputBytes(prefixBytes.length + digitBytes.length + padding, at);
  const result = new Uint8Array(prefixBytes.length + digitBytes.length + padding);
  let offset = 0;
  result.set(prefixBytes, offset); offset += prefixBytes.length;
  if (padding && zero) { result.fill(48, offset, offset + padding); offset += padding; }
  result.set(digitBytes, offset); offset += digitBytes.length;
  if (padding && !zero) result.fill(32, offset);
  return result;
}

function padBytes(bytes: Uint8Array, width: number, left: boolean, context: LibraryRuntimeContext, at: Location, total: number): Uint8Array {
  const padding = Math.max(0, width - bytes.length);
  context.preflightOutputBytes(total + bytes.length + padding, at);
  const result = new Uint8Array(bytes.length + padding);
  if (left) { result.set(bytes); result.fill(32, bytes.length); }
  else { result.fill(32, 0, padding); result.set(bytes, padding); }
  return result;
}

function normalizeDecimalExponent(value: string): string {
  return value.replace(/([eE])([+-])(\d+)$/, (_match, marker: string, sign: string, digits: string) => `${marker}${sign}${digits.padStart(2, '0')}`);
}

function formatGeneralFloat(value: number, precision: number, alternate: boolean): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : 'inf';
  const absolute = Math.abs(value);
  const exponential = absolute.toExponential(precision - 1);
  const marker = exponential.indexOf('e');
  const exponent = Number(exponential.slice(marker + 1));
  if (exponent < -4 || exponent >= precision) {
    const mantissa = exponential.slice(0, marker);
    const selected = alternate
      ? mantissa.includes('.') ? mantissa : `${mantissa}.`
      : mantissa.replace(/0+$/, '').replace(/\.$/, '');
    return normalizeDecimalExponent(`${selected}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent))}`);
  }
  const decimals = Math.max(0, precision - 1 - exponent);
  const fixed = absolute.toFixed(decimals);
  return alternate
    ? fixed.includes('.') ? fixed : `${fixed}.`
    : fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function* readStreamByte(stream: VirtualStream, at: Location): Generator<typeof INPUT_NEEDED, number, void> {
  while (true) {
    const result = stream.readByteResult(at);
    if (result.kind === 'pending') {
      yield INPUT_NEEDED;
      continue;
    }
    return result.kind === 'byte' ? result.value : EOF_VALUE;
  }
}

function* streamInputBuiltin(
  name: string,
  args: readonly CValue[],
  resultType: CType | undefined,
  context: LibraryRuntimeContext,
  at: Location,
): ResumableLibraryBuiltin {
  const requireStream = (file: CValue): VirtualStream => {
    const stream = context.streamFor(file, at);
    if (!stream) { context.errno.set(ERRNO.EBADF); invalid(context, `${name} requiere un flujo FILE válido.`, at); }
    return stream;
  };
  const eof = (): CValue => returnInteger(EOF_VALUE, resultType, context);
  if (name === 'getchar' || name === 'fgetc' || name === 'getc') {
    argCount(args, name === 'getchar' ? 0 : 1, name === 'getchar' ? 0 : 1, name, context, at);
    const stream = name === 'getchar' ? context.io.stdin : requireStream(args[0]);
    const byte = yield* readStreamByte(stream, at);
    return byte < 0 ? eof() : returnInteger(byte, resultType, context);
  }
  if (name === 'fgets') {
    argCount(args, 3, 3, name, context, at);
    const count = Number(integerValue(args[1], at, context));
    const stream = requireStream(args[2]);
    if (count <= 0) return { type: resultType ?? args[0].type, value: null };
    const bytes: number[] = [];
    while (bytes.length < count - 1) {
      context.chargeWork(1, at);
      const byte = yield* readStreamByte(stream, at);
      if (byte < 0) break;
      bytes.push(byte);
      if (byte === 10) break;
    }
    if (!bytes.length) return { type: resultType ?? args[0].type, value: null };
    const output = new Uint8Array(bytes.length + 1); output.set(bytes);
    writeBytes(args[0], output, at, context);
    return returnPointer(args[0], resultType);
  }
  if (name === 'fread') {
    argCount(args, 4, 4, name, context, at);
    const size = checkedSize(args[1], name, context, at), count = checkedSize(args[2], name, context, at);
    if (!size || !count) return returnInteger(0, resultType, context);
    if (count > Math.floor(Number.MAX_SAFE_INTEGER / size)) invalid(context, `${name} solicitó un tamaño no representable.`, at);
    const requested = size * count;
    const stream = requireStream(args[3]);
    const chunks: Uint8Array[] = [];
    let chunk: Uint8Array | undefined;
    let chunkLength = 0;
    let bytesRead = 0;
    while (bytesRead < requested) {
      if (!chunk) chunk = new Uint8Array(Math.min(STREAM_READ_CHUNK_BYTES, requested - bytesRead));
      const read = stream.readAvailableInto(chunk, chunkLength, chunk.length - chunkLength, at);
      if (read > 0) {
        chunkLength += read;
        bytesRead += read;
        if (chunkLength === chunk.length) {
          chunks.push(chunk);
          chunk = undefined;
          chunkLength = 0;
        }
        continue;
      }
      const next = stream.readByteResult(at);
      if (next.kind === 'pending') {
        yield INPUT_NEEDED;
        continue;
      }
      if (next.kind === 'eof') break;
      chunk[chunkLength++] = next.value;
      bytesRead++;
      if (chunkLength === chunk.length) {
        chunks.push(chunk);
        chunk = undefined;
        chunkLength = 0;
      }
    }
    if (bytesRead) {
      context.preflightMemoryWrite(args[0], bytesRead, at);
      context.chargeWork(bytesRead, at);
      let offset = 0;
      for (const bytes of chunks) {
        context.writeBytes(context.offsetPointer(args[0], offset, at), bytes, at);
        offset += bytes.length;
      }
      if (chunkLength && chunk) context.writeBytes(context.offsetPointer(args[0], offset, at), chunk.subarray(0, chunkLength), at);
    }
    return returnInteger(Math.floor(bytesRead / size), resultType, context);
  }
  return context.fail('ENGINE_INTERNAL_ERROR', `No se reconoce la lectura de stream «${name}».`, at);
}

function streamBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  const requireStream = (file: CValue): VirtualStream => {
    const stream = context.streamFor(file, at);
    if (!stream) { context.errno.set(ERRNO.EBADF); invalid(context, `${name} requiere un flujo FILE válido.`, at); }
    return stream;
  };
  const eof = (): CValue => returnInteger(EOF_VALUE, resultType, context);
  if (name === 'fclose') {
    argCount(args, 1, 1, name, context, at);
    return returnInteger(context.closeFilePointer(args[0], at), resultType, context);
  }
  if (name === 'fflush') {
    argCount(args, 0, 1, name, context, at);
    if (!args.length || args[0].value === null) return returnInteger(0, resultType, context);
    const stream = context.streamFor(args[0], at);
    if (!stream || stream.isClosed) { context.errno.set(ERRNO.EBADF); return eofMinusOne(resultType, context); }
    return returnInteger(0, resultType, context);
  }
  if (name === 'fputc' || name === 'putc' || name === 'putchar') {
    argCount(args, name === 'putchar' ? 1 : 2, name === 'putchar' ? 1 : 2, name, context, at);
    const value = Number(BigInt.asUintN(8, integerValue(args[0], at, context)));
    const stream = name === 'putchar' ? context.io.stdout : requireStream(args[1]);
    const written = stream.writeBytes(new Uint8Array([value]), at);
    return written === 1 ? returnInteger(value, resultType, context) : eof();
  }
  if (name === 'fputs' || name === 'puts') {
    argCount(args, 1 + (name === 'fputs' ? 1 : 0), 1 + (name === 'fputs' ? 1 : 0), name, context, at);
    const bytes = cString(args[0], at, context);
    const stream = name === 'puts' ? context.io.stdout : requireStream(args[1]);
    const needsNewline = name === 'puts';
    const output = needsNewline ? new Uint8Array(bytes.length + 1) : bytes;
    if (needsNewline) { output.set(bytes); output[bytes.length] = 10; }
    context.preflightOutputBytes(output.length, at);
    const written = stream.writeBytes(output, at);
    if (written !== output.length) { context.errno.set(ERRNO.EIO); return eofMinusOne(resultType, context); }
    return returnInteger(name === 'puts' ? bytes.length + 1 : 0, resultType, context);
  }
  if (name === 'fwrite') {
    argCount(args, 4, 4, name, context, at);
    const size = checkedSize(args[1], name, context, at), count = checkedSize(args[2], name, context, at);
    if (!size || !count) return returnInteger(0, resultType, context);
    if (count > Math.floor(Number.MAX_SAFE_INTEGER / size)) invalid(context, `${name} solicitó un tamaño no representable.`, at);
    const requested = size * count;
    const stream = requireStream(args[3]);
    context.preflightOutputBytes(requested, at);
    context.chargeWork(requested, at);
    const bytes = context.readBytes(args[0], requested, at);
    const written = stream.writeBytes(bytes, at);
    return returnInteger(Math.floor(written / size), resultType, context);
  }
  if (name === 'fseek') {
    argCount(args, 3, 3, name, context, at);
    const stream = requireStream(args[0]);
    const offset = integerValue(args[1], at, context);
    const originValue = Number(integerValue(args[2], at, context));
    if (originValue < 0 || originValue > 2 || !stream.seek(offset, originValue as 0 | 1 | 2, at)) {
      context.errno.set(ERRNO.EINVAL); return eofMinusOne(resultType, context);
    }
    return returnInteger(0, resultType, context);
  }
  if (name === 'ftell') {
    argCount(args, 1, 1, name, context, at);
    const stream = requireStream(args[0]);
    const position = stream.tell();
    if (position < 0) { context.errno.set(ERRNO.EIO); return returnInteger(-1, resultType, context); }
    return returnInteger(position, resultType, context);
  }
  if (name === 'rewind') {
    argCount(args, 1, 1, name, context, at);
    const stream = requireStream(args[0]);
    if (!stream.seek(0, 0, at)) context.errno.set(ERRNO.EIO);
    else stream.clearError();
    return returnVoid();
  }
  if (name === 'ungetc') {
    argCount(args, 2, 2, name, context, at);
    const byte = Number(integerValue(args[0], at, context));
    if (byte === EOF_VALUE) return eof();
    const stream = requireStream(args[1]);
    return stream.ungetByte(Number(BigInt.asUintN(8, BigInt(byte))), at) ? returnInteger(Number(BigInt.asUintN(8, BigInt(byte))), resultType, context) : eof();
  }
  if (name === 'feof' || name === 'ferror') {
    argCount(args, 1, 1, name, context, at);
    const stream = requireStream(args[0]);
    return returnInteger(name === 'feof' ? stream.eof ? 1 : 0 : stream.error ? 1 : 0, resultType, context);
  }
  if (name === 'clearerr') {
    argCount(args, 1, 1, name, context, at);
    requireStream(args[0]).clearError();
    return returnVoid();
  }
  if (name === 'perror') {
    argCount(args, 1, 1, name, context, at);
    const prefix = cString(args[0], at, context);
    const code = context.errno.get();
    const message = code === 0 ? 'Success' : code === ERRNO.ENOENT ? 'No such file or directory' : code === ERRNO.EBADF ? 'Bad file descriptor' : code === ERRNO.EINVAL ? 'Invalid argument' : code === ERRNO.ERANGE ? 'Result out of range' : code === ERRNO.EIO ? 'Input/output error' : 'Unknown error';
    const text = new TextEncoder().encode(`${prefix.length ? `${decodeUtf8(prefix)}: ` : ''}${message}\n`);
    context.preflightOutputBytes(text.length, at);
    context.io.stderr.writeBytes(text, at);
    return returnVoid();
  }
  return undefined as never;
}

function eofMinusOne(resultType: CType | undefined, context: LibraryRuntimeContext): CValue { return returnInteger(-1, resultType, context); }

interface ScanInput {
  peek(): VirtualByteRead;
  take(): VirtualByteRead;
  readonly consumed: number;
  finish(): void;
  markError(): void;
}

function makeScanInput(stream: VirtualStream | undefined, source: Uint8Array | undefined, at: Location): ScanInput {
  let index = 0, consumed = 0, pending: VirtualByteRead | undefined;
  return {
    get consumed() { return consumed; },
    peek() {
      if (pending !== undefined) return pending;
      if (stream) {
        const result = stream.readByteResult(at);
        if (result.kind === 'pending') return result;
        pending = result;
      } else if (source && index < source.length) pending = { kind: 'byte', value: source[index++] };
      else pending = { kind: 'eof' };
      return pending;
    },
    take() {
      const result = this.peek();
      if (result.kind === 'byte') {
        pending = undefined;
        consumed++;
      } else if (result.kind === 'eof') pending = undefined;
      return result;
    },
    finish() {
      if (stream && pending?.kind === 'byte') stream.ungetByte(pending.value, at);
      pending = undefined;
    },
    markError() { stream?.markError(); },
  };
}

function* scanPeek(input: ScanInput): Generator<typeof INPUT_NEEDED, number, void> {
  while (true) {
    const result = input.peek();
    if (result.kind === 'pending') {
      yield INPUT_NEEDED;
      continue;
    }
    return result.kind === 'byte' ? result.value : EOF_VALUE;
  }
}

function* scanTake(input: ScanInput): Generator<typeof INPUT_NEEDED, number, void> {
  const value = yield* scanPeek(input);
  if (value < 0) {
    input.take();
    return EOF_VALUE;
  }
  const result = input.take();
  return result.kind === 'byte' ? result.value : EOF_VALUE;
}

function* scanfBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): ResumableLibraryBuiltin {
  let formatIndex = 0;
  let input: ScanInput;
  if (name === 'fscanf') {
    argCount(args, 2, Number.MAX_SAFE_INTEGER, name, context, at);
    const stream = context.streamFor(args[0], at);
    if (!stream) { context.errno.set(ERRNO.EBADF); return eofMinusOne(resultType, context); }
    input = makeScanInput(stream, undefined, at);
    formatIndex = 1;
  } else if (name === 'sscanf') {
    argCount(args, 2, Number.MAX_SAFE_INTEGER, name, context, at);
    input = makeScanInput(undefined, cString(args[0], at, context), at);
    formatIndex = 1;
  } else {
    argCount(args, 1, Number.MAX_SAFE_INTEGER, name, context, at);
    input = makeScanInput(context.io.stdin, undefined, at);
  }
  const format = decodeUtf8(cString(args[formatIndex], at, context));
  let argumentIndex = formatIndex + 1;
  let assigned = 0;
  let inputFailure = false;
  const takeDestination = (): CValue => {
    const pointer = args[argumentIndex++];
    if (!pointer) invalid(context, 'La cadena de formato scanf requiere más punteros destino.', at);
    return pointerValue(pointer, at, context);
  };
  const skipSpace = function* (): Generator<typeof INPUT_NEEDED, void, void> {
    while (asciiWhitespace.has(yield* scanPeek(input))) { yield* scanTake(input); context.chargeWork(1, at); }
  };
  const mismatch = (eof: boolean): void => { inputFailure = eof; };

  for (let index = 0; index < format.length;) {
    const formatByte = format.charCodeAt(index);
    if (asciiWhitespace.has(formatByte)) {
      while (index < format.length && asciiWhitespace.has(format.charCodeAt(index))) index++;
      yield* skipSpace();
      continue;
    }
    if (format[index] !== '%') {
      const byte = yield* scanPeek(input);
      if (byte < 0) { mismatch(true); break; }
      if (byte !== formatByte) { mismatch(false); break; }
      yield* scanTake(input); context.chargeWork(1, at); index++; continue;
    }
    index++;
    if (format[index] === '%') {
      const byte = yield* scanPeek(input);
      if (byte !== 37) { mismatch(byte < 0); break; }
      yield* scanTake(input); context.chargeWork(1, at); index++; continue;
    }
    let suppress = false;
    if (format[index] === '*') { suppress = true; index++; }
    let widthText = '';
    while (index < format.length && /[0-9]/.test(format[index])) widthText += format[index++];
    const width = widthText ? safeFormatNumber(widthText, context, at) : Number.MAX_SAFE_INTEGER;
    let length = '';
    for (const candidate of ['hh', 'll', 'h', 'l', 'j', 'z', 't', 'L']) if (format.startsWith(candidate, index)) { length = candidate; index += candidate.length; break; }
    let specifier = format[index++];
    let scanset: Set<number> | undefined;
    let scansetInvert = false;
    if (specifier === '[') {
      if (format[index] === '^') { scansetInvert = true; index++; }
      scanset = new Set();
      if (format[index] === ']') scanset.add(93), index++;
      let closed = false;
      while (index < format.length) {
        if (format[index] === ']') { index++; closed = true; break; }
        const first = format.charCodeAt(index++);
        if (format[index] === '-' && index + 1 < format.length && format[index + 1] !== ']') {
          index++;
          const last = format.charCodeAt(index++);
          for (let byte = Math.min(first, last); byte <= Math.max(first, last); byte++) scanset.add(byte);
        } else scanset.add(first);
      }
      if (!closed) invalid(context, 'La lista de conversión %[ no tiene cierre ].', at);
    }
    if (!specifier) invalid(context, 'La cadena de formato scanf termina dentro de una conversión.', at);
    if (specifier === 'n') {
      if (!suppress) context.writeScalar(takeDestination(), context.makeInt(input.consumed, scanIntegerType('d', length)), at);
      continue;
    }
    const isCharacter = specifier === 'c';
    const isString = specifier === 's' || specifier === '[';
    if (length === 'l' && specifier === '[') {
      return context.fail('UNSUPPORTED_FEATURE', 'La conversión wide scanf «%l[» aún no está implementada.', at);
    }
    // C's scanf skips leading whitespace for %s and numeric conversions, but
    // not for %c or %[]. This also lets a later %s cross a pending line break.
    if (!isCharacter && specifier !== '[') yield* skipSpace();
    const bytes: number[] = [];
    if (isCharacter) {
      const wanted = widthText ? width : 1;
      if (length === 'l') {
        const scalars: number[] = [];
        let encodingError = false;
        while (scalars.length < wanted) {
          const byte = yield* scanPeek(input);
          if (byte < 0) break;
          if (byte > 0x7f) {
            yield* scanTake(input);
            context.errno.set(ERRNO.EILSEQ);
            input.markError();
            encodingError = true;
            break;
          }
          scalars.push(yield* scanTake(input)); context.chargeWork(1, at);
        }
        if (encodingError) break;
        if (scalars.length < wanted) { mismatch(true); break; }
        if (!suppress) {
          writeBytes(takeDestination(), encodeWideScalars(scalars), at, context);
          assigned++;
        }
        continue;
      }
      while (bytes.length < wanted) {
        const byte = yield* scanPeek(input);
        if (byte < 0) break;
        bytes.push(yield* scanTake(input)); context.chargeWork(1, at);
      }
      if (bytes.length < wanted) { mismatch(true); break; }
      if (!suppress) {
        const output = Uint8Array.from(bytes);
        writeBytes(takeDestination(), output, at, context);
        assigned++;
      }
      continue;
    }
    if (isString) {
      if (length === 'l') {
        const scalars: number[] = [];
        let encodingError = false;
        while (scalars.length < width) {
          const byte = yield* scanPeek(input);
          if (byte < 0 || asciiWhitespace.has(byte)) break;
          if (byte > 0x7f) {
            yield* scanTake(input);
            context.errno.set(ERRNO.EILSEQ);
            input.markError();
            encodingError = true;
            break;
          }
          scalars.push(yield* scanTake(input)); context.chargeWork(1, at);
        }
        if (encodingError) break;
        if (!scalars.length) { mismatch((yield* scanPeek(input)) < 0); break; }
        if (!suppress) {
          scalars.push(0);
          writeBytes(takeDestination(), encodeWideScalars(scalars), at, context);
          assigned++;
        }
        continue;
      }
      while (bytes.length < width) {
        const byte = yield* scanPeek(input);
        if (byte < 0 || (specifier === 's' ? asciiWhitespace.has(byte) : scansetInvert ? scanset!.has(byte) : !scanset!.has(byte))) break;
        bytes.push(yield* scanTake(input)); context.chargeWork(1, at);
      }
      if (!bytes.length) { mismatch((yield* scanPeek(input)) < 0); break; }
      if (!suppress) {
        const output = new Uint8Array(bytes.length + 1); output.set(bytes);
        writeBytes(takeDestination(), output, at, context);
        assigned++;
      }
      continue;
    }
    const integerConversion = 'diuoxX'.includes(specifier);
    const floatConversion = 'fFeEgGaA'.includes(specifier);
    if (!integerConversion && !floatConversion && specifier !== 'p') invalid(context, `La conversión scanf «%${length}${specifier}» no está implementada.`, at);
    if (floatConversion && !['', 'l', 'L'].includes(length)) invalid(context, `El modificador «${length}» no es válido para scanf «%${specifier}».`, at);
    if (integerConversion && length === 'L') invalid(context, `El modificador «L» no es válido para scanf «%${specifier}».`, at);
    const accepted = specifier === 'p' ? /[0-9a-fA-FxX()nil]/ : null;
    let floatToken = '';
    let integerToken = '';
    while (bytes.length < width) {
      const byte = yield* scanPeek(input);
      if (byte < 0) break;
      const character = String.fromCharCode(byte);
      if (floatConversion) {
        const candidate = floatToken + character;
        if (!isScannedFloatPrefix(candidate)) break;
        floatToken = candidate;
      } else if (integerConversion) {
        const candidate = integerToken + character;
        if (!isScannedIntegerPrefix(candidate, specifier)) break;
        integerToken = candidate;
      } else if (!accepted?.test(character)) break;
      bytes.push(yield* scanTake(input)); context.chargeWork(1, at);
    }
    const token = scanTokenToString(bytes);
    if (specifier === 'p') {
      if (!bytes.length) { mismatch((yield* scanPeek(input)) < 0); break; }
      if (!context.parsePointer) {
        return context.fail('UNSUPPORTED_FEATURE', 'La conversión scanf «%p» requiere el lector de punteros de la máquina virtual.', at);
      }
      const pointer = context.parsePointer(token, at);
      if (!suppress) {
        context.writeScalar(takeDestination(), pointer, at);
        assigned++;
      }
      continue;
    }
    let parsed: bigint | number | Binary80Value | undefined;
    if (integerConversion) parsed = parseScannedInteger(token, specifier);
    else if (length === 'L') parsed = parseScannedBinary80(token);
    else parsed = parseScannedFloat(token);
    if (parsed === undefined) { mismatch(bytes.length === 0 && (yield* scanPeek(input)) < 0); break; }
    if (!suppress) {
      const destination = takeDestination();
      const value: CValue = typeof parsed === 'bigint'
        ? context.makeInt(parsed, scanIntegerType(specifier, length))
        : typeof parsed === 'number'
          ? { type: length === 'l' ? 'double' : 'float', value: parsed }
          : { type: 'long double', value: parsed as unknown as CValue['value'] };
      context.writeScalar(destination, value, at);
      assigned++;
    }
  }
  input.finish();
  if (!assigned && inputFailure) return eofMinusOne(resultType, context);
  return returnInteger(assigned, resultType, context);
}

function parseScannedBinary80(text: string): Binary80Value | undefined {
  try { return parseBinary80(text); }
  catch { return undefined; }
}

function encodeWideScalars(scalars: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(scalars.length * 4);
  const view = new DataView(bytes.buffer);
  scalars.forEach((scalar, index) => view.setUint32(index * 4, scalar, true));
  return bytes;
}

function scanIntegerType(specifier: string, length: string): CType {
  const signed = specifier === 'd' || specifier === 'i' || specifier === 'n';
  if (length === 'hh') return signed ? 'signed char' : 'unsigned char';
  if (length === 'h') return signed ? 'short' : 'unsigned short';
  if (length === 'll') return signed ? 'long long' : 'unsigned long long';
  if (['l', 'j', 't'].includes(length)) return signed ? 'long' : 'unsigned long';
  if (length === 'z') return signed ? 'long' : 'unsigned long';
  return signed ? 'int' : 'unsigned int';
}

function scanTokenToString(bytes: readonly number[]): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.slice(offset, offset + 8192));
  }
  return result;
}

function parseScannedInteger(text: string, specifier: string): bigint | undefined {
  if (!text) return undefined;
  const signless = text.replace(/^[+-]/, '');
  if (!signless) return undefined;
  let base = specifier === 'o' ? 8 : specifier === 'x' || specifier === 'X' ? 16 : specifier === 'i' ? 0 : 10;
  let digits = signless;
  if (base === 0) base = digits.startsWith('0x') || digits.startsWith('0X') ? 16 : digits.startsWith('0') ? 8 : 10;
  if (base === 16 && /^0[xX]/.test(digits)) digits = digits.slice(2);
  if (!digits || [...digits].some((char) => digitForBase(char.charCodeAt(0), base) < 0)) return undefined;
  let value = 0n;
  for (const char of digits) value = value * BigInt(base) + BigInt(digitForBase(char.charCodeAt(0), base));
  return text.startsWith('-') ? -value : value;
}

function isScannedIntegerPrefix(text: string, specifier: string): boolean {
  const body = text.replace(/^[+-]/, '');
  if (!body) return true;
  if (specifier === 'd' || specifier === 'u') return /^\d+$/.test(body);
  if (specifier === 'o') return /^[0-7]+$/.test(body);
  if (specifier === 'x' || specifier === 'X') {
    return /^0[xX]$/i.test(body) || /^(?:0[xX])?[0-9a-f]+$/i.test(body);
  }
  if (specifier === 'i') {
    return /^0[xX]$/i.test(body) || /^0[xX][0-9a-f]+$/i.test(body) || /^0[0-7]*$/.test(body) || /^[1-9]\d*$/.test(body);
  }
  return false;
}

function parseScannedFloat(text: string): number | undefined {
  if (/^[+-]?inf(?:inity)?$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan(?:\([a-z0-9_]*\))?$/i.test(text)) return text.startsWith('-') ? -NaN : NaN;
  const decimal = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?)$/i;
  if (decimal.test(text)) return Number(text);
  const hexadecimal = /^([+-]?)0x((?:[0-9a-f]+(?:\.[0-9a-f]*)?|\.[0-9a-f]+))[pP]([+-]?\d+)$/i.exec(text);
  if (!hexadecimal) return undefined;
  const sign = hexadecimal[1] === '-' ? -1 : 1;
  const explicitExponent = Number(hexadecimal[3]);
  if (!Number.isFinite(explicitExponent)) return sign < 0 ? -Infinity : Infinity;
  const [whole = '', fractional = ''] = hexadecimal[2].split('.');
  const significant = BigInt(`0x${whole}${fractional}` || '0x0');
  if (significant === 0n) return sign < 0 ? -0 : 0;
  const bitLength = significant.toString(2).length;
  const shift = Math.max(0, bitLength - 53);
  let leading = significant >> BigInt(shift);
  if (shift > 0) {
    const remainder = significant - (leading << BigInt(shift));
    const halfway = 1n << BigInt(shift - 1);
    if (remainder > halfway || remainder === halfway && (leading & 1n) === 1n) leading++;
  }
  const power = explicitExponent - 4 * fractional.length + shift;
  const magnitude = power > 1023 ? Infinity : power < -1075 ? 0 : Number(leading) * 2 ** power;
  return sign < 0 ? -magnitude : magnitude;
}

function isScannedFloatPrefix(text: string): boolean {
  const body = text.replace(/^[+-]/, '');
  if (!body) return true;
  const lower = body.toLowerCase();
  if ('infinity'.startsWith(lower) || lower === 'inf' || 'nan'.startsWith(lower)) return true;
  if (/^nan\([a-z0-9_]*\)?$/i.test(body)) return true;

  // Keep only prefixes that can still become a decimal or hexadecimal float.
  // This leaves punctuation after a complete token for the next conversion.
  if (/^(?:\d+(?:\.\d*)?(?:[eE][+-]?\d*)?|\.\d+(?:[eE][+-]?\d*)?|\.)$/.test(body)) return true;
  if (/^0[xX]$/i.test(body) || /^0[xX](?:[0-9a-f]+(?:\.[0-9a-f]*)?|\.[0-9a-f]+)(?:[pP][+-]?\d*)?$/i.test(body) ||
      /^0[xX][0-9a-f]*\.$/i.test(body)) return true;
  return false;
}
