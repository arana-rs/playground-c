import type { CValue, CType, Location, ObjectPointerValue } from './internal.ts';
import { pointerTo } from './type-system.ts';
import type { LibraryBuiltinGenerator } from './library-requests.ts';
import type { StdlibTimeRuntimeContext } from './stdlib-time-context.ts';
import { NANOSECONDS_PER_SECOND, virtualCalendarTime, virtualClockTicks } from './stdlib-time-context.ts';
import { canStoreTm, splitTimestamp, timestampFromTm } from './time-library-calendar.ts';
import type { BrokenDownTime } from './time-library-calendar.ts';
import { asctimeText, formatTm } from './time-library-format.ts';

const LONG_MIN = -(1n << 63n);
const LONG_MAX = (1n << 63n) - 1n;

function buffers(context: StdlibTimeRuntimeContext): NonNullable<StdlibTimeRuntimeContext['stdlibState']> {
  if (!context.stdlibState) return context.fail('ENGINE_INTERNAL_ERROR', 'Per-execution stdlib/time state is missing.', context.at);
  return context.stdlibState;
}

function count(args: readonly CValue[], expected: number, name: string, context: StdlibTimeRuntimeContext, at: Location): void {
  if (args.length !== expected) context.fail('LIBRARY_ARGUMENT', `${name} received an invalid number of arguments.`, at);
}

function integer(value: CValue, context: StdlibTimeRuntimeContext, at: Location): bigint {
  if (typeof value.value !== 'bigint') return context.fail('LIBRARY_ARGUMENT', 'Expected an integer argument.', at);
  return value.value;
}

function intValue(value: bigint | number, context: StdlibTimeRuntimeContext): CValue {
  return context.makeInt(value, 'int');
}

function timeValue(value: bigint | number, resultType: CType | undefined, context: StdlibTimeRuntimeContext): CValue {
  return context.makeInt(value, resultType ?? 'long');
}

function pointer(value: CValue, name: string, context: StdlibTimeRuntimeContext, at: Location, allowNull = false): ObjectPointerValue | null {
  if (value.value === null && allowNull) return null;
  if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') {
    return context.fail('LIBRARY_ARGUMENT', `${name} requires an object pointer.`, at);
  }
  return value.value;
}

function typedPointer(base: ObjectPointerValue, type: CType): CValue {
  return { type: pointerTo(type), value: base };
}

function offsetPointer(base: ObjectPointerValue, byteOffset: number, type: CType, context: StdlibTimeRuntimeContext, at: Location): CValue {
  return context.offsetPointer(typedPointer(base, type), byteOffset, at);
}

function readField(base: ObjectPointerValue, byteOffset: number, type: 'int' | 'long', context: StdlibTimeRuntimeContext, at: Location): bigint {
  const bytes = context.readBytes(offsetPointer(base, byteOffset, type, context, at), type === 'int' ? 4 : 8, at);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return type === 'int' ? BigInt(view.getInt32(0, true)) : view.getBigInt64(0, true);
}

function writeField(base: ObjectPointerValue, byteOffset: number, value: bigint, type: 'int' | 'long', context: StdlibTimeRuntimeContext, at: Location): void {
  context.writeScalar(offsetPointer(base, byteOffset, type, context, at), context.makeInt(value, type), at);
}

function readTm(pointerValue: CValue, context: StdlibTimeRuntimeContext, at: Location): BrokenDownTime {
  const base = pointer(pointerValue, 'struct tm', context, at);
  const values = Array.from({ length: 9 }, (_, index) => readField(base!, index * 4, 'int', context, at));
  return {
    second: values[0], minute: values[1], hour: values[2], day: values[3], month: values[4],
    year: values[5], weekday: values[6], yearDay: values[7], isDst: values[8],
  };
}

function writeTm(base: ObjectPointerValue, parts: BrokenDownTime, context: StdlibTimeRuntimeContext, at: Location): void {
  const values = [parts.second, parts.minute, parts.hour, parts.day, parts.month, parts.year, parts.weekday, parts.yearDay, parts.isDst];
  for (let index = 0; index < values.length; index++) writeField(base, index * 4, BigInt.asIntN(32, values[index]), 'int', context, at);
}

function tmStorage(context: StdlibTimeRuntimeContext, at: Location, type: CType | undefined): CValue {
  const state = buffers(context);
  if (!state.tmBuffer) {
    if (!type || !context.allocateStaticObject) return context.fail('ENGINE_INTERNAL_ERROR', 'Cannot create the static struct tm buffer.', at);
    state.tmBuffer = context.allocateStaticObject(type, at);
  }
  return state.tmBuffer;
}

function textStorage(context: StdlibTimeRuntimeContext, at: Location, minimumBytes: number): CValue {
  const state = buffers(context);
  if (!state.textBuffer || state.textBufferCapacity < minimumBytes) {
    state.textBuffer = context.makeString(new Uint8Array(minimumBytes), at);
    state.textBufferCapacity = minimumBytes;
  }
  return state.textBuffer;
}

function storeText(text: string, context: StdlibTimeRuntimeContext, at: Location): CValue {
  const bytes = new TextEncoder().encode(text);
  const storage = textStorage(context, at, bytes.length);
  context.preflightMemoryWrite(storage, bytes.length + 1, at);
  context.writeBytes(storage, Uint8Array.from([...bytes, 0]), at);
  return storage;
}

function tmFromPointer(pointerValue: CValue, context: StdlibTimeRuntimeContext, at: Location): BrokenDownTime | null {
  const base = pointer(pointerValue, 'struct tm', context, at, true);
  return base === null ? null : readTm(pointerValue, context, at);
}

