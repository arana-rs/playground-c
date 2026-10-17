import type { CValue, CType, Location } from './internal.ts';
import { parseBinary80 } from './binary80.ts';
import { ERRNO_CODES } from './errno-metadata.ts';
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
  if (args.length !== expected) context.fail('LIBRARY_ARGUMENT', `${name} recibió una cantidad de argumentos no válida.`, at);
}

function integer(value: CValue, context: LibraryRuntimeContext, at: Location): bigint {
  if (typeof value.value !== 'bigint') return context.fail('LIBRARY_ARGUMENT', 'Se esperaba un argumento entero.', at);
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

function roundHexToBinary(token: string, bits: 32 | 64): number | undefined {
  const match = /^([+-]?)0[xX]((?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP]([+-]?[0-9]+)$/.exec(token);
  if (!match) return undefined;
  const point = match[2].indexOf('.');
  const fractionalLength = point < 0 ? 0 : match[2].length - point - 1;
  const digits = match[2].replace('.', '').replace(/^0+/, '') || '0';
  const significand = BigInt(`0x${digits}`);
  const exponentText = match[3];
  const exponentNegative = exponentText.startsWith('-');
  const exponentDigits = exponentText.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  const explicitExponent = exponentDigits.length > 7
    ? exponentNegative ? -2_000_001n : 2_000_001n
    : (exponentNegative ? -1n : 1n) * BigInt(exponentDigits);
  const exponent = explicitExponent - BigInt(fractionalLength * 4);
  const negative = match[1] === '-';
  if (significand === 0n) return negative ? -0 : 0;

  const precision = bits === 32 ? 24 : 53;
  const minNormalExponent = bits === 32 ? -126n : -1022n;
  const maxNormalExponent = bits === 32 ? 127n : 1023n;
  const minSubnormalExponent = minNormalExponent - BigInt(precision - 1);
  const bitLength = BigInt(significand.toString(2).length);
  const topExponent = bitLength - 1n + exponent;
  if (topExponent > maxNormalExponent) return negative ? -Infinity : Infinity;
  if (topExponent < minSubnormalExponent - 1n) return negative ? -0 : 0;

  let unitExponent = topExponent >= minNormalExponent
    ? topExponent - BigInt(precision - 1)
    : minSubnormalExponent;
  const shift = exponent - unitExponent;
  let rounded: bigint;
  if (shift >= 0n) rounded = significand << shift;
  else {
    const discardedBits = -shift;
    if (discardedBits > bitLength) rounded = 0n;
    else {
      const divisorShift = Number(discardedBits);
      const quotient = significand >> discardedBits;
      const remainder = significand - (quotient << discardedBits);
      const halfway = 1n << BigInt(divisorShift - 1);
      rounded = remainder > halfway || remainder === halfway && (quotient & 1n) === 1n ? quotient + 1n : quotient;
    }
  }
  if (rounded === 0n) return negative ? -0 : 0;
  if (rounded >= (1n << BigInt(precision))) { rounded >>= 1n; unitExponent++; }
  if (unitExponent + BigInt(precision - 1) > maxNormalExponent) return negative ? -Infinity : Infinity;
  const value = Number(rounded) * 2 ** Number(unitExponent);
  return negative ? -value : value;
}

function bitLength(value: bigint): bigint { return BigInt(value.toString(2).length); }

/** Rounds numerator / denominator × 2^binaryExponent directly to an IEEE format. */
function roundRationalToBinary(
  numerator: bigint, denominator: bigint, binaryExponent: bigint, bits: 32 | 64, negative: boolean,
): number {
  if (numerator === 0n) return negative ? -0 : 0;
  const precision = bits === 32 ? 24n : 53n;
  const minimumNormalExponent = bits === 32 ? -126n : -1022n;
  const maximumNormalExponent = bits === 32 ? 127n : 1023n;
  const minimumSubnormalExponent = minimumNormalExponent - (precision - 1n);
  let topExponent = bitLength(numerator) - bitLength(denominator) + binaryExponent;
  const comparisonShift = bitLength(numerator) - bitLength(denominator);
  const belowCandidateExponent = comparisonShift >= 0n
    ? numerator < (denominator << comparisonShift)
    : (numerator << -comparisonShift) < denominator;
  if (belowCandidateExponent) topExponent--;
  if (topExponent > maximumNormalExponent) return negative ? -Infinity : Infinity;
  if (topExponent < minimumSubnormalExponent - 1n) return negative ? -0 : 0;

  let unitExponent = topExponent >= minimumNormalExponent
    ? topExponent - (precision - 1n)
    : minimumSubnormalExponent;
  const shift = binaryExponent - unitExponent;
  const scaledNumerator = shift >= 0n ? numerator << shift : numerator;
  const scaledDenominator = shift >= 0n ? denominator : denominator << -shift;
  let rounded = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const halfway = remainder << 1n;
  if (halfway > scaledDenominator || halfway === scaledDenominator && (rounded & 1n) !== 0n) rounded++;
  if (rounded === 0n) return negative ? -0 : 0;
  if (rounded >= (1n << precision)) { rounded >>= 1n; unitExponent++; }
  if (unitExponent + precision - 1n > maximumNormalExponent) return negative ? -Infinity : Infinity;
  const value = Number(rounded) * 2 ** Number(unitExponent);
  return negative ? -value : value;
}

function roundDecimalToBinary32(token: string): number {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return 0;
  const negative = match[1] === '-';
  const fraction = match[3] ?? match[4] ?? '';
  const rawDigits = `${match[2] ?? ''}${fraction}`;
  const significantDigits = rawDigits.replace(/^0+/, '');
  if (!significantDigits) return negative ? -0 : 0;

  let exponent = 0n;
  if (match[5]) {
    const exponentNegative = match[5].startsWith('-');
    const exponentDigits = match[5].replace(/^[+-]/, '').replace(/^0+/, '') || '0';
    // Values this large are classified by their decimal order below, without
    // converting an arbitrarily long exponent string into a BigInt.
    exponent = exponentDigits.length > 7
      ? (exponentNegative ? -2_000_001n : 2_000_001n)
      : (exponentNegative ? -1n : 1n) * BigInt(exponentDigits);
  }
  const decimalExponent = exponent - BigInt(fraction.length);
  const decimalOrder = BigInt(significantDigits.length - 1) + decimalExponent;
  if (decimalOrder > 38n) return negative ? -Infinity : Infinity;
  if (decimalOrder < -46n) return negative ? -0 : 0;

  // Remove trailing zeroes before forming powers of five.  The decimal value
  // is digits × 5^e × 2^e, so this remains an exact rational conversion.
  const trimmedDigits = significantDigits.replace(/0+$/, '') || '0';
  const trailingZeroes = significantDigits.length - trimmedDigits.length;
  const normalizedExponent = decimalExponent + BigInt(trailingZeroes);
  const significand = BigInt(trimmedDigits);
  const fivePower = normalizedExponent < 0n ? -normalizedExponent : normalizedExponent;
  const fiveFactor = 5n ** fivePower;
  const numerator = normalizedExponent >= 0n ? significand * fiveFactor : significand;
  const denominator = normalizedExponent < 0n ? fiveFactor : 1n;
  return roundRationalToBinary(numerator, denominator, normalizedExponent, 32, negative);
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
  const parsed = special ?? (targetBits === 32
    ? (/^[-+]?0x/i.test(token) ? roundHexToBinary(token, 32) : roundDecimalToBinary32(token))
    : (/^[-+]?0x/i.test(token) ? roundHexToBinary(token, 64) : Number(token)));
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
