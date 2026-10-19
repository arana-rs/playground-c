import type { AggregateDefinition, CType, FunctionCType, FunctionIR } from './internal.ts';
import {
  arrayOf, compatibleType, functionOf, isInteger, pointedToType, pointerTo, pointerType,
  qualifyType, qualifiersOf, unqualifiedType,
  type TypeCompatibilityContext,
} from './type-system.ts';
import { promote } from './numeric.ts';

function functionType(fn: FunctionIR): FunctionCType {
  return functionOf(fn.returnType, fn.parameters.map((parameter) => parameter.type), !!fn.variadic, fn.prototype !== false);
}

export function compatibleFunctionDeclarations(
  left: FunctionIR, right: FunctionIR, compatibilityContext: TypeCompatibilityContext,
): boolean {
  if (!compatibleType(functionType(left), functionType(right), compatibilityContext)) return false;
  for (const definition of [left, right]) {
    if (!definition.oldStyle || !definition.body) continue;
    const prototype = definition === left ? right : left;
    if (prototype.prototype === false) continue;
    if (definition.parameters.length !== prototype.parameters.length || prototype.variadic) return false;
    for (let index = 0; index < definition.parameters.length; index++) {
      const promoted = defaultArgumentType(definition.parameters[index].type);
      if (!compatibleType(
        unqualifiedParameter(promoted), unqualifiedParameter(prototype.parameters[index].type), compatibilityContext,
      )) return false;
    }
  }
  return true;
}

function defaultArgumentType(type: CType): CType {
  type = unqualifiedParameter(type);
  if (type === 'float') return 'double';
  if (isInteger(type)) return promote(type);
  return type;
}

function unqualifiedParameter(type: CType): CType {
  type = unqualifiedType(type);
  const pointer = pointerType(type);
  return pointer ? pointerTo(pointedToType(pointer) ?? pointer.base) : type;
}

export function unifyFunctionTypes(
  left: FunctionIR, right: FunctionIR, definitions: ReadonlyMap<number, AggregateDefinition>, unions: TypeUnions,
  enumUnions: TypeUnions, compatibilityContext: TypeCompatibilityContext,
): void {
  unifyTypes(left.returnType, right.returnType, definitions, unions, enumUnions, compatibilityContext);
  if (left.prototype !== false && right.prototype !== false) {
    left.parameters.forEach((parameter, index) => unifyTypes(
      unqualifiedParameter(parameter.type), unqualifiedParameter(right.parameters[index].type), definitions, unions, enumUnions,
      compatibilityContext,
    ));
  } else {
    const oldStyle = left.oldStyle && left.body ? left : right.oldStyle && right.body ? right : undefined;
    const prototype = left.prototype !== false ? left : right.prototype !== false ? right : undefined;
    if (oldStyle && prototype && oldStyle.parameters.length === prototype.parameters.length) {
      oldStyle.parameters.forEach((parameter, index) => unifyTypes(
        defaultArgumentType(parameter.type), prototype.parameters[index].type, definitions, unions, enumUnions, compatibilityContext,
      ));
    }
  }
}

export function unifyTypes(
  left: CType, right: CType, definitions: ReadonlyMap<number, AggregateDefinition>, unions: TypeUnions,
  enumUnions: TypeUnions, compatibilityContext: TypeCompatibilityContext, seen = new Set<string>(),
): void {
  if (!compatibleType(left, right, compatibilityContext)) return;
  left = unqualifiedType(left);
  right = unqualifiedType(right);
  if (typeof left === 'string' || typeof right === 'string' || left.kind !== right.kind) return;
  const pair = `${typeKey(left)}:${typeKey(right)}`;
  if (seen.has(pair)) return;
  seen.add(pair);
  if (left.kind === 'pointer' && right.kind === 'pointer') unifyTypes(left.base, right.base, definitions, unions, enumUnions, compatibilityContext, seen);
  else if (left.kind === 'array' && right.kind === 'array') unifyTypes(left.element, right.element, definitions, unions, enumUnions, compatibilityContext, seen);
  else if (left.kind === 'enum' && right.kind === 'enum') {
    if (left.id !== right.id) enumUnions.union(left.id, right.id);
  }
  else if (left.kind === 'aggregate' && right.kind === 'aggregate') {
    if (left.id === right.id) return;
    unions.union(left.id, right.id);
    const a = definitions.get(left.id), b = definitions.get(right.id);
    if (a?.complete && b?.complete) a.members.forEach((member, index) => unifyTypes(
      member.type, b.members[index].type, definitions, unions, enumUnions, compatibilityContext, seen,
    ));
  } else if (left.kind === 'function' && right.kind === 'function') {
    unifyTypes(left.returnType, right.returnType, definitions, unions, enumUnions, compatibilityContext, seen);
    if (left.parameters.length === right.parameters.length) left.parameters.forEach((parameter, index) => unifyTypes(
      parameter, right.parameters[index], definitions, unions, enumUnions, compatibilityContext, seen,
    ));
  }
}

