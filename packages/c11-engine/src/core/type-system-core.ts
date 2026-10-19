import type { AggregateCType, ArrayCType, CType, EnumCType, EnumDefinition, Expression, FunctionCType, PointerCType, TypeQualifiers } from './internal.ts';

export const pointerTo = (base: CType, qualifiers: { const?: boolean; volatile?: boolean; restrict?: boolean; baseConst?: boolean; baseVolatile?: boolean } = {}): PointerCType =>
  Object.freeze({ kind: 'pointer', base, ...qualifiers });
export const arrayOf = (element: CType, length: number | null, lengthExpression?: Expression): ArrayCType => Object.freeze({
  kind: 'array', element, length,
  ...(lengthExpression === undefined ? {} : { lengthExpression }),
});
export const functionOf = (returnType: CType, parameters: readonly CType[], variadic = false, prototype = true): FunctionCType =>
  Object.freeze({ kind: 'function', returnType, parameters: Object.freeze([...parameters]), ...(variadic ? { variadic: true } : {}), prototype });
export const aggregateRef = (id: number): AggregateCType => Object.freeze({ kind: 'aggregate', id });
export const enumRef = (definition: EnumDefinition): EnumCType =>
  Object.freeze({ kind: 'enum', id: definition.id, tag: definition.tag, integerType: definition.integerType, definition });

export function unqualifiedType(type: CType): CType {
  while (typeof type !== 'string' && type.kind === 'qualified') type = type.base;
  return type;
}

export function qualifiersOf(type: CType): TypeQualifiers {
  const qualifiers: { const?: boolean; volatile?: boolean; restrict?: boolean } = {};
  while (typeof type !== 'string' && type.kind === 'qualified') {
    qualifiers.const ||= type.qualifiers.const;
    qualifiers.volatile ||= type.qualifiers.volatile;
    qualifiers.restrict ||= type.qualifiers.restrict;
    type = type.base;
  }
  if (typeof type !== 'string' && type.kind === 'pointer') {
    qualifiers.const ||= type.const;
    qualifiers.volatile ||= type.volatile;
    qualifiers.restrict ||= type.restrict;
  }
  return qualifiers;
}

export function qualifyType(type: CType, qualifiers: TypeQualifiers): CType {
  const next = {
    ...(qualifiersOf(type).const || qualifiers.const ? { const: true } : {}),
    ...(qualifiersOf(type).volatile || qualifiers.volatile ? { volatile: true } : {}),
    ...(qualifiersOf(type).restrict || qualifiers.restrict ? { restrict: true } : {}),
  };
  if (!next.const && !next.volatile && !next.restrict) return type;
  const base = unqualifiedType(type);
  // C applies array qualifiers to its element type.
  if (typeof base !== 'string' && base.kind === 'array') {
    return arrayOf(qualifyType(base.element, next), base.length, base.lengthExpression);
  }
  return Object.freeze({ kind: 'qualified', base, qualifiers: Object.freeze(next) });
}

export function pointerType(type: CType): PointerCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'pointer' ? unqualified : undefined;
}
export function arrayType(type: CType): ArrayCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'array' ? unqualified : undefined;
}
export function aggregateType(type: CType): AggregateCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'aggregate' ? unqualified : undefined;
}
export function enumType(type: CType): EnumCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'enum' ? unqualified : undefined;
}
export function functionType(type: CType): FunctionCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'function' ? unqualified : undefined;
}

/** Resolve a pointer's designated type, including legacy baseConst/baseVolatile metadata. */
export function pointedToType(type: CType): CType | undefined {
  const pointer = pointerType(type);
  if (!pointer) return undefined;
  return qualifyType(pointer.base, {
    ...(pointer.baseConst ? { const: true } : {}),
    ...(pointer.baseVolatile ? { volatile: true } : {}),
  });
}

// These are semantic predicates, not TypeScript narrowing predicates: a qualified type
// remains a QualifiedCType and must be unwrapped before accessing structural fields.
export function isPointer(type: CType): boolean { return pointerType(type) !== undefined; }
export function isArray(type: CType): boolean { return arrayType(type) !== undefined; }
export function isAggregate(type: CType): boolean { return aggregateType(type) !== undefined; }
export function isFunction(type: CType): boolean { return functionType(type) !== undefined; }

const integerTypes = new Set<CType>([
  '_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long', 'long long', 'unsigned long long',
]);
export function isInteger(type: CType): boolean { return integerTypes.has(unqualifiedType(type)) || enumType(type) !== undefined; }
export function isArithmetic(type: CType): boolean {
  const unqualified = unqualifiedType(type);
  return isInteger(unqualified) || unqualified === 'float' || unqualified === 'double' || unqualified === 'long double';
}
export function isScalar(type: CType): boolean { return isArithmetic(type) || isPointer(type); }
export function isObject(type: CType): boolean { return unqualifiedType(type) !== 'void' && !isFunction(type); }
