import { failure } from './internal.ts';
import type { CType, CValue, Location } from './internal.ts';
import { parseBinary80 } from './binary80.ts';
import { bounds } from './numeric-integers.ts';
import { roundedRational } from './numeric-conversions.ts';

export function encodeUtf8Bytes(codePoint: number): number[] {
  if (codePoint <= 0x7f) return [codePoint];
  if (codePoint <= 0x7ff) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  if (codePoint <= 0xffff) return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
  return [0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
}


function character(text: string, location: Location): CValue {
  if (!text.startsWith("'") || !text.endsWith("'")) failure('UNSUPPORTED_FEATURE', 'P2 does not implement wide-character or Unicode character constants.', location);
  const content = text.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { "'": 39, '"': 34, '?': 63, '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  for (let index = 0; index < content.length; index++) {
    let code = content.charCodeAt(index);
    if (content[index] === '\\') {
      const escape = content[++index];
      if (escape === undefined) failure('SYNTAX_ERROR', 'Incomplete escape in character constant.', location);
      if (Object.hasOwn(simple, escape)) code = simple[escape];
      else if (/[0-7]/.test(escape)) {
        let digits = escape;
        while (digits.length < 3 && /[0-7]/.test(content[index + 1] ?? '')) digits += content[++index];
        code = Number.parseInt(digits, 8);
      } else if (escape === 'x') {
        let digits = '';
        while (/[0-9a-fA-F]/.test(content[index + 1] ?? '')) digits += content[++index];
        if (!digits) failure('SYNTAX_ERROR', 'A hexadecimal character escape requires at least one digit.', location);
        code = Number.parseInt(digits, 16);
      } else failure('UNSUPPORTED_FEATURE', 'P2 supports single-byte characters and standard, octal, or hexadecimal escapes.', location);
      if (code > 255) failure('SYNTAX_ERROR', 'The character escape exceeds the target byte range.', location);
    } else if (code > 127) {
      failure('UNSUPPORTED_FEATURE', 'P2 supports ASCII characters in character constants.', location);
    }
    bytes.push(code);
  }
  if (bytes.length === 0) failure('SYNTAX_ERROR', 'An empty character constant is not valid C11.', location);
  if (bytes.length === 1) return { type: 'int', value: BigInt.asIntN(8, BigInt(bytes[0])) };

  // Multi-character constants are implementation-defined in C11. This LP64
  // profile packs bytes left-to-right into int, retaining its low 32 bits.
  let packed = 0n;
  for (const byte of bytes) packed = BigInt.asIntN(32, (packed << 8n) | BigInt(byte));
  return { type: 'int', value: packed };
}
function parseFloating(text: string, location: Location): CValue {
  const hex = /^0[xX]/.test(text);
  const pattern = hex
    ? /^0[xX]((?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP]([+-]?[0-9]+)([fFlL]?)$/
    : /^((?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)([fFlL]?)$/;
  const match = pattern.exec(text);
  if (!match) failure('SYNTAX_ERROR', `Invalid C11 floating-point constant: «${text}».`, location);
  const suffix = match[hex ? 3 : 2];
  if (/^[lL]$/.test(suffix)) {
    const value = parseBinary80(text);
    if (value.classification === 'infinity') failure('FLOAT_LITERAL_RANGE', 'Literal exceeds the long double binary80 range.', location);
    return { type: 'long double', value };
  }
  const type = /^[fF]$/.test(suffix) ? 'float' : 'double';
  let significand: string, exponent: number;
  if (hex) { significand = match[1]; exponent = Number(match[2]); }
  else {
    const parts = match[1].split(/[eE]/);
    significand = parts[0]; exponent = parts.length === 2 ? Number(parts[1]) : 0;
  }
  const point = significand.indexOf('.');
  const fractionalDigits = point < 0 ? 0 : significand.length - point - 1;
  let digits = significand.replace('.', '').replace(/^0+/, '');
  if (!digits) return { type, value: 0 };
  exponent -= fractionalDigits * (hex ? 4 : 1);
  const order = exponent + digits.length * (hex ? 4 : 1);
  if (order > (hex ? 1100 : 310)) failure('FLOAT_LITERAL_RANGE', `Literal exceeds the ${type} range.`, location);
  if (order < (hex ? -1100 : -330)) return { type, value: 0 };
  // Every binary32/64 halfway point has a terminating decimal representation
  // shorter than 1200 significant digits (or 300 hex digits). Additional digits
  // can therefore affect a tie only, and a sticky bit suffices without huge BigInts.
  const retainedDigits = hex ? 300 : 1200;
  const tail = digits.slice(retainedDigits);
  const sticky = /[1-9a-fA-F]/.test(tail);
  if (tail) { digits = digits.slice(0, retainedDigits); exponent += tail.length * (hex ? 4 : 1); }
  let numerator = BigInt(hex ? `0x${digits}` : digits), denominator = 1n;
  if (exponent >= 0) numerator = hex ? numerator << BigInt(exponent) : numerator * 10n ** BigInt(exponent);
  else denominator = hex ? 1n << BigInt(-exponent) : 10n ** BigInt(-exponent);
  const result = roundedRational(numerator, denominator, type, sticky);
  if (!Number.isFinite(result)) failure('FLOAT_LITERAL_RANGE', `Literal exceeds the ${type} range.`, location);
  return { type, value: result };
}
export function parseLiteral(text: string, location: Location): CValue {
  if (text.includes("'")) return character(text, location);
  if (/^0[bB]/.test(text)) failure('UNSUPPORTED_FEATURE', 'Binary 0b literals are not part of C11; P2 supports decimal, octal, and hexadecimal bases.', location);
  const hex = /^0[xX]/.test(text);
  if (hex ? /[.pP]/.test(text) : /[.eE]/.test(text)) return parseFloating(text, location);
  const match = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uU](?:[lL]|ll|LL)?|(?:[lL]|ll|LL)[uU]?)?$/.exec(text);
  if (!match) failure('SYNTAX_ERROR', `Invalid C11 integer constant: «${text}».`, location);
  const decimal = /^[1-9]/.test(match[1]);
  const suffix = (match[2] ?? '').toLowerCase();
  const unsigned = suffix.includes('u'), longs = suffix.replace('u', '').length;
  let candidates: CType[];
  if (unsigned) candidates = longs === 2 ? ['unsigned long long'] : longs === 1 ? ['unsigned long', 'unsigned long long'] : ['unsigned int', 'unsigned long', 'unsigned long long'];
  else if (longs === 2) candidates = decimal ? ['long long'] : ['long long', 'unsigned long long'];
  else if (longs === 1) candidates = decimal ? ['long', 'long long'] : ['long', 'unsigned long', 'long long', 'unsigned long long'];
  else candidates = decimal ? ['int', 'long', 'long long'] : ['int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long'];
  const digits = match[1].replace(/^0[xX]/, '').replace(/^0+/, '') || '0';
  if (digits.length > (hex ? 16 : decimal ? 20 : 22)) failure('UNSUPPORTED_FEATURE', 'The literal requires an extended integer type, outside the P2 LP64 target.', location);
  const value = BigInt(hex ? `0x${digits}` : decimal ? digits : `0o${digits}`);
  for (const type of candidates) if (value <= bounds(type).max) return { type, value };
  failure('UNSUPPORTED_FEATURE', 'The literal is not representable by the candidate C11 integer types on the LP64 target.', location);
}
