import {
  INTEGER_BIT, MIN_NORMAL_EXPONENT, PRECISION, assertBinary80,
} from './binary80-value.ts';
import type { Binary80Value } from './binary80-value.ts';
import { roundedQuotient } from './binary80-rounding.ts';

function roundedHexFraction(fraction: bigint, discardedBits: number): bigint {
  if (discardedBits <= 0) return fraction << BigInt(-discardedBits);
  const shift = BigInt(discardedBits);
  const quotient = fraction >> shift;
  const remainder = fraction & ((1n << shift) - 1n);
  const halfway = 1n << (shift - 1n);
  return remainder > halfway || (remainder === halfway && (quotient & 1n) !== 0n)
    ? quotient + 1n : quotient;
}

/** Exact `%a`-style rendering, including sign and specials, without Number conversion. */
export function formatBinary80Hex(input: Binary80Value, precision?: number, uppercase = false): string {
  const checked = assertBinary80(input);
  if (precision !== undefined && (!Number.isSafeInteger(precision) || precision < 0 || precision > 100_000)) {
    throw new RangeError('The binary80 hexadecimal precision must be between 0 and 100000.');
  }
  const sign = checked.negative ? '-' : '';
  const prefix = uppercase ? '0X' : '0x';
  const marker = uppercase ? 'P' : 'p';
  const casing = (text: string): string => uppercase ? text.toUpperCase() : text;
  if (checked.classification === 'nan') return `${sign}${casing('nan')}`;
  if (checked.classification === 'infinity') return `${sign}${casing('inf')}`;
  if (checked.significand === 0n) {
    const fraction = precision === undefined || precision === 0 ? '' : `.${'0'.repeat(precision)}`;
    return `${sign}${prefix}0${fraction}${marker}+0`;
  }

  const normal = checked.significand >= INTEGER_BIT;
  const exponent = normal ? checked.exponent + 63 : MIN_NORMAL_EXPONENT;
  if (precision === 0) {
    let leading = roundedQuotient(checked.significand, INTEGER_BIT, false);
    let adjustedExponent = exponent;
    if (normal && leading >= 2n) {
      leading = 1n;
      adjustedExponent++;
    }
    return `${sign}${prefix}${leading}${marker}${adjustedExponent < 0 ? '' : '+'}${adjustedExponent}`;
  }
  const fractionBits = normal ? checked.significand - INTEGER_BIT : checked.significand;
  let leadingDigit = normal ? 1n : 0n;
  let fractionDigits: string;

  if (precision === undefined) {
    const nibbleCount = Math.ceil((PRECISION - 1) / 4);
    const padded = fractionBits << BigInt(nibbleCount * 4 - (PRECISION - 1));
    fractionDigits = padded.toString(16).padStart(nibbleCount, '0').replace(/0+$/, '');
  } else {
    const fractionWidth = precision * 4;
    const rounded = roundedHexFraction(fractionBits, (PRECISION - 1) - fractionWidth);
    const limit = 1n << BigInt(fractionWidth);
    let fraction = rounded;
    let adjustedExponent = exponent;
    if (fraction >= limit) {
      leadingDigit = 1n;
      fraction = 0n;
      if (normal) adjustedExponent++;
    }
    const exactExponent = adjustedExponent;
    fractionDigits = precision === 0 ? '' : fraction.toString(16).padStart(precision, '0');
    const body = `${leadingDigit}${precision ? `.${casing(fractionDigits)}` : ''}`;
    return `${sign}${prefix}${body}${marker}${exactExponent < 0 ? '' : '+'}${exactExponent}`;
  }

  const body = `${leadingDigit}${fractionDigits ? `.${casing(fractionDigits)}` : ''}`;
  return `${sign}${prefix}${body}${marker}${exponent < 0 ? '' : '+'}${exponent}`;
}
