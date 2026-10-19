import type { AggregateValue, CType, CValue, Location } from './internal.ts';
import type { VirtualIO } from './virtual-io.ts';
import type { LibraryRuntimeContext } from './library.ts';
import {
  argCount, asciiWhitespace, checkedSize, compareBytes, compareCStringPointers,
  cString, cStringByte, errorMessage, integerValue, invalid, makePointerAt,
  returnInteger, returnPointer, writeBytes,
} from './library-common.ts';

function inSet(byte: number, set: ReadonlySet<number>): boolean { return set.has(byte); }
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
  let start = 0;
  let byte = cStringByte(source, start, at, context);
  context.chargeWork(1, at);
  while (byte !== 0 && delimiters.has(byte)) {
    byte = cStringByte(source, ++start, at, context);
    context.chargeWork(1, at);
  }
  if (byte === 0) { strtokState.delete(context.io); return { type: resultType ?? args[0].type, value: null }; }
  let end = start;
  while (byte !== 0 && !delimiters.has(byte)) {
    byte = cStringByte(source, ++end, at, context);
    context.chargeWork(1, at);
  }
  const token = context.offsetPointer(source, start, at);
  if (byte !== 0) {
    context.writeBytes(context.offsetPointer(source, end, at), new Uint8Array([0]), at);
    strtokState.set(context.io, context.offsetPointer(source, end + 1, at));
  } else strtokState.delete(context.io);
  return returnPointer(token, resultType);
}

const strtokState = new WeakMap<VirtualIO, CValue>();

