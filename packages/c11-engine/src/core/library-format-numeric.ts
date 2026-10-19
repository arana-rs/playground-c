import type { CValue, Location } from './internal.ts';
import { binary80FromNumber, binary80ToRational, formatBinary80Hex } from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import type { LibraryRuntimeContext } from './library.ts';

export function asBinary80(value: CValue): Binary80Value | undefined {
  if (typeof value.value !== 'object' || value.value === null) return undefined;
  const candidate = value.value as unknown as Partial<Binary80Value>;
  return candidate.kind === 'binary80' ? candidate as Binary80Value : undefined;
}

export function formatHexFloatValue(
  value: CValue,
  longDouble: Binary80Value | undefined,
  precision: number | undefined,
  alternate: boolean,
  uppercase: boolean,
  context: LibraryRuntimeContext,
  at: Location,
): { prefix: string; digits: string; negative: boolean; finite: boolean } {
  const binary = longDouble ?? binary80FromNumber(
    typeof value.value === 'number' ? value.value : typeof value.value === 'bigint' ? Number(value.value) : NaN,
  );
  const rendered = formatBinary80Hex(binary, precision, uppercase);
  const negative = rendered.startsWith('-');
  let unsigned = negative ? rendered.slice(1) : rendered;
  const finite = binary.classification === 'finite';
  if (alternate && finite && !unsigned.includes('.')) {
    const markerIndex = unsigned.search(/[pP]/);
    unsigned = markerIndex < 0 ? `${unsigned}.` : `${unsigned.slice(0, markerIndex)}.${unsigned.slice(markerIndex)}`;
  }
  const prefix = unsigned.startsWith('0x') || unsigned.startsWith('0X') ? unsigned.slice(0, 2) : '';
  const digits = prefix ? unsigned.slice(2) : unsigned;
  void context; void at;
  return { prefix, digits, negative, finite };
}

export function formatBinary80Decimal(
  value: Binary80Value,
  conversion: 'f' | 'e' | 'g',
  precision: number,
  alternate: boolean,
): { digits: string; negative: boolean; finite: boolean } {
  if (value.classification !== 'finite') {
    return { digits: value.classification === 'nan' ? 'nan' : 'inf', negative: value.negative, finite: false };
  }
  if (conversion === 'g') precision = decimalPrecisionForFormat(value, conversion, precision, alternate);
  const { numerator, denominator, negative } = binary80ToRational(value);
  if (numerator === 0n) {
    if (conversion === 'f') return { digits: precision === 0 ? alternate ? '0.' : '0' : `0.${'0'.repeat(precision)}`, negative, finite: true };
    if (conversion === 'e') return { digits: `${precision === 0 ? alternate ? '0.' : '0' : `0.${'0'.repeat(precision)}`}e+00`, negative, finite: true };
    const count = precision === 0 ? 1 : precision;
    const digits = alternate && count > 1 ? `0.${'0'.repeat(count - 1)}` : alternate ? '0.' : '0';
    return { digits, negative, finite: true };
  }
  if (conversion === 'f') return { digits: formatRationalFixed(numerator, denominator, precision, alternate), negative, finite: true };
  if (conversion === 'e') return { digits: formatRationalScientific(numerator, denominator, precision, alternate), negative, finite: true };

  const significantDigits = precision;
  const rounded = roundedSignificand(numerator, denominator, significantDigits);
  const useScientific = rounded.exponent < -4 || rounded.exponent >= significantDigits;
  if (useScientific) {
    const coefficient = rounded.coefficient.toString().padStart(significantDigits, '0');
    let fraction = coefficient.slice(1);
    if (!alternate) fraction = fraction.replace(/0+$/, '');
    const mantissa = fraction.length ? `${coefficient[0]}.${fraction}` : alternate ? `${coefficient[0]}.` : coefficient[0];
    return { digits: `${mantissa}e${rounded.exponent < 0 ? '-' : '+'}${String(Math.abs(rounded.exponent)).padStart(2, '0')}`, negative, finite: true };
  }
  const decimalPosition = rounded.exponent + 1;
  const coefficient = rounded.coefficient.toString().padStart(significantDigits, '0');
  let whole: string, fraction: string;
  if (decimalPosition >= significantDigits) {
    whole = coefficient + '0'.repeat(decimalPosition - significantDigits); fraction = '';
  } else if (decimalPosition > 0) {
    whole = coefficient.slice(0, decimalPosition); fraction = coefficient.slice(decimalPosition);
  } else {
    whole = '0'; fraction = '0'.repeat(-decimalPosition) + coefficient;
  }
  if (!alternate) fraction = fraction.replace(/0+$/, '');
  const digits = fraction.length ? `${whole}.${fraction}` : alternate ? `${whole}.` : whole;
  return { digits, negative, finite: true };
}

