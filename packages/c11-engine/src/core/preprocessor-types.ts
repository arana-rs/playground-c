import type { SyntaxKind } from '../syntax.ts';
import type { Location, Token } from './internal.ts';
import type { EngineMetrics, PrepareLimits } from './types.ts';

export interface PreprocessedUnit {
  readonly name: string;
  readonly tokens: Token[];
}

export interface PPToken {
  kind: SyntaxKind | 'header';
  text: string;
  spelling: string;
  at: Location;
  /** Physical source span survives #line remapping and macro substitution. */
  physicalFile?: string;
  physicalOffset?: number;
  physicalEndOffset?: number;
  physicalEndLine?: number;
  physicalEndColumn?: number;
  endAt?: Location;
  expansionSite?: Location;
  physicalLine: number;
  physicalColumn: number;
  logicalStart: number;
  logicalEnd: number;
  leadingSpace: boolean;
  hideSet?: ReadonlySet<string>;
  placemarker?: boolean;
}

export interface PPLine { readonly number: number; readonly tokens: PPToken[] }
export interface Macro { readonly name: string; readonly parameters?: readonly string[]; readonly variadic: boolean; readonly replacement: readonly PPToken[]; readonly at: Location }
export interface PPContext {
  readonly macros: Map<string, Macro>;
  readonly files: ReadonlyMap<string, string>;
  readonly onceFiles: Set<string>;
  readonly limits: PrepareLimits;
  readonly metrics: EngineMetrics;
  readonly captureSourceSpans: boolean;
  readonly dateText: string;
  readonly timeText: string;
}
export interface Conditional { readonly parentActive: boolean; active: boolean; branchTaken: boolean; sawElse: boolean; readonly at: Location }
export interface MappedSource {
  readonly text: string;
  readonly physicalOffsets: readonly number[];
  readonly physicalEnds: readonly number[];
  readonly eofOffset: number;
}

export interface PPValue { readonly value: bigint; readonly unsigned: boolean }
export type PPExpression =
  | { readonly kind: 'value'; readonly value: PPValue }
  | { readonly kind: 'unary'; readonly operator: string; readonly operand: PPExpression; readonly at: Location }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: PPExpression; readonly right: PPExpression; readonly at: Location }
  | { readonly kind: 'conditional'; readonly condition: PPExpression; readonly then: PPExpression; readonly otherwise: PPExpression; readonly at: Location };
