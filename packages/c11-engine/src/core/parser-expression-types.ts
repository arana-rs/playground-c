import type { Expression, Token } from './internal.ts';

export type ExpressionValue = { expression: Expression; depth: number };
export type ExpressionMarker =
  | { kind: 'group'; token: Token; valueStart: number }
  | { kind: 'call'; token: Token; valueStart: number; callee: Expression; baseDepth: number; args: Expression[]; maxDepth: number }
  | { kind: 'index'; token: Token; valueStart: number; base: Expression; baseDepth: number };
export type ExpressionOperator =
  | { kind: 'unary'; token: Token; operator: string; targetType?: import('./internal.ts').CType }
  | { kind: 'binary' | 'conditional' | 'question'; token: Token; operator: string }
  | ExpressionMarker;

export interface ExpressionOperatorContext {
  readonly values: ExpressionValue[];
  readonly stack: ExpressionOperator[];
  readonly markers: number[];
  readonly questionCounts: number[];
  readonly limits: import('./types.ts').PrepareLimits;
  readonly peek: () => Token;
  readonly consume: () => Token;
  readonly pushValue: (expression: Expression, depth: number) => void;
  readonly relatedFragment: (opening: import('./internal.ts').Location, boundary: import('./internal.ts').Location, message: string) => import('./types.ts').RelatedDiagnosticLocation | undefined;
  readonly syntaxFailureWithRelated: (message: string, location: import('./internal.ts').Location, related?: import('./types.ts').RelatedDiagnosticLocation) => never;
  expectingOperand: boolean;
}
