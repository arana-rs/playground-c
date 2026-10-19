import type { AggregateDefinition, EnumDefinition } from './internal.ts';

export type AggregateContext = readonly AggregateDefinition[];
export type EnumContext = readonly EnumDefinition[] | ReadonlyMap<number, EnumDefinition>;
export interface TypeCompatibilityContext {
  readonly aggregates: AggregateContext | ReadonlyMap<number, AggregateDefinition>;
  readonly enums?: EnumContext;
}
