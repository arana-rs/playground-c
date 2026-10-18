import type { Diagnostic, EngineMetrics, LimitResource, PreparedProgram } from './types.ts';
import type { Binary80Value } from './binary80.ts';

export interface Location { file: string; line: number; column: number }
export interface Token extends Location { text: string; kind: 'identifier' | 'integer' | 'floating' | 'character' | 'string' | 'symbol' | 'eof' }

export type ScalarCType = '_Bool' | 'char' | 'signed char' | 'unsigned char' | 'short' | 'unsigned short' | 'int' | 'unsigned int' | 'long' | 'unsigned long' | 'long long' | 'unsigned long long' | 'float' | 'double' | 'long double' | 'void';
export interface PointerCType {
  readonly kind: 'pointer';
  readonly base: CType;
  /** Legacy pointer qualification fields. New parsed types use QualifiedCType layers. */
  readonly const?: boolean;
  readonly volatile?: boolean;
  readonly restrict?: boolean;
  /** Qualification on the pointed-to object type. */
  readonly baseConst?: boolean;
  readonly baseVolatile?: boolean;
}
export interface ArrayCType { readonly kind: 'array'; readonly element: CType; readonly length: number | null }
export interface AggregateCType { readonly kind: 'aggregate'; readonly id: number }
export interface EnumCType {
  readonly kind: 'enum';
  readonly id: number;
  readonly tag: string | null;
  /** Integer type selected by this target for the enum representation. */
  readonly integerType: Extract<ScalarCType, 'int'>;
  /** Shared mutable definition lets early references observe the closing brace. */
  readonly definition: EnumDefinition;
}
export interface TypeQualifiers {
  readonly const?: boolean;
  readonly volatile?: boolean;
  readonly restrict?: boolean;
}
/** Qualifiers are attached to one exact declarator layer, including scalar layers. */
export interface QualifiedCType {
  readonly kind: 'qualified';
  readonly base: CType;
  readonly qualifiers: TypeQualifiers;
}
export interface FunctionCType {
  readonly kind: 'function';
  readonly returnType: CType;
  readonly parameters: readonly CType[];
  readonly variadic?: boolean;
  /** false represents a C declaration written as f() without a prototype. */
  readonly prototype?: boolean;
}
export type CType = ScalarCType | PointerCType | ArrayCType | AggregateCType | EnumCType | FunctionCType | QualifiedCType;

export interface ObjectPointerValue {
  readonly kind: 'object-pointer';
  /** The allocation whose lifetime governs this pointer. */
  readonly allocationId: number;
  /** Identity of the array (or single object) used for pointer arithmetic. */
  readonly arrayId: number;
  /** Byte offset from the start of the allocation. */
  readonly byteOffset: number;
  /** Inclusive start and exclusive end of the associated array in bytes. */
  readonly boundsStart: number;
  readonly boundsEnd: number;
}
export interface FunctionPointerValue { readonly kind: 'function-pointer'; readonly functionIndex: number | null }
export type ObjectScalarValue = bigint | number | Binary80Value | ObjectPointerValue | FunctionPointerValue | null;
export interface ScalarObjectValue { readonly initialized: boolean; readonly value?: ObjectScalarValue }
export interface ObjectSnapshot extends ScalarObjectValue {
  /** True means every not-explicitly-snapshotted scalar subobject is zero-initialized. */
  readonly zeroInitialized?: boolean;
  /** Sparse subobject snapshots keyed by array/member index. */
  readonly children?: Readonly<Record<number, ObjectSnapshot>>;
  readonly activeMember?: number;
}
export interface AggregateValue { readonly kind: 'aggregate-value'; readonly snapshot: ObjectSnapshot }
export type CValueData = bigint | number | Binary80Value | ObjectPointerValue | FunctionPointerValue | AggregateValue | null;
export interface CValue { type: CType; value: CValueData }

export interface ObjectReference {
  readonly objectId: number;
  readonly allocationId: number;
  readonly byteOffset: number;
  readonly type: CType;
  /** Present when this reference denotes an element of an array object. */
  readonly arrayId?: number;
  readonly arrayIndex?: number;
  readonly arrayLength?: number;
  /** The pointer-arithmetic bounds in byte offsets for this subobject. */
  readonly boundsStart?: number;
  readonly boundsEnd?: number;
  readonly parentId?: number;
  readonly memberIndex?: number;
}
export type StorageDuration = 'automatic' | 'static' | 'thread-local' | 'heap' | 'string-literal' | 'compound-literal';

