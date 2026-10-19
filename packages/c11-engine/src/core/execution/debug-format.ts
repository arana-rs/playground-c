import { formatBinary80Hex } from '../binary80.ts';
import type { AggregateDefinition, CValue, ObjectScalarValue } from '../internal.ts';
import {
  aggregateType, arrayType, enumType, functionType, pointerType, pointedToType, qualifiersOf,
  unqualifiedType,
} from '../type-system.ts';

export const DEFAULT_DEBUG_EVENT_BUDGET = 100_000;
export const MAX_HEAP_ADDRESS_SEED = 0xffff_ffff;

export function heapAddressRandomForSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function debugTypeSummary(type: CValue['type'], aggregates: readonly AggregateDefinition[]): string {
  if (typeof type === 'string') return type;
  const unqualified = unqualifiedType(type);
  const qualifiers = qualifiersOf(type);
  const qualifierText = [qualifiers.const && 'const', qualifiers.volatile && 'volatile', qualifiers.restrict && 'restrict']
    .filter(Boolean).join(' ');
  if (typeof unqualified === 'string') return `${qualifierText ? `${qualifierText} ` : ''}${unqualified}`;
  const pointer = pointerType(unqualified);
  if (pointer) return `${debugTypeSummary(pointedToType(unqualified)!, aggregates)} *${qualifierText ? ` ${qualifierText}` : ''}`;
  const array = arrayType(unqualified);
  if (array) return `${debugTypeSummary(array.element, aggregates)}[${array.length ?? ''}]`;
  const enumeration = enumType(unqualified);
  if (enumeration) return `${qualifierText ? `${qualifierText} ` : ''}enum ${enumeration.tag ?? `<anonymous ${enumeration.id}>`}`;
  const aggregateTypeValue = aggregateType(unqualified);
  if (aggregateTypeValue) {
    const aggregate = aggregates.find((candidate) => candidate.id === aggregateTypeValue.id);
    return `${qualifierText ? `${qualifierText} ` : ''}${aggregate?.kind ?? 'aggregate'} ${aggregate?.tag ?? `<anonymous ${aggregateTypeValue.id}>`}`;
  }
  const fn = functionType(unqualified);
  return fn ? `function (${fn.parameters.map((parameter) => debugTypeSummary(parameter, aggregates)).join(', ')})` : 'unknown';
}

export function debugEscapedByte(byte: number, context: 'character' | 'string'): string {
  if (byte === 0) return context === 'string' ? '\\000' : '\\0';
  if (byte === 34 && context === 'string') return '\\"';
  if (byte === 39 && context === 'character') return "\\'";
  const escapes: Readonly<Record<number, string>> = {
    7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r',
    92: '\\\\',
  };
  const escaped = escapes[byte];
  if (escaped) return escaped;
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  return context === 'string'
    ? '\\' + byte.toString(8).padStart(3, '0')
    : '\\x' + byte.toString(16).padStart(2, '0').toUpperCase();
}

export function debugScalarValue(type: CValue['type'], value: ObjectScalarValue): string {
  type = unqualifiedType(type);
  if (type === 'long double' && typeof value === 'object' && value !== null && value.kind === 'binary80') {
    return formatBinary80Hex(value);
  }
  if (type === '_Bool') return value === 0n || value === 0 ? '0' : '1';
  if (type === 'char' || type === 'signed char' || type === 'unsigned char') {
    if (typeof value !== 'bigint') return '?';
    const byte = Number(BigInt.asUintN(8, value));
    return "'" + debugEscapedByte(byte, 'character') + "'";
  }
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value !== 'number') return '?';
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Object.is(value, -0)) return '-0';
  return value.toString();
}

export function debugStringLiteral(bytes: readonly number[]): string {
  return '"' + bytes.map((byte) => debugEscapedByte(byte, 'string')).join('') + '"';
}
