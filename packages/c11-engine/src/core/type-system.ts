import { failure } from './internal.ts';
import type { AggregateDefinition, CType, FunctionCType, Location, PointerCType, ArrayCType, AggregateCType } from './internal.ts';

export const pointerTo = (base: CType, qualifiers: { const?: boolean; restrict?: boolean; baseConst?: boolean } = {}): PointerCType =>
  Object.freeze({ kind: 'pointer', base, ...qualifiers });
export const arrayOf = (element: CType, length: number | null): ArrayCType => Object.freeze({ kind: 'array', element, length });
export const functionOf = (returnType: CType, parameters: readonly CType[], variadic = false, prototype = true): FunctionCType =>
  Object.freeze({ kind: 'function', returnType, parameters: Object.freeze([...parameters]), ...(variadic ? { variadic: true } : {}), prototype });
export const aggregateRef = (id: number): AggregateCType => Object.freeze({ kind: 'aggregate', id });

export function isPointer(type: CType): type is PointerCType { return typeof type !== 'string' && type.kind === 'pointer'; }
export function isArray(type: CType): type is ArrayCType { return typeof type !== 'string' && type.kind === 'array'; }
export function isAggregate(type: CType): type is AggregateCType { return typeof type !== 'string' && type.kind === 'aggregate'; }
export function isFunction(type: CType): type is FunctionCType { return typeof type !== 'string' && type.kind === 'function'; }

const integerTypes = new Set<CType>([
  '_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long', 'long long', 'unsigned long long',
]);
export function isInteger(type: CType): boolean { return integerTypes.has(type); }
export function isArithmetic(type: CType): boolean { return isInteger(type) || type === 'float' || type === 'double'; }
export function isScalar(type: CType): boolean { return isArithmetic(type) || isPointer(type); }
export function isObject(type: CType): boolean { return type !== 'void' && !isFunction(type); }

export type AggregateContext = readonly AggregateDefinition[];
export const isComplete = (type: CType, aggregates: AggregateContext): boolean => {
  if (type === 'void' || isFunction(type)) return false;
  if (isPointer(type)) return true;
  if (isArray(type)) return type.length !== null && isComplete(type.element, aggregates);
  if (isAggregate(type)) return aggregates.some((definition) => definition.id === type.id && definition.complete);
  return true;
};
export function isModifiableObject(type: CType, aggregates: AggregateContext): boolean {
  return isObject(type) && !isArray(type) && !(isPointer(type) && type.const) && isComplete(type, aggregates);
}

const integerLayout: Record<string, { size: number; alignment: number; bits: number; rank: number; unsigned: boolean }> = {
  _Bool: { size: 1, alignment: 1, bits: 8, rank: 0, unsigned: true },
  char: { size: 1, alignment: 1, bits: 8, rank: 1, unsigned: false },
  'signed char': { size: 1, alignment: 1, bits: 8, rank: 1, unsigned: false },
  'unsigned char': { size: 1, alignment: 1, bits: 8, rank: 1, unsigned: true },
  short: { size: 2, alignment: 2, bits: 16, rank: 2, unsigned: false },
  'unsigned short': { size: 2, alignment: 2, bits: 16, rank: 2, unsigned: true },
  int: { size: 4, alignment: 4, bits: 32, rank: 3, unsigned: false },
  'unsigned int': { size: 4, alignment: 4, bits: 32, rank: 3, unsigned: true },
  long: { size: 8, alignment: 8, bits: 64, rank: 4, unsigned: false },
  'unsigned long': { size: 8, alignment: 8, bits: 64, rank: 4, unsigned: true },
  'long long': { size: 8, alignment: 8, bits: 64, rank: 5, unsigned: false },
  'unsigned long long': { size: 8, alignment: 8, bits: 64, rank: 5, unsigned: true },
};

export function scalarSize(type: CType): number {
  if (type === 'float') return 4;
  if (type === 'double') return 8;
  if (isPointer(type)) return 8;
  return typeof type === 'string' ? integerLayout[type]?.size ?? 0 : 0;
}
export function scalarAlignment(type: CType): number {
  if (type === 'float') return 4;
  if (type === 'double') return 8;
  if (isPointer(type)) return 8;
  return typeof type === 'string' ? integerLayout[type]?.alignment ?? 0 : 0;
}
export function integerInfo(type: CType) { return typeof type === 'string' ? integerLayout[type] : undefined; }