export interface Binding {
  id: number;
  name: string;
  type: CType;
  location: Location;
  /** Distinguishes a parameter binding from a local variable for debug metadata. */
  readonly isParameter?: boolean;
  /** Block-scope static objects have a stable storage key and session lifetime. */
  storageKey?: string;
  storageDuration?: 'automatic' | 'static' | 'thread-local';
  isConst?: boolean;
  qualifiers?: TypeQualifiers;
  requestedAlignment?: number;
  alignment?: number;
  threadLocal?: boolean;
  linkage?: Linkage;
  symbolKey?: string;
  globalBinding?: number;
  register?: boolean;
}
type ExpressionInfo = { location: Location; type?: CType; isConst?: boolean; register?: boolean; bitField?: boolean };
export type Expression =
  | (ExpressionInfo & { kind: 'literal'; value: CValue })
  | (ExpressionInfo & { kind: 'string'; bytes: readonly number[] })
  | (ExpressionInfo & { kind: 'variable'; name: string; binding?: number; globalBinding?: number })
  | (ExpressionInfo & { kind: 'function'; name: string; functionIndex?: number; symbolKey?: string })
  | (ExpressionInfo & { kind: 'unary'; operator: string; operand: Expression })
  | (ExpressionInfo & { kind: 'binary'; operator: string; left: Expression; right: Expression })
  | (ExpressionInfo & { kind: 'assignment'; target: Expression; operator: string; value: Expression })
  | (ExpressionInfo & { kind: 'update'; operand: Expression; operator: '++' | '--'; prefix: boolean })
  | (ExpressionInfo & { kind: 'cast'; targetType: CType; operand: Expression })
  | (ExpressionInfo & { kind: 'sizeof'; operand?: Expression; valueType?: CType })
  | (ExpressionInfo & { kind: 'conditional'; condition: Expression; then: Expression; else: Expression })
  | (ExpressionInfo & { kind: 'index'; base: Expression; index: Expression })
  | (ExpressionInfo & { kind: 'member'; base: Expression; name: string; arrow: boolean; memberIndex?: number })
  | (ExpressionInfo & { kind: 'generic'; control: Expression; associations: GenericAssociation[]; selected: Expression })
  | (ExpressionInfo & { kind: 'decay'; operand: Expression })
  | (ExpressionInfo & { kind: 'compoundLiteral'; objectType: CType; initializer: Initializer; duration: 'automatic' | 'static' })
  | (ExpressionInfo & { kind: 'call'; name?: string; callee?: Expression; args: Expression[]; functionIndex?: number; symbolKey?: string; builtin?: boolean })
  | (ExpressionInfo & { kind: 'vaArg'; ap: Expression; valueType: CType });

export interface GenericAssociation { type?: CType; expression: Expression; location: Location }

export type InitializerDesignator =
  | { kind: 'member'; name: string; memberIndex?: number; location: Location }
  | { kind: 'index'; index: bigint; location: Location };
export interface InitializerItem { designators: InitializerDesignator[]; initializer: Initializer; location: Location }
export type Initializer =
  | { kind: 'expression'; value: Expression; location: Location }
  | { kind: 'list'; items: InitializerItem[]; location: Location };

export interface BitFieldLayout {
  /** Declared bit width. Zero marks an unnamed allocation barrier only. */
  width: number;
  /** Byte offset of the allocation unit from the aggregate start. */
  storageUnitOffset: number;
  /** Allocation unit size in bytes. */
  storageUnitSize: number;
  /** Bit offset from the least significant bit of the little-endian unit. */
  bitOffset: number;
  /** Signedness chosen by the target profile for the declared bit-field type. */
  signed: boolean;
}
export interface AggregateMember {
  name: string;
  type: CType;
  index: number;
  /** Byte offset, or allocation-unit start for a bit-field. */
  offset: number;
  location: Location;
  isConst?: boolean;
  qualifiers?: TypeQualifiers;
  requestedAlignment?: number;
  alignment?: number;
  bitField?: BitFieldLayout;
  flexibleArray?: boolean;
  unnamedBitField?: boolean;
}
export interface AggregateDefinition {
  id: number;
  kind: 'struct' | 'union';
  tag: string | null;
  complete: boolean;
  members: AggregateMember[];
  size?: number;
  alignment?: number;
  flexibleMemberIndex?: number;
  flexibleOffset?: number;
  location: Location;
}
export interface EnumDefinition {
  id: number;
  tag: string | null;
  complete: boolean;
  integerType: Extract<ScalarCType, 'int'>;
  enumerators: { name: string; value: bigint; location: Location }[];
  translationUnit: string;
  location: Location;
}
export type Linkage = 'internal' | 'external';
export interface GlobalObject {
  id: number;
  name: string;
  type: CType;
  initializer?: Initializer;
  location: Location;
  linkage?: Linkage;
  symbolKey?: string;
  translationUnit?: string;
  /** C file-scope definition without an initializer, eligible for coalescing. */
  tentative?: boolean;
  /** An extern-only declaration does not allocate storage by itself. */
  declarationOnly?: boolean;
  isConst?: boolean;
  qualifiers?: TypeQualifiers;
  requestedAlignment?: number;
  alignment?: number;
  threadLocal?: boolean;
}
export interface StaticAssertion { condition: Expression; message: string; location: Location }
export interface ParsedProgram { functions: FunctionIR[]; aggregates: AggregateDefinition[]; enums: EnumDefinition[]; globals: GlobalObject[]; staticAssertions?: StaticAssertion[]; translationUnit?: string }

