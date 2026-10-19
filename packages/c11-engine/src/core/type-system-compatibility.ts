import type { AggregateDefinition, CType, EnumDefinition, TypeQualifiers } from './internal.ts';
import { aggregateType, arrayOf, arrayType, enumType, functionOf, functionType, isInteger, isObject, pointedToType, pointerTo, pointerType, qualifiersOf, qualifyType, unqualifiedType } from './type-system-core.ts';
import { integerInfo } from './type-system-layout.ts';
import type { AggregateContext, TypeCompatibilityContext } from './type-system-context.ts';

function getAggregateDefinitionForCompatibility(context: TypeCompatibilityContext | undefined, id: number): AggregateDefinition | undefined {
  const aggregates = context?.aggregates;
  if (!aggregates) return undefined;
  const byId = aggregates as ReadonlyMap<number, AggregateDefinition>;
  return typeof byId.get === 'function'
    ? byId.get(id)
    : (aggregates as AggregateContext).find((candidate) => candidate.id === id);
}

function getEnumDefinitionForCompatibility(context: TypeCompatibilityContext | undefined, id: number): EnumDefinition | undefined {
  const enums = context?.enums;
  if (!enums) return undefined;
  const byId = enums as ReadonlyMap<number, EnumDefinition>;
  return typeof byId.get === 'function'
    ? byId.get(id)
    : (enums as readonly EnumDefinition[]).find((candidate) => candidate.id === id);
}

function sameTypeInner(left: CType, right: CType): boolean {
  const leftQualifiers = qualifiersOf(left), rightQualifiers = qualifiersOf(right);
  if (!!leftQualifiers.const !== !!rightQualifiers.const || !!leftQualifiers.volatile !== !!rightQualifiers.volatile || !!leftQualifiers.restrict !== !!rightQualifiers.restrict) return false;
  left = unqualifiedType(left); right = unqualifiedType(right);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'pointer' && right.kind === 'pointer') return sameTypeInner(pointedToType(left)!, pointedToType(right)!);
  if (left.kind === 'array' && right.kind === 'array') {
    const sameLength = left.lengthExpression !== undefined || right.lengthExpression !== undefined
      ? left.length === null && right.length === null
      : left.length === right.length;
    return sameLength && sameTypeInner(left.element, right.element);
  }
  if (left.kind === 'aggregate' && right.kind === 'aggregate') return left.id === right.id;
  if (left.kind === 'enum' && right.kind === 'enum') return left.id === right.id;
  if (left.kind === 'function' && right.kind === 'function') {
    return left.variadic === right.variadic && left.prototype === right.prototype && left.parameters.length === right.parameters.length &&
      sameTypeInner(left.returnType, right.returnType) && left.parameters.every((parameter, index) => sameTypeInner(parameter, right.parameters[index]));
  }
  return false;
}
export function sameType(left: CType, right: CType): boolean { return sameTypeInner(left, right); }

export function compatibleType(left: CType, right: CType, context?: TypeCompatibilityContext): boolean {
  return compatibleTypeInner(left, right, context, new Set());
}