const fallbackLocation: Location = { file: 'main.c', line: 1, column: 1 };
const layingOut = new Set<number>();

export function layoutAggregate(definition: AggregateDefinition, aggregates: AggregateContext, at: Location = definition.location): void {
  if (!definition.complete) failure('INCOMPLETE_TYPE', `El tipo ${definition.kind} ${definition.tag ?? ''} todavía está incompleto.`, at);
  if (definition.size !== undefined && definition.alignment !== undefined) return;
  if (layingOut.has(definition.id)) failure('INCOMPLETE_TYPE', 'Un agregado no puede contenerse directamente a sí mismo por valor.', at);
  if (definition.members.length === 0) failure('TYPE_ERROR', 'Un struct o union debe declarar al menos un miembro con nombre.', at);
  layingOut.add(definition.id);
  try {
    let size = 0;
    let alignment = 1;
    for (const member of definition.members) {
      const memberSize = sizeOfType(member.type, aggregates, member.location);
      const memberAlignment = alignOfType(member.type, aggregates, member.location);
      alignment = Math.max(alignment, memberAlignment);
      if (definition.kind === 'union') {
        member.offset = 0;
        size = Math.max(size, memberSize);
      } else {
        size = alignUp(size, memberAlignment);
        member.offset = size;
        size += memberSize;
      }
    }
    definition.size = alignUp(size, alignment);
    definition.alignment = alignment;
  } finally { layingOut.delete(definition.id); }
}

const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;
function aggregateDefinition(type: AggregateCType, aggregates: AggregateContext, at: Location): AggregateDefinition {
  const definition = aggregates.find((item) => item.id === type.id);
  if (!definition || !definition.complete) failure('INCOMPLETE_TYPE', `El tipo agregado ${type.id} está incompleto.`, at);
  return definition;
}
export function sizeOfType(type: CType, aggregates: AggregateContext = [], at: Location = fallbackLocation): number {
  if (type === 'void' || isFunction(type)) failure('INCOMPLETE_TYPE', 'El tipo no tiene tamaño de objeto en C11.', at);
  if (isPointer(type)) return 8;
  if (isArray(type)) {
    if (type.length === null) failure('INCOMPLETE_TYPE', 'No se puede calcular sizeof de un array incompleto.', at);
    const stride = sizeOfType(type.element, aggregates, at);
    const size = stride * type.length;
    if (!Number.isSafeInteger(size)) failure('TYPE_SIZE_RANGE', 'El tamaño del objeto excede el perfil virtual representable.', at);
    return size;
  }
  if (isAggregate(type)) {
    const definition = aggregateDefinition(type, aggregates, at);
    layoutAggregate(definition, aggregates, at);
    return definition.size!;
  }
  const size = scalarSize(type);
  if (!size) failure('INCOMPLETE_TYPE', `El tipo «${String(type)}» no tiene tamaño de objeto.`, at);
  return size;
}
export function alignOfType(type: CType, aggregates: AggregateContext = [], at: Location = fallbackLocation): number {
  if (type === 'void' || isFunction(type)) failure('INCOMPLETE_TYPE', 'El tipo no tiene alineación de objeto en C11.', at);
  if (isPointer(type)) return 8;
  if (isArray(type)) return alignOfType(type.element, aggregates, at);
  if (isAggregate(type)) {
    const definition = aggregateDefinition(type, aggregates, at);
    layoutAggregate(definition, aggregates, at);
    return definition.alignment!;
  }
  const alignment = scalarAlignment(type);
  if (!alignment) failure('INCOMPLETE_TYPE', `El tipo «${String(type)}» no tiene alineación de objeto.`, at);
  return alignment;
}

export function decayType(type: CType): CType {
  if (isArray(type)) return pointerTo(type.element);
  if (isFunction(type)) return pointerTo(type);
  return type;
}

function sameTypeInner(left: CType, right: CType): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'pointer' && right.kind === 'pointer') return !!left.const === !!right.const && !!left.restrict === !!right.restrict && !!left.baseConst === !!right.baseConst && sameTypeInner(left.base, right.base);
  if (left.kind === 'array' && right.kind === 'array') return left.length === right.length && sameTypeInner(left.element, right.element);
  if (left.kind === 'aggregate' && right.kind === 'aggregate') return left.id === right.id;
  if (left.kind === 'function' && right.kind === 'function') {
    return left.variadic === right.variadic && left.prototype === right.prototype && left.parameters.length === right.parameters.length &&
      sameTypeInner(left.returnType, right.returnType) && left.parameters.every((parameter, index) => sameTypeInner(parameter, right.parameters[index]));
  }
  return false;
}
export function sameType(left: CType, right: CType): boolean { return sameTypeInner(left, right); }