export type Statement =
  | { kind: 'block'; statements: Statement[]; bindings?: number[]; location: Location; endLocation: Location }
  | { kind: 'sequence'; statements: Statement[]; location: Location }
  | { kind: 'declaration'; name: string; type: CType; binding?: number; initializer?: Initializer; static?: boolean; const?: boolean; extern?: boolean; threadLocal?: boolean; register?: boolean; alignment?: number; requestedAlignment?: number; symbolKey?: string; location: Location }
  | { kind: 'staticAssert'; condition: Expression; message: string; location: Location }
  | { kind: 'return'; value?: Expression; location: Location }
  | { kind: 'expression'; value: Expression; location: Location }
  | { kind: 'if'; condition: Expression; scopeName: string; then: Statement; else?: Statement; location: Location }
  | { kind: 'while' | 'do'; condition: Expression; scopeName: string; body: Statement; location: Location }
  | { kind: 'for'; initializer?: Statement; condition?: Expression; increment?: Expression; scopeName: string; body: Statement; bindings?: number[]; location: Location }
  | { kind: 'switch'; value: Expression; scopeName: string; body: Statement; location: Location }
  | { kind: 'case'; value?: Expression; constant?: CValue; statement: Statement; location: Location }
  | { kind: 'label'; name: string; statement: Statement; location: Location }
  | { kind: 'goto'; target: string; location: Location }
  | { kind: 'break' | 'continue'; location: Location }
  | { kind: 'empty'; location: Location };
export interface Parameter {
  name: string;
  type: CType;
  binding?: number;
  isConst?: boolean;
  qualifiers?: TypeQualifiers;
  register?: boolean;
  /** Minimum element count promised by an array parameter declared with static. */
  minimumArrayBound?: number;
  location: Location;
}
export interface FunctionIR {
  name: string;
  returnType: CType;
  parameters: Parameter[];
  body?: Extract<Statement, { kind: 'block' }>;
  bindings: Binding[];
  location: Location;
  builtin?: boolean;
  linkage?: Linkage;
  symbolKey?: string;
  translationUnit?: string;
  variadic?: boolean;
  prototype?: boolean;
  oldStyle?: boolean;
  inline?: boolean;
  extern?: boolean;
  noreturn?: boolean;
}
export interface ProgramIR extends ParsedProgram { entry: string; mainIndex: number; sourceChars: number; tokenCount: number }
export const programs = new WeakMap<PreparedProgram, ProgramIR>();
export const INT_MIN = -2147483648n;
export const INT_MAX = 2147483647n;

export class EngineFailure extends Error {
  diagnostic: Diagnostic;
  resource?: LimitResource;
  limit?: number;
  constructor(code: string, message: string, location: Location, resource?: LimitResource, limit?: number) {
    super(message);
    this.diagnostic = { code, message, file: location.file, line: location.line, column: location.column };
    this.resource = resource;
    this.limit = limit;
  }
}
export function failure(code: string, message: string, location: Location): never { throw new EngineFailure(code, message, location); }
export function enforceLimit(resource: LimitResource, actual: number, limit: number | null, location: Location): void {
  if (limit !== null && actual > limit) throw new EngineFailure('LIMIT_EXCEEDED', `${resource} limit exceeded: ${limit}.`, location, resource, limit);
}
export function normalizedLimits<T extends object>(defaults: T, supplied: Partial<T> | undefined, location: Location): T {
  if (supplied !== undefined && (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied))) failure('INVALID_OPTIONS', 'limits must be an object.', location);
  const result = { ...defaults };
  for (const key of Object.keys(supplied ?? {})) {
    if (!Object.hasOwn(defaults, key)) failure('INVALID_OPTIONS', `Unknown limit: ${key}.`, location);
    const value = (supplied as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) failure('INVALID_OPTIONS', `${key} must be a nonnegative safe integer or null.`, location);
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}
export function freshMetrics(): EngineMetrics { return { prepareMs: 0, executeMs: 0, sourceChars: 0, tokenCount: 0, preprocessSteps: 0, instructionCount: 0, peakMemoryBytes: 0 }; }
export function now(): number { return performance.now(); }

// Freeze iteratively and tolerate shared type descriptors and object graphs.
export function freezeIR(ir: ProgramIR): void {
  const pending: object[] = [ir];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (visited.has(value) || Object.isFrozen(value)) continue;
    visited.add(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
}
