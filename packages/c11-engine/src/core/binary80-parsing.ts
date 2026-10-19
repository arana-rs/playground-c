import { binary80Infinity, binary80NaN, binary80Zero } from './binary80-value.ts';
import type { Binary80Value } from './binary80-value.ts';
import { bitLength, binary80FromRational } from './binary80-rounding.ts';

// A binary80 midpoint can have about 11,500 significant decimal digits near
// the least subnormal. Keep enough exact decimal digits to distinguish those
// halfway cases before the sticky-tail shortcut is used.
const MAX_DECIMAL_SIGNIFICANT_DIGITS = 12_000;
const MAX_HEX_SIGNIFICANT_DIGITS = 4200;

function signedSpecial(text: string, negative: boolean): Binary80Value | undefined {
  if (/^inf(?:inity)?$/i.test(text)) return binary80Infinity(negative);
  if (/^nan(?:\([a-z0-9_]*\))?$/i.test(text)) return binary80NaN(negative);
  return undefined;
}

function parseExponent(text: string): bigint {
  const negative = text.startsWith('-');
  const digits = text.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  // Source/token limits are around one million characters. Larger exponent
  // fields are already far outside that range, so saturate before BigInt parse.
  if (digits.length > 7) return negative ? -2_000_001n : 2_000_001n;
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

function parseDecimal(text: string, negative: boolean): Binary80Value | undefined {
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const whole = match[1] ?? '';
  const fractional = match[2] ?? match[3] ?? '';
  let digits = `${whole}${fractional}`.replace(/^0+/, '');
  if (!digits) return binary80Zero(negative);

  let decimalScale = parseExponent(match[4] ?? '0') - BigInt(fractional.length);
  const trailingZeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros);
    decimalScale += BigInt(trailingZeros);
  }

  let sticky = false;
  if (digits.length > MAX_DECIMAL_SIGNIFICANT_DIGITS) {
    const retained = digits.slice(0, MAX_DECIMAL_SIGNIFICANT_DIGITS);
    const tail = digits.slice(MAX_DECIMAL_SIGNIFICANT_DIGITS);
    sticky = /[1-9]/.test(tail);
    decimalScale += BigInt(tail.length);
    digits = retained;
  }

  const decimalOrder = BigInt(digits.length) + decimalScale - 1n;
  if (decimalOrder > 5000n) return binary80Infinity(negative);
  if (decimalOrder < -5000n) return binary80Zero(negative);
  const scale = Number(decimalScale);
  const numerator = BigInt(digits);
  if (scale >= 0) {
    return binary80FromRational(numerator * 10n ** BigInt(scale), 1n, { negative, sticky });
  }
  return binary80FromRational(numerator, 10n ** BigInt(-scale), { negative, sticky });
}

function parseHexadecimal(text: string, negative: boolean): Binary80Value | undefined {
  const match = /^0[xX]((?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP]([+-]?\d+)$/.exec(text);
  if (!match) return undefined;
  const point = match[1].indexOf('.');
  const fractionalLength = point < 0 ? 0 : match[1].length - point - 1;
  let digits = match[1].replace('.', '').replace(/^0+/, '');
  if (!digits) return binary80Zero(negative);

  let binaryExponent = parseExponent(match[2]) - BigInt(fractionalLength * 4);
  const trailingZeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros);
    binaryExponent += BigInt(trailingZeros * 4);
  }

  let sticky = false;
  if (digits.length > MAX_HEX_SIGNIFICANT_DIGITS) {
    const retained = digits.slice(0, MAX_HEX_SIGNIFICANT_DIGITS);
    const tail = digits.slice(MAX_HEX_SIGNIFICANT_DIGITS);
    sticky = /[1-9a-f]/i.test(tail);
    binaryExponent += BigInt(tail.length * 4);
    digits = retained;
  }

  const numerator = BigInt(`0x${digits}`);
  const topExponent = BigInt(bitLength(numerator) - 1) + binaryExponent;
  if (topExponent > 16383n) return binary80Infinity(negative);
  if (topExponent < -16447n) return binary80Zero(negative);
  return binary80FromRational(numerator, 1n, {
    binaryExponent: Number(binaryExponent),
    negative,
    sticky,
  });
}

/** Parse a C decimal or hexadecimal floating value directly into binary80. */
export function parseBinary80(input: string): Binary80Value {
  let text = input.trim();
  if (/[lL]$/.test(text)) text = text.slice(0, -1);
  let negative = false;
  if (text.startsWith('+') || text.startsWith('-')) {
    negative = text.startsWith('-');
    text = text.slice(1);
  }
  const special = signedSpecial(text, negative);
  if (special) return special;
  const parsed = /^0[xX]/.test(text) ? parseHexadecimal(text, negative) : parseDecimal(text, negative);
  if (!parsed) throw new SyntaxError(`Invalid binary80 floating-point literal: «${input}».`);
  return parsed;
}