export function dispatchMemoryBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext): CValue | undefined {
  const at = context.at;
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
  if (name === 'memchr') {
    argCount(args, 3, 3, name, context, at);
    const count = integerValue(args[2], at, context);
    if (count < 0n) invalid(context, `${name} received a size outside the safe range.`, at);
    if (count === 0n) return { type: resultType ?? args[0].type, value: null };
    const needle = Number(BigInt.asUintN(8, integerValue(args[1], at, context)));
    for (let index = 0n; index < count; index++) {
      const offset = Number(index);
      const byte = context.readBytes(context.offsetPointer(args[0], offset, at), 1, at)[0] ?? 0;
      context.chargeWork(1, at);
      if (byte === needle) return makePointerAt(args[0], offset, resultType, at, context);
    }
    return { type: resultType ?? args[0].type, value: null };
  }
  if (name === 'strcpy' || name === 'strcat' || name === 'strncpy' || name === 'strncat') {
    argCount(args, name.endsWith('ncpy') || name === 'strncat' ? 3 : 2, name.endsWith('ncpy') || name === 'strncat' ? 3 : 2, name, context, at);
    const bounded = name === 'strncpy' || name === 'strncat';
    const count = bounded ? checkedSize(args[2], name, context, at) : undefined;
    const source = cString(args[1], at, context, count);
    const copyCount = count ?? source.length;
    context.chargeWork(Math.min(copyCount, source.length) + 1, at);
    if (name === 'strcpy') {
      const output = new Uint8Array(source.length + 1); output.set(source);
      writeBytes(args[0], output, at, context);
    } else if (name === 'strncpy') {
      context.preflightMemoryWrite(args[0], copyCount, at);
      const output = new Uint8Array(copyCount);
      output.set(source.subarray(0, copyCount));
      context.writeBytes(args[0], output, at);
    } else {
      const destination = cString(args[0], at, context);
      const append = name === 'strcat' ? source : source.subarray(0, copyCount);
      const padded = name === 'strncat' ? append.subarray(0, append.findIndex((byte) => byte === 0) < 0 ? append.length : append.findIndex((byte) => byte === 0)) : append;
      const output = new Uint8Array(padded.length + 1); output.set(padded);
      writeBytes(context.offsetPointer(args[0], destination.length, at), output, at, context);
    }
    return returnPointer(args[0], resultType);
  }
  if (name === 'strcmp' || name === 'strncmp') {
    argCount(args, name === 'strcmp' ? 2 : 3, name === 'strcmp' ? 2 : 3, name, context, at);
    const count = name === 'strncmp' ? checkedSize(args[2], name, context, at) : undefined;
    const compared = compareCStringPointers(args[0], args[1], count, context, at);
    context.chargeWork(compared.work, at);
    return returnInteger(compared.result, resultType, context);
  }
  if (name === 'strchr' || name === 'strrchr') {
    argCount(args, 2, 2, name, context, at);
    const needle = Number(BigInt.asUintN(8, integerValue(args[1], at, context)));
    if (name === 'strchr') {
      for (let index = 0; ; index++) {
        const byte = context.readBytes(context.offsetPointer(args[0], index, at), 1, at)[0] ?? 0;
        context.chargeWork(1, at);
        if (byte === needle) return makePointerAt(args[0], index, resultType, at, context);
        if (byte === 0) return { type: resultType ?? args[0].type, value: null };
      }
    }
    const source = cString(args[0], at, context);
    context.chargeWork(source.length + 1, at);
    let found = -1;
    for (let index = 0; index <= source.length; index++) if ((source[index] ?? 0) === needle) {
      found = index;
    }
    return found < 0 ? { type: resultType ?? args[0].type, value: null } : makePointerAt(args[0], found, resultType, at, context);
  }
  if (name === 'strspn' || name === 'strcspn') {
    argCount(args, 2, 2, name, context, at);
    const set = new Set(cString(args[1], at, context));
    let index = 0;
    let byte = cStringByte(args[0], index, at, context);
    while (byte !== 0 && (name === 'strspn' ? set.has(byte) : !set.has(byte))) {
      context.chargeWork(1, at);
      byte = cStringByte(args[0], ++index, at, context);
    }
    context.chargeWork(1, at);
    return returnInteger(index, resultType, context);
  }
  if (name === 'strpbrk') {
    argCount(args, 2, 2, name, context, at);
    const set = new Set(cString(args[1], at, context));
    let index = 0;
    let byte = cStringByte(args[0], index, at, context);
    while (byte !== 0 && !set.has(byte)) {
      context.chargeWork(1, at);
      byte = cStringByte(args[0], ++index, at, context);
    }
    context.chargeWork(1, at);
    return byte === 0 ? { type: resultType ?? args[0].type, value: null } : makePointerAt(args[0], index, resultType, at, context);
  }
  if (name === 'strstr') {
    argCount(args, 2, 2, name, context, at);
    const needle = cString(args[1], at, context);
    if (!needle.length) return makePointerAt(args[0], 0, resultType, at, context);
    for (let start = 0; ; start++) {
      let matched = true;
      for (let part = 0; part < needle.length; part++) {
        const byte = cStringByte(args[0], start + part, at, context);
        context.chargeWork(1, at);
        if (byte === 0) return { type: resultType ?? args[0].type, value: null };
        if (byte !== needle[part]) { matched = false; break; }
      }
      if (matched) return makePointerAt(args[0], start, resultType, at, context);
    }
  }
  if (name === 'strtok') return strtokBuiltin(args, resultType, context, at);
  if (name === 'strerror') {
    argCount(args, 1, 1, name, context, at);
    const code = Number(integerValue(args[0], at, context));
    const message = errorMessage(code);
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
    if (denominator === 0n) return context.fail('DIVISION_BY_ZERO', 'imaxdiv cannot divide by zero.', at);
    if (numerator === -(1n << 63n) && denominator === -1n) {
      return context.fail('SIGNED_OVERFLOW', 'imaxdiv quotient exceeds intmax_t.', at);
    }
    if (!resultType || typeof resultType !== 'object' || resultType.kind !== 'aggregate') {
      return context.fail('ENGINE_INTERNAL_ERROR', 'imaxdiv requires its aggregate return type.', at);
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
  return undefined;
}
