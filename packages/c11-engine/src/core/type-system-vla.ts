import type { ArrayCType, CType } from './internal.ts';
import { arrayType, functionType, pointerTo, unqualifiedType } from './type-system-core.ts';

export function decayType(type: CType): CType {
  const array = arrayType(type);
  if (array) return pointerTo(array.element);
  const fn = functionType(type);
  if (fn) return pointerTo(fn);
  return type;
}

/** True when the outermost array has a runtime bound. */
export function isVariableLengthArray(type: CType): boolean {
  const array = arrayType(type);
  return !!array && array.length === null && array.lengthExpression !== undefined;
}

/** True when a type contains any VLA bound, including through pointers and function types. */
export function hasVariableLengthBound(type: CType): boolean {
  type = unqualifiedType(type);
  if (typeof type === 'string') return false;
  if (type.kind === 'array') return type.lengthExpression !== undefined || hasVariableLengthBound(type.element);
  if (type.kind === 'pointer') return hasVariableLengthBound(type.base);
  if (type.kind === 'function') return hasVariableLengthBound(type.returnType) || type.parameters.some(hasVariableLengthBound);
  return false;
}

/** Return each VLA array layer in declarator order, including dimensions under pointers. */
export function variableLengthArrayTypes(type: CType): readonly ArrayCType[] {
  const arrays: ArrayCType[] = [];
  const seen = new Set<object>();
  const pending = [type];
  while (pending.length) {
    const current = unqualifiedType(pending.pop()!);
    if (typeof current === 'string' || seen.has(current)) continue;
    seen.add(current);
    if (current.kind === 'array') {
      if (current.lengthExpression) arrays.push(current);
      pending.push(current.element);
    } else if (current.kind === 'pointer') pending.push(current.base);
    else if (current.kind === 'function') {
      for (let index = current.parameters.length - 1; index >= 0; index--) pending.push(current.parameters[index]);
      pending.push(current.returnType);
    }
  }
  return arrays;
}

/** True when sizeof this type needs a runtime size; pointers to VLAs still have a fixed size. */
export function hasVariableLengthObjectSize(type: CType): boolean {
  const array = arrayType(type);
  return !!array && (array.lengthExpression !== undefined || hasVariableLengthObjectSize(array.element));
}