function typeKey(type: CType): string {
  const qualifiers = qualifiersOf(type);
  const qualifierKey = `${qualifiers.const ? 'c' : ''}${qualifiers.volatile ? 'v' : ''}${qualifiers.restrict ? 'r' : ''}`;
  type = unqualifiedType(type);
  const prefix = qualifierKey ? `q${qualifierKey}:` : '';
  if (typeof type === 'string') return `${prefix}${type}`;
  if (type.kind === 'aggregate') return `${prefix}a${type.id}`;
  if (type.kind === 'enum') return `${prefix}e${type.id}`;
  if (type.kind === 'pointer') return `${prefix}p${type.baseConst ? 'b' : ''}${type.baseVolatile ? 'v' : ''}${typeKey(type.base)}`;
  if (type.kind === 'array') return `${prefix}y${type.length ?? ''}:${typeKey(type.element)}`;
  if (type.kind === 'function') return `${prefix}f${type.prototype === false ? 'n' : 'p'}${type.variadic ? 'v' : ''}:${typeKey(type.returnType)}:${type.parameters.map(typeKey).join(',')}`;
  return `${prefix}q${typeKey(type.base)}`;
}

export class TypeUnions {
  private readonly parents = new Map<number, number>();
  find(value: number): number {
    const parent = this.parents.get(value);
    if (parent === undefined) { this.parents.set(value, value); return value; }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents.set(value, root);
    return root;
  }
  union(left: number, right: number): void {
    const a = this.find(left), b = this.find(right);
    if (a === b) return;
    const canonical = Math.min(a, b), other = Math.max(a, b);
    this.parents.set(other, canonical);
  }
}

export function createTypeRewriter(
  typeUnions: TypeUnions,
  enumUnions: TypeUnions,
): (root: CType) => CType {
  const typeMemo = new Map<object, CType>();
  const rewriteType = (root: CType): CType => {
    if (typeof root === 'string') return root;
    const prior = typeMemo.get(root);
    if (prior) return prior;
    const pending: { type: Exclude<CType, string>; done: boolean }[] = [{ type: root, done: false }];
    while (pending.length) {
      const work = pending.pop()!;
      const type = work.type;
      if (typeMemo.has(type)) continue;
      if (!work.done) {
        pending.push({ type, done: true });
        if (type.kind === 'qualified') {
          if (typeof type.base !== 'string') pending.push({ type: type.base, done: false });
        } else if (type.kind === 'pointer') {
          if (typeof type.base !== 'string') pending.push({ type: type.base, done: false });
        } else if (type.kind === 'array') {
          if (typeof type.element !== 'string') pending.push({ type: type.element, done: false });
        } else if (type.kind === 'function') {
          if (typeof type.returnType !== 'string') pending.push({ type: type.returnType, done: false });
          for (const parameter of type.parameters) if (typeof parameter !== 'string') pending.push({ type: parameter, done: false });
        }
        continue;
      }
      if (type.kind === 'qualified') typeMemo.set(type, qualifyType(rewriteType(type.base), type.qualifiers));
      else if (type.kind === 'aggregate') typeMemo.set(type, { kind: 'aggregate', id: typeUnions.find(type.id) });
      else if (type.kind === 'enum') typeMemo.set(type, { ...type, id: enumUnions.find(type.id) });
      else if (type.kind === 'pointer') typeMemo.set(type, pointerTo(rewriteType(type.base), {
        ...(type.const === undefined ? {} : { const: type.const }),
        ...(type.volatile === undefined ? {} : { volatile: type.volatile }),
        ...(type.restrict === undefined ? {} : { restrict: type.restrict }),
        ...(type.baseConst === undefined ? {} : { baseConst: type.baseConst }),
        ...(type.baseVolatile === undefined ? {} : { baseVolatile: type.baseVolatile }),
      }));
      else if (type.kind === 'array') typeMemo.set(type, arrayOf(rewriteType(type.element), type.length, type.lengthExpression));
      else typeMemo.set(type, functionOf(rewriteType(type.returnType), type.parameters.map(rewriteType), !!type.variadic, type.prototype !== false));
    }
    return typeMemo.get(root)!;
  };

  return rewriteType;
}
