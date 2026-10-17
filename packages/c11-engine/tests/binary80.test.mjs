import assert from 'node:assert/strict';
import test from 'node:test';
import {
  binary80Add,
  binary80Compare,
  binary80Decode80,
  binary80Encode80,
  binary80FromNumber,
  binary80ToBinary32,
  binary80ToBinary64,
  binary80ToBigIntTrunc,
  binary80Truthy,
  decomposeBinary80,
  formatBinary80Hex,
  parseBinary80,
} from '../dist/core/binary80.js';

test('binary80 keeps the x87 64-bit significand beyond binary64 precision', () => {
  const one = parseBinary80('1.0L');
  const increment = parseBinary80('0x1p-63L');
  const sum = binary80Add(one, increment);

  assert.equal(binary80Compare(sum, one), 1);
  assert.deepEqual(decomposeBinary80(sum), {
    classification: 'finite', negative: false,
    significand: (1n << 63n) + 1n, exponent: -63,
  });
  assert.equal(binary80ToBinary64(sum), 1);
  assert.equal(formatBinary80Hex(sum), '0x1.0000000000000002p+0');
});

test('decimal and hexadecimal inputs round directly with nearest-even, including subnormals', () => {
  assert.equal(binary80Compare(parseBinary80('0x1.0000000000000001p0'), parseBinary80('1.0')), 0);
  assert.equal(binary80Compare(parseBinary80('0x1.0000000000000002p0'), parseBinary80('1.0')), 1);

  const leastSubnormal = parseBinary80('0x1p-16445L');
  const halfLeastSubnormal = parseBinary80('0x1p-16446L');
  const aboveHalf = parseBinary80('0x1.0000000000000001p-16446L');
  assert.deepEqual(decomposeBinary80(leastSubnormal), {
    classification: 'finite', negative: false, significand: 1n, exponent: -16445,
  });
  assert.equal(decomposeBinary80(halfLeastSubnormal).significand, 0n);
  assert.equal(decomposeBinary80(aboveHalf).significand, 1n);

  const tenth = parseBinary80('0.1L');
  assert.equal(binary80ToBigIntTrunc(tenth), 0n);
  assert.equal(binary80Compare(tenth, binary80FromNumber(0.1)), -1);

  const decimalScale = 10n ** 70n;
  const midpointNumerator = decimalScale + 5n ** 64n * 10n ** 6n;
  const decimal70 = (numerator) => `${numerator / decimalScale}.${(numerator % decimalScale).toString().padStart(70, '0')}`;
  assert.equal(binary80Compare(parseBinary80(decimal70(midpointNumerator)), parseBinary80('1.0')), 0);
  assert.equal(binary80Compare(parseBinary80(decimal70(midpointNumerator + 1n)), parseBinary80('1.0')), 1);

  const halfSubnormalScale = 16446;
  const halfSubnormalNumerator = 5n ** BigInt(halfSubnormalScale);
  const decimalHalf = (numerator) => {
    const digits = numerator.toString();
    return `0.${'0'.repeat(halfSubnormalScale - digits.length)}${digits}`;
  };
  assert.equal(decomposeBinary80(parseBinary80(decimalHalf(halfSubnormalNumerator))).significand, 0n);
  assert.equal(decomposeBinary80(parseBinary80(decimalHalf(halfSubnormalNumerator + 1n))).significand, 1n);
});

test('conversion to binary32 rounds from binary80 directly, not through binary64', () => {
  const value = binary80Add(
    binary80Add(parseBinary80('1.0L'), parseBinary80('0x1p-24L')),
    parseBinary80('0x1p-63L'),
  );
  assert.equal(binary80ToBinary32(value), 1 + 2 ** -23);
  assert.equal(Math.fround(binary80ToBinary64(value)), 1);
});

test('integer conversion preserves 64-bit boundaries and truncates toward zero', () => {
  const maximum = parseBinary80('18446744073709551615.0L');
  assert.equal(binary80ToBigIntTrunc(maximum), (1n << 64n) - 1n);
  assert.equal(binary80ToBigIntTrunc(parseBinary80('-9223372036854775808.0L')), -(1n << 63n));
  assert.equal(binary80ToBigIntTrunc(parseBinary80('-1.75L')), -1n);
});

test('signed zero, infinities, NaNs, and raw x87 payload round-trip', () => {
  const negativeZero = parseBinary80('-0.0L');
  assert.equal(binary80Truthy(negativeZero), false);
  assert.equal(decomposeBinary80(negativeZero).negative, true);
  assert.equal(binary80FromNumber(-0).negative, true);
  assert.equal(formatBinary80Hex(negativeZero), '-0x0p+0');

  const infinity = parseBinary80('-infinity');
  const nan = parseBinary80('-nan');
  assert.equal(decomposeBinary80(infinity).classification, 'infinity');
  assert.equal(decomposeBinary80(nan).classification, 'nan');
  assert.equal(binary80Compare(nan, nan), undefined);

  for (const original of [negativeZero, parseBinary80('0x1p-16445'), parseBinary80('1.0'), infinity, nan]) {
    const payload = binary80Encode80(original);
    const paddedStorage = new Uint8Array(16);
    paddedStorage.set(payload);
    const decoded = binary80Decode80(paddedStorage);
    assert.deepEqual(decomposeBinary80(decoded), decomposeBinary80(original));
  }
});

test('hex rendering uses nearest-even for explicit precision and preserves exact output', () => {
  assert.equal(formatBinary80Hex(parseBinary80('1.5L')), '0x1.8p+0');
  assert.equal(formatBinary80Hex(parseBinary80('1.5L'), 0), '0x1p+1');
  assert.equal(formatBinary80Hex(parseBinary80('1.25L'), 0), '0x1p+0');
  assert.equal(formatBinary80Hex(parseBinary80('-0.0L'), 4, true), '-0X0.0000P+0');
});