function compatibleTypeInner(
  left: CType, right: CType, context: TypeCompatibilityContext | undefined, seenAggregates: Set<string>,
): boolean {
  if (sameTypeInner(left, right)) return true;
  const leftQualifiers = qualifiersOf(left), rightQualifiers = qualifiersOf(right);
  if (!!leftQualifiers.const !== !!rightQualifiers.const || !!leftQualifiers.volatile !== !!rightQualifiers.volatile || !!leftQualifiers.restrict !== !!rightQualifiers.restrict) return false;
  left = unqualifiedType(left); right = unqualifiedType(right);
  const leftEnum = enumType(left), rightEnum = enumType(right);
  if (leftEnum && rightEnum) {
    if (leftEnum.id === rightEnum.id) return true;
    const leftDefinition = getEnumDefinitionForCompatibility(context, leftEnum.id);
    const rightDefinition = getEnumDefinitionForCompatibility(context, rightEnum.id);
    if (!leftDefinition || !rightDefinition || leftDefinition.translationUnit === rightDefinition.translationUnit ||
        leftDefinition.tag !== rightDefinition.tag || leftEnum.integerType !== rightEnum.integerType ||
        !leftDefinition.complete || !rightDefinition.complete || leftDefinition.enumerators.length !== rightDefinition.enumerators.length) return false;
    const rightMembers = new Map(rightDefinition.enumerators.map(({ name, value }) => [name, value]));
    return leftDefinition.enumerators.every(({ name, value }) => rightMembers.get(name) === value);
  }
  if (leftEnum && typeof right === 'string') return right === leftEnum.integerType;
  if (rightEnum && typeof left === 'string') return left === rightEnum.integerType;
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  const leftArray = arrayType(left), rightArray = arrayType(right);
  if (leftArray && rightArray) return compatibleTypeInner(leftArray.element, rightArray.element, context, seenAggregates) &&
    (leftArray.lengthExpression !== undefined || rightArray.lengthExpression !== undefined || leftArray.length === null || rightArray.length === null || leftArray.length === rightArray.length);
  if (pointerType(left) && pointerType(right)) {
    return compatibleTypeInner(pointedToType(left)!, pointedToType(right)!, context, seenAggregates);
  }
  if (typeof left !== 'string' && typeof right !== 'string' && left.kind === 'aggregate' && right.kind === 'aggregate') {
    if (left.id === right.id) return true;
    const key = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`;
    if (seenAggregates.has(key)) return true;
    const leftDefinition = getAggregateDefinitionForCompatibility(context, left.id);
    const rightDefinition = getAggregateDefinitionForCompatibility(context, right.id);
    if (!leftDefinition || !rightDefinition || leftDefinition.kind !== rightDefinition.kind ||
        !leftDefinition.tag || leftDefinition.tag !== rightDefinition.tag) return false;
    if (!leftDefinition.complete || !rightDefinition.complete) return true;
    if (leftDefinition.members.length !== rightDefinition.members.length) return false;
    seenAggregates.add(key);
    return leftDefinition.members.every((member, index) => {
      const other = rightDefinition.members[index];
      return member.name === other.name && !!member.isConst === !!other.isConst &&
        !!member.flexibleArray === !!other.flexibleArray && !!member.unnamedBitField === !!other.unnamedBitField &&
        (member.bitField?.width ?? null) === (other.bitField?.width ?? null) &&
        compatibleTypeInner(member.type, other.type, context, seenAggregates);
    });
  }
  const leftFunction = functionType(left), rightFunction = functionType(right);
  if (leftFunction && rightFunction) {
    if (!compatibleTypeInner(leftFunction.returnType, rightFunction.returnType, context, seenAggregates)) return false;
    const leftHasPrototype = leftFunction.prototype !== false;
    const rightHasPrototype = rightFunction.prototype !== false;
    if (leftHasPrototype && rightHasPrototype) {
      return leftFunction.variadic === rightFunction.variadic && leftFunction.parameters.length === rightFunction.parameters.length &&
        leftFunction.parameters.every((parameter, index) => compatibleParameterType(parameter, rightFunction.parameters[index], context, seenAggregates));
    }
    if (!leftHasPrototype && !rightHasPrototype) return true;
    const prototype = leftHasPrototype ? leftFunction : rightFunction;
    if (prototype.variadic) return false;
    return prototype.parameters.every((parameter) => compatibleAfterDefaultPromotion(parameter));
  }
  return false;
}

function compatibleParameterType(
  left: CType, right: CType, context: TypeCompatibilityContext | undefined, seenAggregates: Set<string>,
): boolean {
  return compatibleTypeInner(unqualifiedType(left), unqualifiedType(right), context, seenAggregates);
}

function compatibleAfterDefaultPromotion(type: CType): boolean {
  type = unqualifiedType(type);
  if (type === 'float') return false;
  if (isInteger(type)) {
    const info = integerInfo(type)!;
    return info.rank >= integerInfo('int')!.rank || type === 'unsigned int';
  }
  return true;
}

export function compositeType(left: CType, right: CType, context?: TypeCompatibilityContext): CType | undefined {
  if (sameTypeInner(left, right)) return left;
  // A composite type is only defined for compatible types. Conditional pointer
  // expressions have one additional rule for differently qualified pointed-to
  // types; keep that rule in conditionalPointerCompositeType below.
  if (!compatibleType(left, right, context)) return undefined;
  const qualifiers = qualifiersOf(left);
  left = unqualifiedType(left); right = unqualifiedType(right);
  if (enumType(left) && enumType(right)) return qualifyType(left, qualifiers);
  if (enumType(left) && typeof right === 'string' && right === enumType(left)!.integerType) return qualifyType(left, qualifiers);
  if (enumType(right) && typeof left === 'string' && left === enumType(right)!.integerType) return qualifyType(right, qualifiers);
  if (typeof left === 'string' || typeof right === 'string') {
    return left === right ? qualifyType(left, qualifiers) : undefined;
  }
  if (left.kind !== right.kind) return undefined;
  if (left.kind === 'aggregate' && right.kind === 'aggregate') {
    return left.id === right.id || context ? qualifyType(left, qualifiers) : undefined;
  }
  const leftArray = arrayType(left), rightArray = arrayType(right);
  if (leftArray && rightArray &&
      (leftArray.lengthExpression !== undefined || rightArray.lengthExpression !== undefined || leftArray.length === null || rightArray.length === null || leftArray.length === rightArray.length)) {
    const element = compositeType(leftArray.element, rightArray.element, context);
    if (element) return qualifyType(arrayOf(element, leftArray.length ?? rightArray.length,
      leftArray.lengthExpression ?? rightArray.lengthExpression), qualifiers);
  }
  const leftPointer = pointerType(left), rightPointer = pointerType(right);
  if (leftPointer && rightPointer) {
    const leftBase = pointedToType(left)!;
    const rightBase = pointedToType(right)!;
    const pointedComposite = compositeType(leftBase, rightBase, context);
    if (pointedComposite) return qualifyType(pointerTo(pointedComposite), qualifiers);
  }
  const leftFunction = functionType(left), rightFunction = functionType(right);
  if (compatibleType(left, right, context) && leftFunction && rightFunction) {
    const preferred = leftFunction.prototype === false ? rightFunction : leftFunction;
    return functionOf(preferred.returnType, preferred.parameters, !!preferred.variadic, preferred.prototype !== false);
  }
  return undefined;
}

/**
 * C11 6.5.15 has a special pointer result rule: qualifiers on the immediate
 * pointed-to types are unioned, while the remaining type structure must be
 * compatible. This deliberately rejects unsafe recursive cases such as
 * int ** versus const int **.
 */
export function conditionalPointerCompositeType(left: CType, right: CType): CType | undefined {
  const leftPointer = pointerType(left), rightPointer = pointerType(right);
  if (!leftPointer || !rightPointer) return undefined;
  const leftBase = pointedToType(left)!;
  const rightBase = pointedToType(right)!;
  const leftUnqualifiedBase = unqualifiedType(leftBase);
  const rightUnqualifiedBase = unqualifiedType(rightBase);
  if (compatibleType(leftUnqualifiedBase, rightUnqualifiedBase)) {
    const base = compositeType(leftUnqualifiedBase, rightUnqualifiedBase);
    if (base) return pointerTo(qualifyType(base, unionQualifiers(qualifiersOf(leftBase), qualifiersOf(rightBase))));
  }
  if (leftUnqualifiedBase === 'void' && isObject(rightBase)) {
    return pointerTo(qualifyType('void', unionQualifiers(qualifiersOf(leftBase), qualifiersOf(rightBase))));
  }
  if (rightUnqualifiedBase === 'void' && isObject(leftBase)) {
    return pointerTo(qualifyType('void', unionQualifiers(qualifiersOf(leftBase), qualifiersOf(rightBase))));
  }
  return undefined;
}

function unionQualifiers(left: TypeQualifiers, right: TypeQualifiers): TypeQualifiers {
  return {
    ...(left.const || right.const ? { const: true } : {}),
    ...(left.volatile || right.volatile ? { volatile: true } : {}),
    ...(left.restrict || right.restrict ? { restrict: true } : {}),
  };
}

/** C's implicit void-pointer conversion applies only to object pointers. */
export function canConvertPointerType(from: CType, to: CType): boolean {
  if (!pointerType(from) || !pointerType(to)) return false;
  const fromBase = pointedToType(from)!;
  const toBase = pointedToType(to)!;
  const fromQualifiers = qualifiersOf(fromBase), toQualifiers = qualifiersOf(toBase);
  if ((fromQualifiers.const && !toQualifiers.const) || (fromQualifiers.volatile && !toQualifiers.volatile) || (fromQualifiers.restrict && !toQualifiers.restrict)) return false;
  const sameAfterTopQualification = compatibleType(unqualifiedType(fromBase), unqualifiedType(toBase));
  if (sameAfterTopQualification) return true;
  return unqualifiedType(fromBase) === 'void' && isObject(toBase) ||
    unqualifiedType(toBase) === 'void' && isObject(fromBase);
}

export function typeName(type: CType, aggregates: AggregateContext = []): string {
  const qualifiers = qualifiersOf(type);
  const base = unqualifiedType(type);
  if (qualifiers.const || qualifiers.volatile || qualifiers.restrict) {
    const suffix = [qualifiers.const ? 'const' : '', qualifiers.volatile ? 'volatile' : '', qualifiers.restrict ? 'restrict' : ''].filter(Boolean).join(' ');
    if (pointerType(base)) return `${typeName(base, aggregates)} ${suffix}`;
    return `${suffix} ${typeName(base, aggregates)}`;
  }
  type = base;
  if (typeof type === 'string') return type;
  const pointer = pointerType(type);
  if (pointer) return `${typeName(pointedToType(pointer)!, aggregates)} *`;
  const array = arrayType(type);
  if (array) return `${typeName(array.element, aggregates)}[${array.lengthExpression ? 'VLA' : array.length ?? ''}]`;
  const fn = functionType(type);
  if (fn) return `${typeName(fn.returnType, aggregates)} (${fn.prototype === false ? '' : fn.parameters.map((item) => typeName(item, aggregates)).join(', ')}${fn.variadic ? `${fn.parameters.length ? ', ' : ''}...` : ''})`;
  const enumeration = enumType(type);
  if (enumeration) return `${enumeration.tag ? `enum ${enumeration.tag}` : `enum#${enumeration.id}`}`;
  const aggregate = aggregateType(type)!;
  const definition = aggregates.find((item) => item.id === aggregate.id);
  return `${definition?.kind ?? 'aggregate'}${definition?.tag ? ` ${definition.tag}` : `#${aggregate.id}`}`;
}