function parseTimeString(value: CValue, context: StdlibTimeRuntimeContext, at: Location): Uint8Array {
  if (value.value === null) return context.fail('LIBRARY_ARGUMENT', 'The time.h format string cannot be null.', at);
  return context.readCString(value, at);
}

function isSignedLong(value: bigint): boolean { return value >= LONG_MIN && value <= LONG_MAX; }

export function dispatchTimeBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, rawContext: StdlibTimeRuntimeContext): CValue | LibraryBuiltinGenerator | undefined {
  const context = rawContext;
  const at = context.at;
  if (name === 'clock') {
    count(args, 0, name, context, at);
    const ticks = virtualClockTicks(context);
    return timeValue(ticks < 0n || ticks > LONG_MAX ? -1n : ticks, resultType ?? 'long', context);
  }
  if (name === 'time') {
    count(args, 1, name, context, at);
    const timer = pointer(args[0], name, context, at, true);
    const now = virtualCalendarTime(context);
    if (!isSignedLong(now.seconds)) return timeValue(-1n, resultType ?? 'long', context);
    if (timer) context.writeScalar(typedPointer(timer, 'long'), context.makeInt(now.seconds, 'long'), at);
    return timeValue(now.seconds, resultType ?? 'long', context);
  }
  if (name === 'timespec_get') {
    count(args, 2, name, context, at);
    const base = integer(args[1], context, at);
    if (base !== 1n) return intValue(0, context);
    const ts = pointer(args[0], name, context, at);
    const now = virtualCalendarTime(context);
    if (!isSignedLong(now.seconds) || now.nanoseconds < 0n || now.nanoseconds >= NANOSECONDS_PER_SECOND) return intValue(0, context);
    writeField(ts!, 0, now.seconds, 'long', context, at);
    writeField(ts!, 8, now.nanoseconds, 'long', context, at);
    return intValue(1, context);
  }
  if (name === 'difftime') {
    count(args, 2, name, context, at);
    return { type: resultType ?? 'double', value: Number(integer(args[0], context, at) - integer(args[1], context, at)) };
  }
  if (name === 'gmtime' || name === 'localtime') {
    count(args, 1, name, context, at);
    const seconds = integerFromTimePointer(args[0], context, at);
    if (seconds === null) return { type: resultType ?? pointerTo('void'), value: null };
    const parts = splitTimestamp(seconds);
    if (!canStoreTm(parts)) return { type: resultType ?? pointerTo('void'), value: null };
    const tmType = typeof resultType === 'object' && resultType?.kind === 'pointer' ? resultType.base : undefined;
    const storage = tmStorage(context, at, tmType);
    const base = pointer(storage, 'internal tm buffer', context, at)!;
    writeTm(base, parts, context, at);
    return { type: resultType ?? pointerTo('void'), value: base };
  }
  if (name === 'mktime') {
    count(args, 1, name, context, at);
    const tm = readTm(args[0], context, at);
    const seconds = timestampFromTm(tm);
    if (!isSignedLong(seconds)) return timeValue(-1n, resultType ?? 'long', context);
    const normalized = splitTimestamp(seconds);
    if (!canStoreTm(normalized)) return timeValue(-1n, resultType ?? 'long', context);
    const base = pointer(args[0], name, context, at)!;
    writeTm(base, normalized, context, at);
    return timeValue(seconds, resultType ?? 'long', context);
  }
  if (name === 'asctime' || name === 'ctime') {
    count(args, 1, name, context, at);
    let tm: BrokenDownTime | null;
    if (name === 'ctime') {
      const seconds = integerFromTimePointer(args[0], context, at);
      tm = seconds === null ? null : splitTimestamp(seconds);
    } else tm = tmFromPointer(args[0], context, at);
    if (!tm) return { type: resultType ?? pointerTo('char'), value: null };
    const formatted = asctimeText(tm);
    return formatted === undefined
      ? { type: resultType ?? pointerTo('char'), value: null }
      : storeText(formatted, context, at);
  }
  if (name === 'strftime') {
    count(args, 4, name, context, at);
    const maximum = integer(args[1], context, at);
    if (maximum < 0n || maximum > BigInt(Number.MAX_SAFE_INTEGER)) return context.fail('LIBRARY_ARGUMENT', 'strftime received a size outside the safe range.', at);
    const destination = pointer(args[0], name, context, at, maximum === 0n);
    const format = parseTimeString(args[2], context, at);
    const tm = readTm(args[3], context, at);
    const formatted = formatTm(format, tm, context, at);
    const bytes = new TextEncoder().encode(formatted);
    if (BigInt(bytes.length + 1) > maximum) return intValue(0, context);
    if (bytes.length) {
      context.preflightMemoryWrite({ type: args[0].type, value: destination }, bytes.length + 1, at);
      context.writeBytes({ type: args[0].type, value: destination }, Uint8Array.from([...bytes, 0]), at);
    } else if (maximum > 0n) {
      context.writeBytes({ type: args[0].type, value: destination }, new Uint8Array([0]), at);
    }
    context.chargeWork(bytes.length, at);
    return context.makeInt(bytes.length, resultType ?? 'unsigned long');
  }
  return undefined;
}

function integerFromTimePointer(value: CValue, context: StdlibTimeRuntimeContext, at: Location): bigint | null {
  const base = pointer(value, 'time_t', context, at, true);
  if (base === null) return null;
  return readField(base, 0, 'long', context, at);
}
