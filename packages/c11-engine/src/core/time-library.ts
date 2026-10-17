import type { CValue, CType, Location, ObjectPointerValue } from './internal.ts';
import { pointerTo } from './type-system.ts';
import type { LibraryBuiltinGenerator } from './library-requests.ts';
import type { StdlibTimeRuntimeContext } from './stdlib-time-context.ts';
import { NANOSECONDS_PER_SECOND, virtualCalendarTime, virtualClockTicks } from './stdlib-time-context.ts';

const SECONDS_PER_DAY = 86_400n;
const LONG_MIN = -(1n << 63n);
const LONG_MAX = (1n << 63n) - 1n;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

interface BrokenDownTime {
  readonly second: bigint;
  readonly minute: bigint;
  readonly hour: bigint;
  readonly day: bigint;
  readonly month: bigint;
  readonly year: bigint;
  readonly weekday: bigint;
  readonly yearDay: bigint;
  readonly isDst: bigint;
}

function buffers(context: StdlibTimeRuntimeContext): NonNullable<StdlibTimeRuntimeContext['stdlibState']> {
  if (!context.stdlibState) return context.fail('ENGINE_INTERNAL_ERROR', 'Falta el estado por ejecución de stdlib/time.', context.at);
  return context.stdlibState;
}

function count(args: readonly CValue[], expected: number, name: string, context: StdlibTimeRuntimeContext, at: Location): void {
  if (args.length !== expected) context.fail('LIBRARY_ARGUMENT', `${name} recibió una cantidad de argumentos no válida.`, at);
}

