import type {
  ArrayCType, CValue, CType, Expression, Initializer, Location, ObjectPointerValue,
  ObjectReference, ProgramIR,
} from '../internal.ts';
import type { CompiledFunction } from '../bytecode.ts';
import type { LibraryBuiltinResult, ResumableLibraryBuiltin } from '../library.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { Evaluation, Frame, VaCursor } from './runtime-types.ts';
import type { IntegerPointerOrigins } from './pointer-runtime-context.ts';

export type SimpleExpression = Extract<Expression, {
  kind: 'literal' | 'string' | 'variable' | 'function' | 'sizeof' | 'generic' | 'unary' | 'cast' | 'decay'
}>;
export type MutationExpression = Extract<Expression, { kind: 'update' | 'assignment' }>;
export type CompositeExpression = Extract<Expression, {
  kind: 'index' | 'member' | 'conditional' | 'binary' | 'compoundLiteral'
}>;
export type LibraryExpression = Extract<Expression, { kind: 'vaArg' | 'call' }>;
export type ExpressionHandler = (node: Expression, frame: Frame, depth: number, used: boolean) => boolean;

export interface ExpressionRuntimeContext {
  readonly ir: ProgramIR;
  readonly functions: readonly CompiledFunction[];
  readonly functionIndices: Map<string, number>;
  readonly functionSymbolIndices: Map<string, number>;
  readonly memory: import('../memory.ts').VirtualMemory;
  get debugEvents(): DebugEventCollector | undefined;
  readonly work: Array<() => void>;
  readonly operands: Evaluation[];
  readonly vaCursors: Map<number, VaCursor>;
  readonly initializedStaticExpressions: WeakSet<object>;
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly integerValueBases: WeakMap<CValue, Set<number>>;
  readonly unknownIntegerValueBases: WeakMap<CValue, Set<number>>;
  readonly localCell: (frame: Frame, binding: number, at: Location) => { binding: import('../internal.ts').Binding; reference: ObjectReference };
  readonly globalReference: (binding: number, at: Location) => ObjectReference;
  readonly plain: (value: CValue) => Evaluation;
  readonly integer: (value: bigint | number | boolean, type?: CType) => CValue;
  readonly valueForType: (value: CValue, type: CType, at: Location) => CValue;
  readonly truthValue: (value: CValue) => boolean;
  readonly activePointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly activeUnknownPointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly unionPointerBases: (...sources: Array<Iterable<number> | undefined>) => Set<number>;
  readonly unionUnknownPointerBases: (...sources: Array<Iterable<number> | undefined>) => Set<number>;
  readonly rememberPointerBases: (value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly rememberIntegerPointerBases: (value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly propagateIntegerPointerOperation: (operator: string, left: CValue, right: CValue | undefined, result: CValue) => void;
  readonly pointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly unknownPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly integerPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly unknownIntegerPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly setPointerBasesForObject: (reference: ObjectReference, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly setIntegerPointerBasesForObject: (reference: ObjectReference, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly integerPointerOrigins: (value: CValue) => IntegerPointerOrigins;
  readonly hasIntegerPointerOrigins: (origins: IntegerPointerOrigins) => boolean;
  readonly mergeEffects: (left: Evaluation, right: Evaluation, at: Location, sequenced?: boolean) => Evaluation;
  readonly referenceEvaluation: (
    reference: ObjectReference,
    label: string,
    effects?: Evaluation,
    addressBases?: Iterable<number>,
    unknownAddressBases?: Iterable<number>,
  ) => Evaluation;
  readonly markRead: (evaluation: Evaluation, reference: ObjectReference, label: string) => void;
  readonly markWrite: (evaluation: Evaluation, reference: ObjectReference, label: string) => void;
  readonly materialize: (evaluation: Evaluation, at: Location) => CValue;
  readonly evaluate: (root: Expression, frame: Frame, depth?: number, used?: boolean, wantLvalue?: boolean) => void;
  readonly evaluateFullExpression: (expression: Expression, frame: Frame, consume: () => void, depth?: number, used?: boolean) => void;
  readonly resolveVariableType: (type: CType, frame: Frame, at: Location) => CType;
  readonly evaluateVariableBounds: (bounds: readonly ArrayCType[], frame: Frame, at: Location, done: () => void, retainForScope?: boolean) => void;
  readonly initializeObject: (reference: ObjectReference, type: CType, initializer: Initializer, frame: Frame, depth?: number) => void;
  readonly aggregateDefinition: (type: CType, at: Location) => import('../internal.ts').AggregateDefinition;
  readonly stringReference: (node: Extract<Expression, { kind: 'string' }>) => ObjectReference;
  readonly operateBinary: (operator: string, left: CValue, right: CValue, at: Location) => CValue;
  readonly markerId: (value: CValue) => number | undefined;
  readonly vaArgTypesMatch: (argument: CValue, requestedType: CType) => boolean;
  readonly invokeBuiltin: (name: string, args: CValue[], resultType: CType | undefined, at: Location, frame: Frame) => LibraryBuiltinResult;
  readonly isBuiltinContinuation: (value: LibraryBuiltinResult) => value is ResumableLibraryBuiltin;
  readonly continueLibraryGenerator: (generator: ResumableLibraryBuiltin, effects: Evaluation, at: Location) => void;
  readonly defaultArgumentPromotion: (value: CValue, at: Location) => CValue;
  readonly invoke: (
    compiled: CompiledFunction,
    args: CValue[],
    at: Location,
    used?: boolean,
    argumentPointerBases?: readonly ReadonlySet<number>[],
    argumentUnknownPointerBases?: readonly ReadonlySet<number>[],
  ) => void;
  readonly allocateDebugObject: (allocate: () => ObjectReference, metadata: import('./runtime-types.ts').DebugObjectMetadata) => ObjectReference;
  readonly debugTypeSummary: (type: CType, aggregates: ProgramIR['aggregates']) => string;
}
