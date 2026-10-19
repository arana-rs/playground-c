import type { AggregateDefinition, CType, FunctionIR, GlobalObject, ParsedProgram } from './internal.ts';
import { isModifiableObject, qualifiersOf, unqualifiedType } from './type-system.ts';

export type UnitWork = { parsed: ParsedProgram; synthetic?: FunctionIR };
export type FunctionDeclaration = { unit: number; fn: FunctionIR };
export type GlobalDeclaration = { unit: number; global: GlobalObject };
export type SymbolGroup<T> = { key: string; declarations: T[] };

export function symbolKey(linkage: FunctionIR['linkage'] | GlobalObject['linkage'], unit: string, name: string): string {
  return linkage === 'internal' ? `internal:${unit}:${name}` : `external:${name}`;
}

export function isExternalFunctionDefinition(
  definition: FunctionDeclaration,
  group: SymbolGroup<FunctionDeclaration>,
): boolean {
  if (definition.fn.linkage === 'internal') return true;
  const declarationsInUnit = group.declarations.filter((item) => item.unit === definition.unit);
  const isInlineDefinition = declarationsInUnit.length > 0 && declarationsInUnit.every(({ fn }) => fn.inline && !fn.extern);
  return !isInlineDefinition;
}

export function isModifiableInlineStaticObject(type: CType, aggregates: readonly AggregateDefinition[]): boolean {
  if (qualifiersOf(type).const) return false;
  const base = unqualifiedType(type);
  if (typeof base !== 'string' && base.kind === 'array') {
    return isModifiableInlineStaticObject(base.element, aggregates);
  }
  if (typeof base !== 'string' && base.kind === 'aggregate') {
    const definition = aggregates.find((candidate) => candidate.id === base.id);
    return !!definition?.complete && definition.members.some((member) => isModifiableInlineStaticObject(member.type, aggregates));
  }
  return isModifiableObject(type, aggregates);
}

export function groupByKey<T>(groups: Map<string, SymbolGroup<T>>, key: string): SymbolGroup<T> {
  let group = groups.get(key);
  if (!group) { group = { key, declarations: [] }; groups.set(key, group); }
  return group;
}
