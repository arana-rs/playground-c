/** Exact conversion from a C floating subject sequence to binary32/binary64. */
export type BinaryFloatFormat = 32 | 64;

const DECIMAL_FLOAT = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan(?:\([a-z0-9_]*\))?)$/i;
const HEXADECIMAL_FLOAT = /^[+-]?0[xX](?:(?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP][+-]?\d+$/;

/** Parse one complete decimal or hexadecimal floating subject into its target format. */
export function parseFloatingToken(token: string, format: BinaryFloatFormat): number | undefined {
  if (!DECIMAL_FLOAT.test(token) && !HEXADECIMAL_FLOAT.test(token)) return undefined;
  if (/^[+-]?inf(?:inity)?$/i.test(token)) return token.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan(?:\([a-z0-9_]*\))?$/i.test(token)) return token.startsWith('-') ? -NaN : NaN;
  if (/^[-+]?0x/i.test(token)) return roundHexToBinary(token, format);
  return format === 32 ? roundDecimalToBinary32(token) : Number(token);
}

function roundHexToBinary(token: string, bits: BinaryFloatFormat): number | undefined {
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

  // Remove trailing zeroes before forming powers of five. The decimal value
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
