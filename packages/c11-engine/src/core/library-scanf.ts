import type { CType, CValue, Location } from './internal.ts';
import { parseBinary80 } from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import { parseFloatingToken } from './float-parsing.ts';
import { digitForBase } from './stdlib-conversions.ts';
import type { VirtualByteRead, VirtualStream } from './virtual-io.ts';
import type { LibraryRuntimeContext, ResumableLibraryBuiltin } from './library.ts';
import type { LibraryBuiltinRequest } from './library-requests.ts';
import {
  EOF_VALUE, ERRNO, asciiWhitespace, argCount, cString, decodeUtf8, eofMinusOne,
  invalid, pointerValue, returnInteger, safeFormatNumber, writeBytes,
} from './library-common.ts';

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

function* scanPeek(input: ScanInput): Generator<LibraryBuiltinRequest, number, CValue | void> {
  while (true) {
    const result = input.peek();
    if (result.kind === 'pending') {
      yield { kind: 'input-needed' };
      continue;
    }
    return result.kind === 'byte' ? result.value : EOF_VALUE;
  }
}

function* scanTake(input: ScanInput): Generator<LibraryBuiltinRequest, number, CValue | void> {
  const value = yield* scanPeek(input);
  if (value < 0) {
    input.take();
    return EOF_VALUE;
  }
  const result = input.take();
  return result.kind === 'byte' ? result.value : EOF_VALUE;
}

export function* scanfBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): ResumableLibraryBuiltin {
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
    if (!pointer) invalid(context, 'The scanf format string requires more destination pointers.', at);
    return pointerValue(pointer, at, context);
  };
  const skipSpace = function* (): Generator<LibraryBuiltinRequest, void, CValue | void> {
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
    if (!specifier) invalid(context, 'The scanf format string ends within a conversion.', at);
    if (length === 'l' && (specifier === 'c' || specifier === 's' || specifier === '[')) {
      return context.fail('UNSUPPORTED_FEATURE', `Wide scanf conversion «%l${specifier}» is outside the implemented profile.`, at);
    }
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
      if (!closed) invalid(context, 'The %[ conversion set is missing its closing ].', at);
    }
    if (specifier === 'n') {
      if (!suppress) context.writeScalar(takeDestination(), context.makeInt(input.consumed, scanIntegerType('d', length)), at);
      continue;
    }
    const isCharacter = specifier === 'c';
    const isString = specifier === 's' || specifier === '[';
    // C's scanf skips leading whitespace for %s and numeric conversions, but
    // not for %c or %[]. This also lets a later %s cross a pending line break.
    if (!isCharacter && specifier !== '[') yield* skipSpace();
    const bytes: number[] = [];
    if (isCharacter) {
      const wanted = widthText ? width : 1;
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
    if (!integerConversion && !floatConversion && specifier !== 'p') invalid(context, `scanf conversion «%${length}${specifier}» is not implemented.`, at);
    if (floatConversion && !['', 'l', 'L'].includes(length)) invalid(context, `Modifier «${length}» is invalid for scanf «%${specifier}».`, at);
    if (integerConversion && length === 'L') invalid(context, `Modifier «L» is invalid for scanf «%${specifier}».`, at);
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
        return context.fail('UNSUPPORTED_FEATURE', 'scanf conversion «%p» requires the virtual machine pointer reader.', at);
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
    else parsed = parseScannedFloat(token, length === 'l' ? 64 : 32);
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

function parseScannedFloat(text: string, format: 32 | 64): number | undefined {
  return parseFloatingToken(text, format);
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