export function compatibleType(left: CType, right: CType): boolean {
  if (sameTypeInner(left, right)) return true;
  if (isArray(left) && isArray(right)) return sameTypeInner(left.element, right.element) && (left.length === null || right.length === null || left.length === right.length);
  if (isPointer(left) && isPointer(right)) {
    return !!left.const === !!right.const && !!left.restrict === !!right.restrict && !!left.baseConst === !!right.baseConst &&
      compatibleType(left.base, right.base);
  }
  if (isFunction(left) && isFunction(right)) {
    if (!compatibleType(left.returnType, right.returnType)) return false;
    const leftHasPrototype = left.prototype !== false;
    const rightHasPrototype = right.prototype !== false;
    if (leftHasPrototype && rightHasPrototype) {
      return left.variadic === right.variadic && left.parameters.length === right.parameters.length &&
        left.parameters.every((parameter, index) => compatibleParameterType(parameter, right.parameters[index]));
    }
    if (!leftHasPrototype && !rightHasPrototype) return true;
    const prototype = leftHasPrototype ? left : right;
    if (prototype.variadic) return false;
    return prototype.parameters.every((parameter) => compatibleAfterDefaultPromotion(parameter));
  }
  return false;
}

function compatibleParameterType(left: CType, right: CType): boolean {
  const unqualified = (type: CType): CType => isPointer(type)
    ? pointerTo(type.base, { baseConst: type.baseConst })
    : type;
  return compatibleType(unqualified(left), unqualified(right));
}

function compatibleAfterDefaultPromotion(type: CType): boolean {
  if (type === 'float') return false;
  if (isInteger(type)) {
    const info = integerInfo(type)!;
    return info.rank >= integerInfo('int')!.rank || type === 'unsigned int';
  }
  return true;
}

export function compositeType(left: CType, right: CType): CType | undefined {
  if (sameTypeInner(left, right)) return left;
  if (isArray(left) && isArray(right) && sameTypeInner(left.element, right.element)) {
    return arrayOf(left.element, left.length ?? right.length);
  }
  if (isPointer(left) && isPointer(right)) {
    if (compatibleType(left, right)) return pointerTo(left.base, { baseConst: left.baseConst || right.baseConst });
    if (left.base === 'void' && isObject(right.base)) return pointerTo('void', { baseConst: left.baseConst || right.baseConst });
    if (right.base === 'void' && isObject(left.base)) return pointerTo('void', { baseConst: left.baseConst || right.baseConst });
  }
  if (compatibleType(left, right) && isFunction(left) && isFunction(right)) {
    const preferred = left.prototype === false ? right : left;
    return functionOf(preferred.returnType, preferred.parameters, !!preferred.variadic, preferred.prototype !== false);
  }
  return undefined;
}

/** C's implicit void-pointer conversion applies only to object pointers. */
export function canConvertPointerType(from: CType, to: CType): boolean {
  if (!isPointer(from) || !isPointer(to)) return false;
  if (from.baseConst && !to.baseConst) return false;
  if (compatibleType(from.base, to.base)) return true;
  if (from.base === 'void' && isObject(to.base)) return !from.baseConst || !!to.baseConst;
  if (to.base === 'void' && isObject(from.base)) return !from.baseConst || !!to.baseConst;
  return false;
}

export function typeName(type: CType, aggregates: AggregateContext = []): string {
  if (typeof type === 'string') return type;
  if (type.kind === 'pointer') return `${typeName(type.base, aggregates)} *${type.const ? ' const' : ''}${type.restrict ? ' restrict' : ''}`;
  if (type.kind === 'array') return `${typeName(type.element, aggregates)}[${type.length ?? ''}]`;
  if (type.kind === 'function') return `${typeName(type.returnType, aggregates)} (${type.prototype === false ? '' : type.parameters.map((item) => typeName(item, aggregates)).join(', ')}${type.variadic ? `${type.parameters.length ? ', ' : ''}...` : ''})`;
  const definition = aggregates.find((item) => item.id === type.id);
  return `${definition?.kind ?? 'aggregate'}${definition?.tag ? ` ${definition.tag}` : `#${type.id}`}`;
}
