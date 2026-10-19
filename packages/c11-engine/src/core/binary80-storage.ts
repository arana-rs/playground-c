import {
  BINARY80_PROFILE, INTEGER_BIT, MIN_SUBNORMAL_EXPONENT, QUIET_NAN,
  binary80Infinity, binary80NaN, binary80Zero, value, assertBinary80,
} from './binary80-value.ts';
import type { Binary80Value } from './binary80-value.ts';

/** Raw 80-bit x87 payload, little-endian: 64-bit significand then sign/exponent. */
export function binary80Encode80(input: Binary80Value): Uint8Array {
  const checked = assertBinary80(input);
  let significand: bigint;
  let exponentField: number;
  if (checked.classification === 'infinity') {
    significand = INTEGER_BIT;
    exponentField = 0x7fff;
  } else if (checked.classification === 'nan') {
    significand = QUIET_NAN;
    exponentField = 0x7fff;
  } else if (checked.significand === 0n) {
    significand = 0n;
    exponentField = 0;
  } else {
    const unbiasedExponent = checked.exponent + 63;
    if (checked.significand < INTEGER_BIT) {
      significand = checked.significand;
      exponentField = 0;
    } else {
      exponentField = unbiasedExponent + BINARY80_PROFILE.bias;
      if (exponentField <= 0 || exponentField >= 0x7fff) throw new RangeError('binary80 exponent out of range.');
      significand = checked.significand;
    }
  }

  const result = new Uint8Array(10);
  for (let index = 0; index < 8; index++) result[index] = Number((significand >> BigInt(index * 8)) & 0xffn);
  const signExponent = BigInt(exponentField | (checked.negative ? 0x8000 : 0));
  result[8] = Number(signExponent & 0xffn);
  result[9] = Number((signExponent >> 8n) & 0xffn);
  return result;
}

/** Decode a raw x87 80-bit payload (or the first ten bytes of 16-byte storage). */
export function binary80Decode80(input: ArrayLike<number>): Binary80Value {
  if (input.length < 10) throw new RangeError('The binary80 payload requires at least 10 bytes.');
  let significand = 0n;
  for (let index = 0; index < 8; index++) significand |= BigInt(input[index] & 0xff) << BigInt(index * 8);
  const signExponent = (input[8] & 0xff) | ((input[9] & 0xff) << 8);
  const negative = (signExponent & 0x8000) !== 0;
  const exponentField = signExponent & 0x7fff;

  if (exponentField === 0x7fff) {
    if (significand === INTEGER_BIT) return binary80Infinity(negative);
    return binary80NaN(negative);
  }
  if (exponentField === 0) {
    if (significand === 0n) return binary80Zero(negative);
    // Pseudo-denormals have the same value as the corresponding least normal.
    return value('finite', negative, significand, MIN_SUBNORMAL_EXPONENT);
  }
  if (significand < INTEGER_BIT) {
    // x87's unnormal encodings are not valid finite C values.
    return binary80NaN(negative);
  }
  return value('finite', negative, significand, exponentField - BINARY80_PROFILE.bias - 63);
}