function integer(value: CValue, context: StdlibTimeRuntimeContext, at: Location): bigint {
  if (typeof value.value !== 'bigint') return context.fail('LIBRARY_ARGUMENT', 'Se esperaba un argumento entero.', at);
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
    return context.fail('LIBRARY_ARGUMENT', `${name} requiere un puntero a objeto.`, at);
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

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function positiveMod(value: bigint, divisor: bigint): bigint {
  const result = value % divisor;
  return result < 0n ? result + divisor : result;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
function daysFromCivil(yearInput: bigint, month: bigint, day: bigint): bigint {
  const year = yearInput - (month <= 2n ? 1n : 0n);
  const era = floorDiv(year, 400n);
  const yearOfEra = year - era * 400n;
  const shiftedMonth = month + (month > 2n ? -3n : 9n);
  const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function civilFromDays(daysSinceEpoch: bigint): { year: bigint; month: bigint; day: bigint; yearDay: bigint } {
  const z = daysSinceEpoch + 719_468n;
  const era = floorDiv(z, 146_097n);
  const dayOfEra = z - era * 146_097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * monthPrime + 2n) / 5n + 1n;
  const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
  year += month <= 2n ? 1n : 0n;
  const yearDay = daysFromCivil(year, month, day) - daysFromCivil(year, 1n, 1n);
  return { year, month, day, yearDay };
}

function splitTimestamp(seconds: bigint): BrokenDownTime {
  const dayNumber = floorDiv(seconds, SECONDS_PER_DAY);
  const secondsOfDay = seconds - dayNumber * SECONDS_PER_DAY;
  const civil = civilFromDays(dayNumber);
  return {
    second: secondsOfDay % 60n,
    minute: secondsOfDay / 60n % 60n,
    hour: secondsOfDay / 3600n,
    day: civil.day,
    month: civil.month - 1n,
    year: civil.year - 1900n,
    weekday: positiveMod(dayNumber + 4n, 7n),
    yearDay: civil.yearDay,
    isDst: 0n,
  };
}

function timestampFromTm(tm: BrokenDownTime): bigint {
  const year = tm.year + 1900n;
  const monthOffset = tm.month;
  const normalizedYear = year + floorDiv(monthOffset, 12n);
  const normalizedMonth = positiveMod(monthOffset, 12n) + 1n;
  const dayNumber = daysFromCivil(normalizedYear, normalizedMonth, 1n) + tm.day - 1n;
  return dayNumber * SECONDS_PER_DAY + tm.hour * 3600n + tm.minute * 60n + tm.second;
}

function canStoreTm(parts: BrokenDownTime): boolean {
  return parts.year >= -2_147_483_648n && parts.year <= 2_147_483_647n &&
    parts.month >= -2_147_483_648n && parts.month <= 2_147_483_647n;
}

function tmStorage(context: StdlibTimeRuntimeContext, at: Location, type: CType | undefined): CValue {
  const state = buffers(context);
  if (!state.tmBuffer) {
    if (!type || !context.allocateStaticObject) return context.fail('ENGINE_INTERNAL_ERROR', 'No se puede crear el buffer static struct tm.', at);
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

function formattedNumber(value: bigint, width: number, fill = '0'): string {
  const raw = value.toString();
  if (raw.startsWith('-')) return `-${raw.slice(1).padStart(Math.max(0, width - 1), fill)}`;
  return raw.padStart(width, fill);
}

function yearText(year: bigint): string {
  return year < 0n ? `-${(-year).toString().padStart(4, '0')}` : year.toString().padStart(4, '0');
}

function validTmIndex(value: bigint, minimum: bigint, maximum: bigint): number | null {
  return value < minimum || value > maximum ? null : Number(value);
}

function mondayIndex(weekday: bigint): bigint { return positiveMod(weekday + 6n, 7n); }

function isoWeek(parts: BrokenDownTime): { year: bigint; week: bigint } {
  const calendarYear = parts.year + 1900n;
  const dayNumber = daysFromCivil(calendarYear, parts.month + 1n, parts.day);
  const thursday = dayNumber + (3n - positiveMod(parts.weekday + 6n, 7n));
  const isoYear = civilFromDays(thursday).year;
  const jan4 = daysFromCivil(isoYear, 1n, 4n);
  const firstMonday = jan4 - mondayIndex(positiveMod(jan4 + 4n, 7n));
  return { year: isoYear, week: (dayNumber - firstMonday) / 7n + 1n };
}

function formatDirective(conversion: string, tm: BrokenDownTime): string | undefined {
  const weekday = validTmIndex(tm.weekday, 0n, 6n);
  const month = validTmIndex(tm.month, 0n, 11n);
  const year = tm.year + 1900n;
  const hour12 = tm.hour % 12n || 12n;
  const weekU = (tm.yearDay + 7n - positiveMod(tm.weekday, 7n)) / 7n;
  const weekW = (tm.yearDay + 7n - mondayIndex(tm.weekday)) / 7n;
  const iso = isoWeek(tm);
  switch (conversion) {
    case 'a': return weekday === null ? undefined : DAY_SHORT[weekday];
    case 'A': return weekday === null ? undefined : DAY_LONG[weekday];
    case 'b': case 'h': return month === null ? undefined : MONTH_SHORT[month];
    case 'B': return month === null ? undefined : MONTH_LONG[month];
    case 'c': return formatDirective('a', tm)! + ' ' + formatDirective('b', tm)! + ' ' + formattedNumber(tm.day, 2, ' ') + ` ${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)} ${yearText(year)}`;
    case 'C': return formattedNumber(floorDiv(year, 100n), 2);
    case 'd': return formattedNumber(tm.day, 2);
    case 'D': return `${formattedNumber(tm.month + 1n, 2)}/${formattedNumber(tm.day, 2)}/${formattedNumber(positiveMod(year, 100n), 2)}`;
    case 'e': return formattedNumber(tm.day, 2, ' ');
    case 'F': return `${yearText(year)}-${formattedNumber(tm.month + 1n, 2)}-${formattedNumber(tm.day, 2)}`;
    case 'g': return formattedNumber(positiveMod(iso.year, 100n), 2);
    case 'G': return yearText(iso.year);
    case 'H': return formattedNumber(tm.hour, 2);
    case 'I': return formattedNumber(hour12, 2);
    case 'j': return formattedNumber(tm.yearDay + 1n, 3);
    case 'm': return formattedNumber(tm.month + 1n, 2);
    case 'M': return formattedNumber(tm.minute, 2);
    case 'n': return '\n';
    case 'p': return tm.hour < 12n ? 'AM' : 'PM';
    case 'r': return `${formattedNumber(hour12, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)} ${tm.hour < 12n ? 'AM' : 'PM'}`;
    case 'R': return `${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}`;
    case 'S': return formattedNumber(tm.second, 2);
    case 't': return '\t';
    case 'T': return `${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)}`;
    case 'u': return String(Number(mondayIndex(tm.weekday) + 1n));
    case 'U': return formattedNumber(weekU, 2);
    case 'V': return formattedNumber(iso.week, 2);
    case 'w': return weekday === null ? undefined : String(weekday);
    case 'W': return formattedNumber(weekW, 2);
    case 'x': return `${formattedNumber(tm.month + 1n, 2)}/${formattedNumber(tm.day, 2)}/${formattedNumber(positiveMod(year, 100n), 2)}`;
    case 'X': return `${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)}`;
    case 'y': return formattedNumber(positiveMod(year, 100n), 2);
    case 'Y': return yearText(year);
    case 'z': return '+0000';
    case 'Z': return 'UTC';
    case '%': return '%';
    default: return undefined;
  }
}

const E_MODIFIERS = new Set(['c', 'C', 'x', 'X', 'y', 'Y']);
const O_MODIFIERS = new Set(['d', 'e', 'H', 'I', 'm', 'M', 'S', 'u', 'U', 'V', 'w', 'W', 'y']);

function formatTm(format: Uint8Array, tm: BrokenDownTime, context: StdlibTimeRuntimeContext, at: Location): string {
  const output: number[] = [];
  for (let index = 0; index < format.length; index++) {
    const byte = format[index];
    if (byte !== 37) { output.push(byte); continue; }
    const first = format[++index];
    if (first === undefined) break;
    if (first === 37) { output.push(37); continue; }
    let modifier = '';
    let conversionByte = first;
    if (first === 69 || first === 79) {
      modifier = String.fromCharCode(first);
      conversionByte = format[++index] ?? 0;
    }
    const conversion = String.fromCharCode(conversionByte);
    if (modifier === 'E' && !E_MODIFIERS.has(conversion) || modifier === 'O' && !O_MODIFIERS.has(conversion)) {
      context.fail('LIBRARY_ARGUMENT', `Modificador strftime %${modifier}${conversion} no válido para el locale C.`, at);
    }
    const piece = formatDirective(conversion, tm);
    if (piece === undefined) context.fail('LIBRARY_ARGUMENT', `Conversión strftime «%${modifier}${conversion}» no válida o con campos tm fuera de rango.`, at);
    output.push(...new TextEncoder().encode(piece));
    context.chargeWork(1, at);
  }
  return new TextDecoder().decode(Uint8Array.from(output));
}

function parseTimeString(value: CValue, context: StdlibTimeRuntimeContext, at: Location): Uint8Array {
  if (value.value === null) return context.fail('LIBRARY_ARGUMENT', 'La cadena de formato time.h no puede ser nula.', at);
  return context.readCString(value, at);
}

function asctimeText(tm: BrokenDownTime): string | undefined {
  const weekday = validTmIndex(tm.weekday, 0n, 6n), month = validTmIndex(tm.month, 0n, 11n);
  if (weekday === null || month === null || tm.hour < 0n || tm.hour > 23n || tm.minute < 0n || tm.minute > 59n || tm.second < 0n || tm.second > 60n || tm.day < 1n || tm.day > 31n) return undefined;
  return `${DAY_SHORT[weekday]} ${MONTH_SHORT[month]} ${formattedNumber(tm.day, 2, ' ')} ${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)} ${yearText(tm.year + 1900n)}\n`;
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
    if (maximum < 0n || maximum > BigInt(Number.MAX_SAFE_INTEGER)) return context.fail('LIBRARY_ARGUMENT', 'strftime recibió un tamaño fuera del rango seguro.', at);
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