export function decimalPrecisionForFormat(
  value: Binary80Value,
  conversion: 'f' | 'e' | 'g',
  requestedPrecision: number,
  alternate: boolean,
): number {
  if (conversion !== 'g') return requestedPrecision;
  const precision = Math.max(1, requestedPrecision);
  if (alternate || value.classification !== 'finite') return precision;
  if (value.significand === 0n) return 1;
  const { numerator, denominator } = binary80ToRational(value);
  return Math.min(precision, exactDecimalSignificantDigits(numerator, denominator));
}

function exactDecimalSignificantDigits(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 1;
  const denominatorBits = denominator.toString(2).length - 1;
  const coefficient = numerator * 5n ** BigInt(denominatorBits);
  const significant = coefficient.toString().replace(/0+$/, '');
  return Math.max(1, significant.length);
}

export function decimalFormatWorkLowerBound(
  value: Binary80Value,
  conversion: 'f' | 'e' | 'g',
  precision: number,
  alternate: boolean,
): number {
  if (value.classification !== 'finite') return 3;
  if (conversion === 'f') return 1 + precision + (precision > 0 || alternate ? 1 : 0);
  if (conversion === 'e') return 5 + precision + (precision === 0 && alternate ? 1 : 0);
  return Math.max(1, precision);
}

function formatRationalFixed(numerator: bigint, denominator: bigint, precision: number, alternate: boolean): string {
  const rounded = roundRationalScaled(numerator, denominator, precision);
  if (precision === 0) return alternate ? `${rounded}.` : String(rounded);
  const digits = rounded.toString().padStart(precision + 1, '0');
  return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}

function formatRationalScientific(numerator: bigint, denominator: bigint, precision: number, alternate: boolean): string {
  let exponent = floorLog10Rational(numerator, denominator);
  let rounded = roundRationalScaled(numerator, denominator, precision - exponent);
  const carry = 10n ** BigInt(precision + 1);
  if (rounded >= carry) { rounded /= 10n; exponent++; }
  const digits = rounded.toString().padStart(precision + 1, '0');
  const fraction = digits.slice(1);
  const mantissa = precision === 0
    ? alternate ? `${digits[0]}.` : digits[0]
    : `${digits[0]}.${fraction}`;
  return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

function roundedSignificand(numerator: bigint, denominator: bigint, precision: number): { exponent: number; coefficient: bigint } {
  let exponent = floorLog10Rational(numerator, denominator);
  let coefficient = roundRationalScaled(numerator, denominator, precision - 1 - exponent);
  if (coefficient >= 10n ** BigInt(precision)) { coefficient /= 10n; exponent++; }
  return { exponent, coefficient };
}

function floorLog10Rational(numerator: bigint, denominator: bigint): number {
  let exponent = numerator.toString().length - denominator.toString().length;
  if (exponent >= 0) {
    if (numerator < denominator * 10n ** BigInt(exponent)) exponent--;
  } else if (numerator * 10n ** BigInt(-exponent) < denominator) exponent--;
  return exponent;
}

function roundRationalScaled(numerator: bigint, denominator: bigint, decimalScale: number): bigint {
  let scaledNumerator = numerator, scaledDenominator = denominator;
  if (decimalScale >= 0) scaledNumerator *= 10n ** BigInt(decimalScale);
  else scaledDenominator *= 10n ** BigInt(-decimalScale);
  const quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const twice = remainder * 2n;
  return twice > scaledDenominator || twice === scaledDenominator && (quotient & 1n) === 1n ? quotient + 1n : quotient;
}
