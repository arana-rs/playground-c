import type {
  AggregateDefinition, AggregateMember, ArrayCType, Binding, CType, Expression, FunctionIR, GlobalObject,
  Initializer, Location, ParsedProgram, Statement, VariablyModifiedIdentifier,
} from './internal.ts';
import type { Scope } from './parser-context-types.ts';

export interface AnalysisOptions {
  allowMissingMain?: boolean;
  allowUnresolved?: boolean;
}

export interface FunctionSignature {
  fn: FunctionIR;
  definition?: number;
  builtin?: number;
}

export interface AnalysisEnvironment {
  program: ParsedProgram;
  functions: FunctionIR[];
  globals: GlobalObject[];
  aggregates: AggregateDefinition[];
  options: AnalysisOptions;
  signatures: Map<string, FunctionSignature>;
  globalByName: Map<string, GlobalObject>;
  visibleFunctions: Map<string, FunctionSignature>;
  functionIRType: (fn: FunctionIR) => CType;
  globalsAnalyzed: boolean;
}

export interface FunctionAnalysisContext {
  environment: AnalysisEnvironment;
  fn: FunctionIR & { body: Extract<Statement, { kind: 'block' }> };
  globalVisible: Map<string, GlobalObject>;
  scopes: Scope[];
  activeVariablyModifiedIdentifiers: Set<VariablyModifiedIdentifier>;
  findLocal: (name: string) => Binding | undefined;
  declare: (name: string, type: CType, location: Location, parameter?: boolean, isConst?: boolean, staticStorage?: boolean) => number;
  markVariablyModifiedIdentifier: (arrayTypes: readonly ArrayCType[], vlaBinding?: number) => void;
  snapshotVariablyModifiedIdentifiers: () => ReadonlySet<VariablyModifiedIdentifier>;
  entersVariablyModifiedScope: (
    target: ReadonlySet<VariablyModifiedIdentifier>,
    source: ReadonlySet<VariablyModifiedIdentifier>,
  ) => boolean;
  pushScope: (owner?: Extract<Statement, { kind: 'block' }> | Extract<Statement, { kind: 'for' }>) => void;
  popScope: () => void;
}

export interface ExpressionOperations {
  analyzeExpression: (root: Expression) => CType;
  analyzedValue: (node: Expression) => Expression;
  convertedValue: (node: Expression) => Expression;
  canAssign: (target: CType, source: CType, expression: Expression) => boolean;
  analyzeVariableLengthBounds: (bounds: readonly ArrayCType[], at: Location) => void;
}

export type AnalyzeInitializer = (type: CType, initializer: Initializer, fileDuration: boolean) => Initializer;
export type AnalyzedValue = (node: Expression) => Expression;
export type VariableLengthBoundsAnalyzer = (bounds: readonly ArrayCType[], at: Location) => void;
export type LvalueChecker = (node: Expression) => boolean;
export type AssignmentChecker = (target: CType, source: CType, expression: Expression) => boolean;
export type MemberPathResolver = (type: CType, name: string, at: Location) => AggregateMember[];

export type OperatorExpression = Extract<Expression, {
  kind: 'unary' | 'binary' | 'assignment' | 'update' | 'cast' | 'sizeof' | 'conditional' | 'index' | 'member'
}>;

export type SpecialExpression = Extract<Expression, { kind: 'decay' | 'compoundLiteral' | 'vaArg' | 'call' | 'generic' }>;
