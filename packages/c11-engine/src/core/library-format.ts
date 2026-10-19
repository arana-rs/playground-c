import type { CType, CValue, Location } from './internal.ts';
import { binary80FromNumber } from './binary80.ts';
import type { LibraryRuntimeContext } from './library.ts';
import type { LibraryBuiltinResult } from './library.ts';
import { scanfBuiltin } from './library-scanf.ts';
import {
  ERRNO, argCount, checkedSize, cString, decodeUtf8, integerValue, invalid,
  returnInteger, safeFormatNumber,
} from './library-common.ts';
import {
  asBinary80, decimalFormatWorkLowerBound, decimalPrecisionForFormat,
  formatBinary80Decimal, formatHexFloatValue,
} from './library-format-numeric.ts';

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
  let prechargedOutputWork = 0;
  const pieces: Uint8Array[] = [];
  const reserve = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total + count)) invalid(context, 'Formatted output exceeds the safe range.', at);
    context.preflightOutputBytes(total + count, at);
  };
  const append = (bytes: Uint8Array): void => {
    reserve(bytes.length);
    pieces.push(bytes); total += bytes.length;
  };
  const take = (): CValue => {
    const value = args[argumentIndex++];
    if (!value) invalid(context, 'The format string requires more arguments.', at);
    return value;
  };
  const takeInteger = (): bigint => integerValue(take(), at, context);
  const prechargeOutputWork = (count: number): void => {
    if (count <= 0) return;
    context.chargeWork(count, at);
    prechargedOutputWork += count;
  };

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
    if (!specifier) invalid(context, 'The format string ends within a conversion.', at);
    if (specifier === 'n') {
      const pointer = take();
      context.writeScalar(pointer, context.makeInt(total, printfCountType(length)), at);
      continue;
    }
    if (length === 'l' && (specifier === 'c' || specifier === 's')) {
      return context.fail('UNSUPPORTED_FEATURE', `Wide printf conversion «%l${specifier}» is outside the implemented profile.`, at);
    }
    const value = take();
    const longDouble = length === 'L' && 'fFeEgGaA'.includes(specifier) ? asBinary80(value) : undefined;
    if (length === 'L' && 'fFeEgGaA'.includes(specifier) && !longDouble) {
      return context.fail('LIBRARY_ARGUMENT', `Conversion «%L${specifier}» requires a long double argument.`, at);
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
      if (precision !== undefined && precision > 100_000) return context.fail('UNSUPPORTED_FEATURE', 'Hexadecimal precision exceeds the implemented maximum (100000 digits).', at);
      reserve(Math.max(width ?? 0, (precision ?? 64) + 32));
      const uppercase = specifier === 'A';
      const { prefix, digits, negative, finite } = formatHexFloatValue(value, longDouble, precision, flags.includes('#'), uppercase, context, at);
      const sign = negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      core = encodePadded(sign + prefix, digits, width ?? 0, flags, finite, context, at);
    } else if ('fFeEgG'.includes(specifier)) {
      isNumeric = true;
      const numeric = typeof value.value === 'number' ? value.value : typeof value.value === 'bigint' ? Number(value.value) : NaN;
      const requestedPrecision = precision ?? 6;
      const binary = longDouble ?? binary80FromNumber(numeric);
      const conversion = specifier.toLowerCase() as 'f' | 'e' | 'g';
      const alternate = flags.includes('#');
      const sign = binary.negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      const decimalPrecision = decimalPrecisionForFormat(binary, conversion, requestedPrecision, alternate);
      const lowerBound = decimalFormatWorkLowerBound(binary, conversion, decimalPrecision, alternate);
      reserve(Math.max(width ?? 0, lowerBound));
      prechargeOutputWork(Math.max(width ?? 0, lowerBound));
      const formatted = formatBinary80Decimal(binary, conversion, requestedPrecision, alternate);
      let digits = formatted.digits;
      if (specifier === specifier.toUpperCase()) digits = digits.toUpperCase();
      core = encodePadded(sign, digits, width ?? 0, flags, true, context, at);
    } else if (specifier === 's') {
      let bytes = cString(value, at, context, precision);
      if (bytes === null) return null;
      core = padBytes(bytes, width ?? 0, flags.includes('-'), context, at, total);
    } else if (specifier === 'c') {
      const byte = Number(BigInt.asUintN(8, integerValue(value, at, context)));
      core = padBytes(new Uint8Array([byte]), width ?? 0, flags.includes('-'), context, at, total);
    } else if (specifier === 'p') {
      const text = context.formatPointer(value, at);
      core = padBytes(new TextEncoder().encode(text), width ?? 0, flags.includes('-'), context, at, total);
    } else invalid(context, `Conversion «%${length}${specifier}» is not implemented.`, at);
    if (isNumeric && flags.includes('0') && !flags.includes('-') && precision === undefined) {
      // Numeric fields are padded in encodePadded before allocation.
    }
    append(core);
  }
  context.preflightOutputBytes(total, at);
  context.chargeWork(total - prechargedOutputWork, at);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of pieces) { result.set(part, offset); offset += part.length; }
  return result;
}

function printfCountType(length: string): CType {
  if (length === 'hh') return 'signed char';
  if (length === 'h') return 'short';
  if (length === 'l' || length === 'j' || length === 'z' || length === 't') return 'long';
  if (length === 'll') return 'long long';
  return 'int';
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
export function dispatchFormatBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext): LibraryBuiltinResult | undefined {
  const at = context.at;
  const outputVBase = ({ vprintf: 'printf', vfprintf: 'fprintf', vsprintf: 'sprintf', vsnprintf: 'snprintf' } as const)[name as 'vprintf' | 'vfprintf' | 'vsprintf' | 'vsnprintf'];
  if (outputVBase) {
    const fixedCount = outputVBase === 'printf' ? 1 : outputVBase === 'snprintf' ? 3 : 2;
    argCount(args, fixedCount + 1, fixedCount + 1, name, context, at);
    const varargs = context.consumeVaList(args[fixedCount], at);
    return printfBuiltin(outputVBase, [...args.slice(0, fixedCount), ...varargs], resultType, context, at);
  }
  if (['printf', 'fprintf', 'sprintf', 'snprintf'].includes(name)) return printfBuiltin(name, args, resultType, context, at);
  const inputVBase = ({ vscanf: 'scanf', vfscanf: 'fscanf', vsscanf: 'sscanf' } as const)[name as 'vscanf' | 'vfscanf' | 'vsscanf'];
  if (inputVBase) {
    const fixedCount = inputVBase === 'scanf' ? 1 : 2;
    argCount(args, fixedCount + 1, fixedCount + 1, name, context, at);
    const varargs = context.consumeVaList(args[fixedCount], at);
    return scanfBuiltin(inputVBase, [...args.slice(0, fixedCount), ...varargs], resultType, context, at);
  }
  if (['scanf', 'fscanf', 'sscanf'].includes(name)) return scanfBuiltin(name, args, resultType, context, at);
  return undefined;
}
