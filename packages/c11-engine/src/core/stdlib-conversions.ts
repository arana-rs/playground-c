import type { CValue, CType, Location } from './internal.ts';
import { parseBinary80 } from './binary80.ts';
import { ERRNO_CODES } from './errno-metadata.ts';
import { parseFloatingToken } from './float-parsing.ts';
import type { LibraryRuntimeContext } from './library.ts';

const { EINVAL, ERANGE } = ERRNO_CODES;
const whitespace = new Set([9, 10, 11, 12, 13, 32]);

interface IntegerParse {
  readonly value: bigint;
  /** Byte offset from the original string, or zero when no conversion occurred. */
  readonly endOffset: number;
  readonly overflow: boolean;
}

interface FloatSubject {
  readonly token: string;
  readonly endOffset: number;
}

function count(args: readonly CValue[], expected: number, name: string, context: LibraryRuntimeContext, at: Location): void {
  if (args.length !== expected) context.fail('LIBRARY_ARGUMENT', `${name} received an invalid number of arguments.`, at);
}

function integer(value: CValue, context: LibraryRuntimeContext, at: Location): bigint {
  if (typeof value.value !== 'bigint') return context.fail('LIBRARY_ARGUMENT', 'Expected an integer argument.', at);
  return value.value;
}

export function digitForBase(byte: number, base: number): number {
  const digit = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 90 ? byte - 55 : byte >= 97 && byte <= 122 ? byte - 87 : -1;
  return digit >= 0 && digit < base ? digit : -1;
}

function parseInteger(bytes: Uint8Array, requestedBase: number, signed: boolean, bits: number): IntegerParse {
  let cursor = 0;
  while (cursor < bytes.length && whitespace.has(bytes[cursor])) cursor++;
  let negative = false;
  if (bytes[cursor] === 43 || bytes[cursor] === 45) negative = bytes[cursor++] === 45;
  let base = requestedBase;
  const hasHexPrefix = bytes[cursor] === 48 && (bytes[cursor + 1] === 120 || bytes[cursor + 1] === 88) &&
    digitForBase(bytes[cursor + 2] ?? -1, 16) >= 0;
  if (base === 0) {
    if (hasHexPrefix) { base = 16; cursor += 2; }
    else base = bytes[cursor] === 48 ? 8 : 10;
  } else if (base === 16 && hasHexPrefix) cursor += 2;

  const signedLimit = 1n << BigInt(bits - 1);
  const maximum = signed ? negative ? signedLimit : signedLimit - 1n : (1n << BigInt(bits)) - 1n;
  let magnitude = 0n;
  let overflow = false;
  const firstDigit = cursor;
  while (cursor < bytes.length) {
    const digit = digitForBase(bytes[cursor], base);
    if (digit < 0) break;
    if (!overflow) {
      const next = magnitude * BigInt(base) + BigInt(digit);
      if (next > maximum) { magnitude = maximum; overflow = true; }
      else magnitude = next;
    }
    cursor++;
  }
  if (cursor === firstDigit) return { value: 0n, endOffset: 0, overflow: false };
  if (overflow) {
    magnitude = maximum;
    // The conversion result is saturated before applying the optional
    // unsigned negation.  Negating a saturated ULONG_MAX/ULLONG_MAX would
    // incorrectly turn an out-of-range subject sequence into 1.
    if (!signed) return { value: maximum, endOffset: cursor, overflow: true };
  }
  if (signed) return { value: negative ? -magnitude : magnitude, endOffset: cursor, overflow };
  return { value: negative ? BigInt.asUintN(bits, -magnitude) : magnitude, endOffset: cursor, overflow };
}

function putEndPointer(args: readonly CValue[], index: number, endOffset: number, context: LibraryRuntimeContext, at: Location): void {
  if (args[index].value === null) return;
  const end = context.offsetPointer(args[0], endOffset, at);
  context.writeScalar(args[index], end, at);
}

function parseIntegerBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  const noEndPointer = name === 'atoi' || name === 'atol' || name === 'atoll';
  count(args, noEndPointer ? 1 : 3, name, context, at);
  const bytes = context.readCString(args[0], at);
  context.chargeWork(bytes.length, at);
  const baseValue = noEndPointer ? 10n : integer(args[2], context, at);
  const base = Number(baseValue);
  const bits = name === 'atoi' ? 32 : 64;
  const signed = !['strtoul', 'strtoull', 'strtoumax'].includes(name);
  if (!noEndPointer && (baseValue !== 0n && (base < 2 || base > 36))) {
    context.errno.set(EINVAL);
    putEndPointer(args, 1, 0, context, at);
    return context.makeInt(0n, resultType ?? (name === 'strtoul' || name === 'strtoull' || name === 'strtoumax' ? 'unsigned long' : 'long'));
  }
  const parsed = parseInteger(bytes, base, signed, bits);
  if (parsed.overflow) context.errno.set(ERANGE);
  if (!noEndPointer) putEndPointer(args, 1, parsed.endOffset, context, at);
  const fallbackType = name === 'atoi' ? 'int'
    : name === 'atol' || name === 'strtol' || name === 'strtoimax' ? 'long'
      : name === 'atoll' || name === 'strtoll' ? 'long long'
        : name === 'strtoull' ? 'unsigned long long' : 'unsigned long';
  return context.makeInt(parsed.value, resultType ?? fallbackType);
}

function extractFloatSubject(bytes: Uint8Array): FloatSubject | null {
  let leading = 0;
  while (leading < bytes.length && whitespace.has(bytes[leading])) leading++;
  const text = new TextDecoder().decode(bytes.subarray(leading));
  const special = /^[+-]?(?:infinity|inf|nan(?:\([a-z0-9_]*\))?)/i.exec(text);
  const hexadecimal = /^[+-]?0[xX](?:(?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP][+-]?[0-9]+/.exec(text);
  const decimal = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(text);
  const match = special ?? [hexadecimal, decimal].filter((candidate): candidate is RegExpExecArray => candidate !== null)
    .sort((left, right) => right[0].length - left[0].length)[0];
  return match ? { token: match[0], endOffset: leading + match[0].length } : null;
}

function parseSpecialNumber(token: string): number | undefined {
  if (/^[+-]?inf(?:inity)?$/i.test(token)) return token.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan(?:\([a-z0-9_]*\))?$/i.test(token)) return NaN;
  return undefined;
}

function hasNonzeroFloatSignificand(token: string): boolean {
  const unsigned = token.replace(/^[+-]/, '');
  if (/^0x/i.test(unsigned)) return /[1-9a-f]/i.test(unsigned.split(/[pP]/, 1)[0]);
  return /[1-9]/.test(unsigned.split(/[eE]/, 1)[0]);
}

function floatBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  const noEndPointer = name === 'atof';
  count(args, noEndPointer ? 1 : 2, name, context, at);
  const bytes = context.readCString(args[0], at);
  context.chargeWork(bytes.length, at);
  const subject = extractFloatSubject(bytes);
  if (!noEndPointer) putEndPointer(args, 1, subject?.endOffset ?? 0, context, at);
  if (!subject) return name === 'strtold'
    ? { type: resultType ?? 'long double', value: parseBinary80('0') }
    : { type: resultType ?? (name === 'strtof' ? 'float' : 'double'), value: 0 };

  const token = subject.token;
  const special = parseSpecialNumber(token);
  if (name === 'strtold') {
    const value = parseBinary80(token);
    if (special === undefined && (value.classification === 'infinity' || value.classification === 'finite' && value.significand === 0n && hasNonzeroFloatSignificand(token) || value.classification === 'finite' && value.significand > 0n && value.significand < (1n << 63n))) context.errno.set(ERANGE);
    return { type: resultType ?? 'long double', value };
  }
  const targetBits = name === 'strtof' ? 32 : 64;
  const parsed = special ?? parseFloatingToken(token, targetBits);
  const value = parsed ?? 0;
  if (special === undefined && (!Number.isFinite(value) || value === 0 && hasNonzeroFloatSignificand(token) || value !== 0 && Math.abs(value) < (targetBits === 32 ? 2 ** -126 : 2 ** -1022))) {
    context.errno.set(ERANGE);
  }
  return { type: resultType ?? (targetBits === 32 ? 'float' : 'double'), value };
}

/** C-locale conversion routines with LP64 ranges and exact binary80 strtold results. */
export function dispatchStdlibConversionBuiltin(
  name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext,
): CValue | undefined {
  const at = context.at;
  if (['atoi', 'atol', 'atoll', 'strtol', 'strtoul', 'strtoll', 'strtoull', 'strtoimax', 'strtoumax'].includes(name)) {
    return parseIntegerBuiltin(name, args, resultType, context, at);
  }
  if (['atof', 'strtod', 'strtof', 'strtold'].includes(name)) return floatBuiltin(name, args, resultType, context, at);
  return undefined;
}
