import { DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS, DEFAULT_EXECUTE_LIMITS } from './types.ts';
import type {
  DebugAggregateInspection, DebugAggregateMemberSnapshot, DebugAggregatePaddingSnapshot, DebugAggregateSnapshot,
  DebugAggregateStatus, DebugEvent, DebugExecutionSession, DebugLimitResult, DebugObjectDuration, DebugObjectOrigin,
  DebugPausedResult, DebugProgress, DebugSessionOptions, DebugSourceLocation, ExecuteOptions, ExecuteProgress,
  DebugArrayElementSnapshot, DebugArrayInspection, DebugArraySnapshot, DebugHeapObjectSnapshot, DebugPointerSnapshot,
  DebugScalarSnapshot, DebugStaticObjectInspectionOptions, DebugStaticObjectSnapshot,
  ExecuteResult, ExecutionSession, PreparedProgram,
} from './types.ts';
import {
  EngineFailure, enforceLimit, failure, freshMetrics, normalizedLimits, now, programs,
} from './internal.ts';
import { formatBinary80Hex } from './binary80.ts';
import type {
  AggregateDefinition, Binding, CValue, Expression, Initializer, InitializerDesignator,
  Location, ObjectPointerValue, ObjectReference, ObjectScalarValue,
} from './internal.ts';
import { compile } from './bytecode.ts';
import type { CompiledFunction, Scope } from './bytecode.ts';
import { binary, callBuiltin, convert, isFloatingClassificationBuiltin, promote, truth, unary } from './numeric.ts';
import { arrayOf, compatibleType, isAggregate, isArithmetic, isArray, isFunction, isInteger, isPointer, isScalar, pointerTo, sameType, sizeOfType, typeName } from './type-system.ts';
import { VirtualMemory } from './memory.ts';
import { dispatchLibraryBuiltin } from './library.ts';
import type { LibraryBuiltinResult, LibraryRuntimeContext, ResumableLibraryBuiltin } from './library.ts';
import { VirtualIO, VirtualIOError, VirtualStream } from './virtual-io.ts';

interface Cell { binding: Binding; reference: ObjectReference }
interface RuntimeScope { layout: Scope; token: object; scopeId: number; cells: number[] }
interface Frame {
  compiled: CompiledFunction;
  frameId: number | null;
  pc: number;
  returnLocation?: Location;
  scopes: RuntimeScope[];
  fullExpressionToken?: object;
  cells: Map<number, Cell>;
  args: CValue[];
  variadicArgs: CValue[];
  vaCursorIds: Set<number>;
  temporaryObjects: ObjectReference[];
  returned: boolean;
  result?: CValue;
}
interface DebugObjectMetadata {
  readonly duration: DebugObjectDuration;
  readonly origin: DebugObjectOrigin;
  readonly typeSummary: string;
  readonly location: Location;
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly name?: string;
  readonly readOnly?: boolean;
}
interface DebugObjectRecord {
  readonly objectId: number;
  readonly allocationId: number;
  readonly duration: DebugObjectDuration;
  readonly origin: DebugObjectOrigin;
  readonly typeSummary: string;
  readonly addressVirtual: bigint;
  readonly size: number;
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly name?: string;
  readonly readOnly: boolean;
}
type RuntimeSession = {
  resume(): ExecuteProgress | DebugProgress;
  appendStdin?: (bytes: Uint8Array) => void;
  endStdin?: () => void;
  currentLocation?: () => DebugSourceLocation | null;
  drainEvents?: () => readonly DebugEvent[];
  inspectScalars?: () => readonly DebugScalarSnapshot[];
  inspectPointers?: () => readonly DebugPointerSnapshot[];
  inspectStaticObjects?: (options?: DebugStaticObjectInspectionOptions) => readonly DebugStaticObjectSnapshot[];
  inspectArrays?: () => DebugArrayInspection;
  inspectAggregates?: () => DebugAggregateInspection;
  inspectHeapObjects?: () => readonly DebugHeapObjectSnapshot[];
};
interface VaCursor { frame: Frame; args: readonly CValue[]; index: number; active: boolean; marker: ObjectReference }
interface Access { read: boolean; write: boolean; name: string }
interface Evaluation {
  value?: CValue;
  reference?: ObjectReference;
  label?: string;
  accesses: Map<number, Access>;
  pendingWrites: Set<number>;
}

const plain = (value: CValue): Evaluation => ({ value, accesses: new Map(), pendingWrites: new Set() });
const integer = (value: bigint | number | boolean, type: CValue['type'] = 'int'): CValue => ({
  type,
  value: typeof value === 'bigint' ? value : BigInt(typeof value === 'boolean' ? (value ? 1 : 0) : value),
});
const isBuiltinContinuation = (value: LibraryBuiltinResult): value is ResumableLibraryBuiltin =>
  typeof value === 'object' && value !== null && typeof (value as ResumableLibraryBuiltin).next === 'function';

const DEFAULT_DEBUG_EVENT_BUDGET = 100_000;
const MAX_HEAP_ADDRESS_SEED = 0xffff_ffff;

function heapAddressRandomForSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
type PendingDebugEvent = DebugEvent extends infer Event
  ? Event extends DebugEvent ? Omit<Event, 'sequence'> : never
  : never;

class DebugEventCollector {
  private readonly pending: DebugEvent[] = [];
  private nextSequence = 1;
  private reserved = 0;
  private used = 0;

  constructor(private readonly maxEvents: number) {}

  reserve(location: Location): void {
    if (this.used + 1 > this.maxEvents) throw new DebugEventLimit(location, this.maxEvents);
    this.used++;
    this.reserved++;
  }

  reserveMany(count: number, location: Location): void {
    let completed = 0;
    try {
      for (; completed < count; completed++) this.reserve(location);
    } catch (error) {
      this.cancelMany(completed);
      throw error;
    }
  }

  cancel(): void { this.cancelMany(1); }

  cancelMany(count: number): void {
    this.reserved -= count;
    this.used -= count;
  }

  commit(event: PendingDebugEvent): void {
    this.reserved--;
    this.pending.push(Object.freeze({
      ...event,
      sequence: this.nextSequence++,
      location: Object.freeze({ ...event.location }),
    }) as DebugEvent);
  }

  record(event: PendingDebugEvent): void {
    this.reserve(event.location);
    this.commit(event);
  }

  drain(): readonly DebugEvent[] {
    const events = this.pending.splice(0);
    return Object.freeze(events);
  }
}

class DebugEventLimit extends Error {
  constructor(readonly location: Location, readonly limit: number) {
    super(`Se superó maxDebugEvents: límite ${limit}.`);
  }
}

function debugTypeSummary(type: CValue['type'], aggregates: readonly AggregateDefinition[]): string {
  if (typeof type === 'string') return type;
  if (type.kind === 'pointer') return `${debugTypeSummary(type.base, aggregates)} *`;
  if (type.kind === 'array') return `${debugTypeSummary(type.element, aggregates)}[${type.length ?? ''}]`;
  if (type.kind === 'aggregate') {
    const aggregate = aggregates.find((candidate) => candidate.id === type.id);
    return `${aggregate?.kind ?? 'aggregate'} ${aggregate?.tag ?? `<anonymous ${type.id}>`}`;
  }
  return `function (${type.parameters.map((parameter) => debugTypeSummary(parameter, aggregates)).join(', ')})`;
}

function debugEscapedByte(byte: number, context: 'character' | 'string'): string {
  if (byte === 0) return context === 'string' ? '\\000' : '\\0';
  if (byte === 34 && context === 'string') return '\\"';
  if (byte === 39 && context === 'character') return "\\'";
  const escapes: Readonly<Record<number, string>> = {
    7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r',
    92: '\\\\',
  };
  const escaped = escapes[byte];
  if (escaped) return escaped;
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  return context === 'string'
    ? '\\' + byte.toString(8).padStart(3, '0')
    : '\\x' + byte.toString(16).padStart(2, '0').toUpperCase();
}

function debugScalarValue(type: CValue['type'], value: ObjectScalarValue): string {
  if (type === 'long double' && typeof value === 'object' && value !== null && value.kind === 'binary80') {
    return formatBinary80Hex(value);
  }
  if (type === '_Bool') return value === 0n || value === 0 ? '0' : '1';
  if (type === 'char' || type === 'signed char' || type === 'unsigned char') {
    if (typeof value !== 'bigint') return '?';
    const byte = Number(BigInt.asUintN(8, value));
    return "'" + debugEscapedByte(byte, 'character') + "'";
  }
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value !== 'number') return '?';
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Object.is(value, -0)) return '-0';
  return value.toString();
}

function debugStringLiteral(bytes: readonly number[]): string {
  return '"' + bytes.map((byte) => debugEscapedByte(byte, 'string')).join('') + '"';
}

export function execute(program: PreparedProgram, options?: ExecuteOptions): ExecuteResult {
  const session = createRuntimeSession(program, options, false) as ExecutionSession;
  const result = session.resume();
  // Batch stdin is closed from the start, so this path cannot suspend.
  if (result.kind === 'input-needed') {
    return {
      kind: 'runtime-error',
      diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'La ejecución por lotes solicitó entrada interactiva.', file: program.entry, line: 1, column: 1 }],
      metrics: result.metrics,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return result;
}

/** Create a live VM session whose stdin remains open until endStdin(). */
export function createExecutionSession(program: PreparedProgram, options?: ExecuteOptions): ExecutionSession {
  return createRuntimeSession(program, options, true) as ExecutionSession;
}

/** Create a live VM session that reports object and scope lifecycle events. */
export function createDebugSession(
  program: PreparedProgram,
  options?: ExecuteOptions,
  debugOptions?: DebugSessionOptions,
): DebugExecutionSession {
  return createRuntimeSession(program, options, true, debugOptions === undefined ? {} : debugOptions) as DebugExecutionSession;
}

function createRuntimeSession(
  program: PreparedProgram,
  options: ExecuteOptions | undefined,
  interactiveStdin: boolean,
  debugOptions?: DebugSessionOptions,
): RuntimeSession {
  const started = now();
  const metrics = freshMetrics();
  const location = { file: program && typeof program.entry === 'string' ? program.entry : 'main.c', line: 1, column: 1 };
  let io: VirtualIO | undefined;
  let runtimeLocation: Location = location;
  let awaitingInput = false;
  let stdinEnded = !interactiveStdin;
  let terminalResult: ExecuteResult | DebugLimitResult | undefined;
  let runRuntime: (() => ExecuteProgress | DebugProgress) | undefined;
  let pendingInputError: unknown;
  let debugEvents: DebugEventCollector | undefined;
  let inspectDebugScalars: (() => readonly DebugScalarSnapshot[]) | undefined;
  let inspectDebugPointers: (() => readonly DebugPointerSnapshot[]) | undefined;
  let inspectDebugStaticObjects: ((options?: DebugStaticObjectInspectionOptions) => readonly DebugStaticObjectSnapshot[]) | undefined;
  let inspectDebugArrays: (() => DebugArrayInspection) | undefined;
  let inspectDebugAggregates: (() => DebugAggregateInspection) | undefined;
  let inspectDebugHeapObjects: (() => readonly DebugHeapObjectSnapshot[]) | undefined;
  let debugLocation: Location | null = null;
  let debugPause: DebugPausedResult | undefined;
  let debugEntryReady = false;
  let debugStartPhase = debugOptions !== undefined;
  let debugStepActive = false;
  let debugStepStartLocation: Location | undefined;
  let debugStepExecuted = false;
  let debugInputSuspended = false;
  let debugVisitedInstructions: Map<Frame, Set<number>> | undefined = debugOptions === undefined ? undefined : new Map();
  const output = () => io?.snapshot() ?? { stdout: new Uint8Array(), stderr: new Uint8Array() };
  const exposedDebugLocation = (): DebugSourceLocation | null => debugLocation
    ? Object.freeze({ file: debugLocation.file, line: debugLocation.line, column: debugLocation.column })
    : null;
  const resultForError = (error: unknown): ExecuteResult | DebugLimitResult => {
    if (error instanceof DebugEventLimit && debugOptions !== undefined) {
      return {
        kind: 'debug-limit', resource: 'maxDebugEvents', limit: error.limit,
        diagnostics: [{
          code: 'LIMIT_EXCEEDED', message: error.message,
          file: error.location.file, line: error.location.line, column: error.location.column,
        }],
        metrics, ...output(),
      };
    }
    if (error instanceof EngineFailure) {
      if (error.resource !== undefined && error.limit !== undefined) {
        return { kind: 'limit', stage: 'execute', resource: error.resource, limit: error.limit, diagnostics: [error.diagnostic], metrics, ...output() };
      }
      return { kind: 'runtime-error', diagnostics: [error.diagnostic], metrics, ...output() };
    }
    if (error instanceof VirtualIOError) {
      return {
        kind: 'runtime-error',
        diagnostics: [{ code: error.code, message: error.message, ...runtimeLocation }],
        metrics,
        ...output(),
      };
    }
    return {
      kind: 'runtime-error',
      diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'La ejecución encontró un error interno del motor.', ...runtimeLocation }],
      metrics,
      ...output(),
    };
  };
  const session: RuntimeSession = {
    resume(): ExecuteProgress | DebugProgress {
      if (terminalResult) return { ...terminalResult, metrics: { ...metrics }, ...output() };
      if (awaitingInput) {
        const waiting = { kind: 'input-needed' as const, ...output(), metrics: { ...metrics } };
        if (debugOptions === undefined) return waiting;
        const current = exposedDebugLocation() ?? runtimeLocation;
        return {
          ...waiting,
          location: Object.freeze({ file: current.file, line: current.line, column: current.column }),
        };
      }
      const resumeStarted = now();
      if (debugOptions !== undefined) {
        debugPause = undefined;
        if (!debugInputSuspended) {
          debugStepStartLocation = debugLocation ?? undefined;
          debugStepExecuted = false;
          debugVisitedInstructions = new Map();
          debugStepActive = debugLocation !== null;
        }
      }
      try {
        if (pendingInputError !== undefined) {
          const error = pendingInputError;
          pendingInputError = undefined;
          terminalResult = resultForError(error);
        } else if (!runRuntime) {
          terminalResult = resultForError(new Error('La sesión no se inicializó.'));
        } else {
          const progress = runRuntime();
          if (progress.kind === 'paused') {
            debugInputSuspended = false;
            metrics.executeMs += now() - resumeStarted;
            return { ...progress, metrics: { ...metrics } };
          }
          if (progress.kind === 'input-needed' && debugOptions !== undefined) {
            const current = exposedDebugLocation() ?? runtimeLocation;
            debugInputSuspended = true;
            metrics.executeMs += now() - resumeStarted;
            return {
              ...progress,
              location: Object.freeze({ file: current.file, line: current.line, column: current.column }),
              metrics: { ...metrics },
            };
          }
          if (progress.kind !== 'input-needed') terminalResult = progress;
          if (terminalResult) {
            debugLocation = null;
            debugInputSuspended = false;
          }
          metrics.executeMs += now() - resumeStarted;
          if (terminalResult) return { ...terminalResult, metrics: { ...metrics } };
          return { ...progress, metrics: { ...metrics }, ...output() };
        }
      } catch (error) {
        terminalResult = resultForError(error);
        debugLocation = null;
        debugInputSuspended = false;
      }
      metrics.executeMs += now() - resumeStarted;
      return { ...terminalResult!, metrics: { ...metrics }, ...output() };
    },
  };
  if (interactiveStdin) {
    session.appendStdin = (bytes: Uint8Array): void => {
      if (!interactiveStdin) throw new TypeError('La sesión por lotes no acepta stdin interactivo.');
      if (terminalResult || stdinEnded) throw new TypeError('No se puede añadir stdin después de EOF o del final de ejecución.');
      if (!awaitingInput) throw new TypeError('Solo se puede añadir stdin después de que la sesión lo solicite.');
      if (!(bytes instanceof Uint8Array)) throw new TypeError('stdin interactivo debe ser Uint8Array.');
      try {
        io!.appendStdin(bytes, runtimeLocation);
        awaitingInput = false;
      } catch (error) {
        pendingInputError = error;
        awaitingInput = false;
      }
    };
    session.endStdin = (): void => {
      if (!interactiveStdin) throw new TypeError('La sesión por lotes no acepta stdin interactivo.');
      if (terminalResult) throw new TypeError('No se puede cerrar stdin después del final de ejecución.');
      if (stdinEnded) return;
      stdinEnded = true;
      awaitingInput = false;
      io?.endStdin();
    };
  }
  if (debugOptions !== undefined) {
    session.drainEvents = () => debugEvents?.drain() ?? Object.freeze([]);
    session.currentLocation = exposedDebugLocation;
    session.inspectScalars = () => inspectDebugScalars?.() ?? Object.freeze([]);
    session.inspectPointers = () => inspectDebugPointers?.() ?? Object.freeze([]);
    session.inspectStaticObjects = (inspectionOptions) => inspectDebugStaticObjects?.(inspectionOptions) ?? Object.freeze([]);
    session.inspectArrays = () => inspectDebugArrays?.() ?? Object.freeze({ arrays: Object.freeze([]), omittedObjects: 0 });
    session.inspectAggregates = () => inspectDebugAggregates?.() ?? Object.freeze({ aggregates: Object.freeze([]), omittedObjects: 0 });
    session.inspectHeapObjects = () => inspectDebugHeapObjects?.() ?? Object.freeze([]);
  }
  try {
    const candidate = programs.get(program);
    if (!candidate) failure('INVALID_PROGRAM', 'El programa debe proceder de prepare en esta misma instancia del motor; no admite copias ni programas externos.', location);
    const ir = candidate;
    metrics.sourceChars = ir.sourceChars;
    metrics.tokenCount = ir.tokenCount;
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
      failure('INVALID_OPTIONS', 'Las opciones de ejecución deben ser un objeto.', location);
    }
    if (debugOptions !== undefined) {
      if (!debugOptions || typeof debugOptions !== 'object' || Array.isArray(debugOptions)) {
        failure('INVALID_OPTIONS', 'Las opciones de depuración deben ser un objeto.', location);
      }
      for (const key of Object.keys(debugOptions)) {
        if (key !== 'maxEvents' && key !== 'heapAddressSeed' && key !== 'maxObjects' &&
            key !== 'maxElementsPerArray' && key !== 'maxValueChars') {
          failure('INVALID_OPTIONS', `Opción de depuración desconocida: ${key}.`, location);
        }
      }
      const maxEvents = debugOptions.maxEvents === undefined ? DEFAULT_DEBUG_EVENT_BUDGET : debugOptions.maxEvents;
      if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) {
        failure('INVALID_OPTIONS', 'maxEvents debe ser un entero seguro no negativo.', location);
      }
      if (debugOptions.heapAddressSeed !== undefined &&
          (!Number.isInteger(debugOptions.heapAddressSeed) || debugOptions.heapAddressSeed < 0 || debugOptions.heapAddressSeed > MAX_HEAP_ADDRESS_SEED)) {
        failure('INVALID_OPTIONS', 'heapAddressSeed debe ser un entero entre 0 y 2^32-1.', location);
      }
      for (const [key, value] of [
        ['maxObjects', debugOptions.maxObjects],
        ['maxElementsPerArray', debugOptions.maxElementsPerArray],
        ['maxValueChars', debugOptions.maxValueChars],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          failure('INVALID_OPTIONS', `${key} debe ser un entero seguro no negativo.`, location);
        }
      }
      debugEvents = new DebugEventCollector(maxEvents);
    }
    const limits = normalizedLimits(DEFAULT_EXECUTE_LIMITS, options?.limits, location);
    const suppliedIO = options?.io;
    if (debugOptions !== undefined && suppliedIO !== undefined &&
        (!suppliedIO || typeof suppliedIO !== 'object' || Array.isArray(suppliedIO))) {
      failure('INVALID_OPTIONS', 'io debe ser un objeto.', location);
    }
    const ioOptions = suppliedIO;
    io = new VirtualIO({
      entry: ir.entry,
      io: ioOptions,
      maxBytes: limits.maxIOBytes,
      interactiveStdin,
      checkLimit: (actual, at) => enforceLimit('maxIOBytes', actual, limits.maxIOBytes, at),
    });
    const functions = ir.functions.map((fn) => compile(fn));
    const functionIndices = new Map<string, number>();
    const functionSymbolIndices = new Map<string, number>();
    ir.functions.forEach((fn, index) => {
      if (!functionIndices.has(fn.name)) functionIndices.set(fn.name, index);
      if (fn.symbolKey) functionSymbolIndices.set(fn.symbolKey, index);
    });
    const memory = new VirtualMemory(
      ir.aggregates,
      limits.maxMemoryBytes,
      metrics,
      debugOptions?.heapAddressSeed === undefined ? Math.random : heapAddressRandomForSeed(debugOptions.heapAddressSeed),
      debugOptions !== undefined,
    );
    const debugObjects = debugEvents ? new Map<number, DebugObjectRecord>() : undefined;
    const debugObjectLocations = debugEvents ? new Map<number, Location>() : undefined;
    const activeDebugFrames = debugEvents ? [] as Frame[] : undefined;
    const maxArrayObjects = debugOptions?.maxObjects ?? DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxObjects;
    const maxElementsPerArray = debugOptions?.maxElementsPerArray ?? DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxElementsPerArray;
    const maxValueChars = debugOptions?.maxValueChars ?? DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxValueChars;
    if (debugEvents && debugObjects && activeDebugFrames) {
      inspectDebugScalars = (): readonly DebugScalarSnapshot[] => Object.freeze(activeDebugFrames.flatMap((frame) =>
        frame.scopes.flatMap((scope) => scope.cells.flatMap((bindingId) => {
          const cell = frame.cells.get(bindingId);
          if (!cell || cell.binding.storageDuration === 'static' || !isArithmetic(cell.binding.type) ||
              frame.frameId === null || scope.scopeId === 0) return [];
          const record = debugObjects.get(cell.reference.allocationId);
          if (!record) return [];
          const inspected = memory.inspectScalar(cell.reference, cell.binding.location);
          return [Object.freeze({
            id: record.allocationId,
            scopeId: scope.scopeId,
            frameId: frame.frameId,
            name: cell.binding.name,
            origin: record.origin,
            type: typeName(cell.binding.type, ir.aggregates),
            address: `0x${record.addressVirtual.toString(16)}`,
            size: record.size,
            initialized: inspected.initialized,
            displayValue: inspected.initialized && inspected.value !== undefined
              ? debugScalarValue(cell.binding.type, inspected.value)
              : '?',
          }) satisfies DebugScalarSnapshot];
        })),
      ));
      const snapshotPointer = (record: DebugObjectRecord, reference: ObjectReference): DebugPointerSnapshot | undefined => {
        if (!isPointer(reference.type) || record.name === undefined) return undefined;
        const inspected = memory.inspectPointer(reference, debugObjectLocations!.get(record.allocationId) ?? location);
        let target: DebugPointerSnapshot['target'];
        if (inspected.target) {
          const targetType = debugTypeSummary(reference.type.base, ir.aggregates);
          const targetRecord = debugObjects.get(inspected.target.allocationId);
          const name = inspected.target.byteOffset === 0 && targetRecord?.typeSummary === targetType
            ? targetRecord.name
            : undefined;
          target = Object.freeze({
            allocationId: inspected.target.allocationId,
            byteOffset: inspected.target.byteOffset,
            type: targetType,
            ...(name === undefined ? {} : { name }),
          });
        }
        return Object.freeze({
          id: record.allocationId,
          scopeId: record.scopeId,
          frameId: record.frameId,
          name: record.name,
          origin: record.origin as DebugPointerSnapshot['origin'],
          duration: record.duration as DebugPointerSnapshot['duration'],
          region: record.duration === 'automatic' ? 'stack' : 'static',
          type: typeName(reference.type, ir.aggregates),
          address: `0x${record.addressVirtual.toString(16)}`,
          size: record.size,
          initialized: inspected.initialized,
          displayValue: inspected.address === undefined ? '?' : `0x${inspected.address.toString(16)}`,
          status: inspected.status,
          ...(target === undefined ? {} : { target }),
        }) satisfies DebugPointerSnapshot;
      };
      inspectDebugPointers = (): readonly DebugPointerSnapshot[] => {
        const automatic = activeDebugFrames.flatMap((frame) => frame.scopes.flatMap((scope) =>
          scope.cells.flatMap((bindingId) => {
            const cell = frame.cells.get(bindingId);
            if (!cell || cell.binding.storageDuration === 'static' || !isPointer(cell.binding.type) ||
                frame.frameId === null) return [];
            const record = debugObjects.get(cell.reference.allocationId);
            if (!record) return [];
            const snapshot = snapshotPointer(record, cell.reference);
            return snapshot ? [snapshot] : [];
          }),
        ));
        const staticPointers = [...debugObjects.values()].flatMap((record) => {
          if (record.duration !== 'static' || record.origin !== 'variable' || record.name === undefined) return [];
          const reference = memory.rootReference(record.allocationId);
          if (!reference || !isPointer(reference.type)) return [];
          const snapshot = snapshotPointer(record, reference);
          return snapshot ? [snapshot] : [];
        });
        return Object.freeze([...staticPointers, ...automatic]);
      };
      inspectDebugStaticObjects = (inspectionOptions): readonly DebugStaticObjectSnapshot[] => {
        if (inspectionOptions !== undefined &&
            (!inspectionOptions || typeof inspectionOptions !== 'object' || Array.isArray(inspectionOptions))) {
          throw new TypeError('inspectStaticObjects requiere un objeto de opciones.');
        }
        for (const key of Object.keys(inspectionOptions ?? {})) {
          if (key !== 'includeStringLiterals') throw new TypeError(`Opción de inspectStaticObjects desconocida: ${key}.`);
        }
        if (inspectionOptions?.includeStringLiterals !== undefined &&
            typeof inspectionOptions.includeStringLiterals !== 'boolean') {
          throw new TypeError('includeStringLiterals debe ser booleano.');
        }
        const includeStringLiterals = inspectionOptions?.includeStringLiterals ?? true;
        return Object.freeze([...debugObjects.values()].flatMap<DebugStaticObjectSnapshot>((record) => {
          if (record.duration !== 'static' ||
              (record.origin !== 'variable' && record.origin !== 'string-literal')) return [];
          if (record.origin === 'string-literal' && !includeStringLiterals) return [];
          const reference = memory.rootReference(record.allocationId);
          if (!reference) return [];
          const address = `0x${record.addressVirtual.toString(16)}`;
          if (record.origin === 'variable' && isArithmetic(reference.type)) {
            const at = debugObjectLocations!.get(record.allocationId) ?? location;
            const inspected = memory.inspectScalar(reference, at);
            return [Object.freeze({
              id: record.allocationId,
              ...(record.name === undefined ? {} : { name: record.name }),
              origin: record.origin,
              type: typeName(reference.type, ir.aggregates),
              address,
              size: record.size,
              initialized: inspected.initialized,
              displayValue: inspected.initialized && inspected.value !== undefined
                ? debugScalarValue(reference.type, inspected.value)
                : '?',
            }) satisfies DebugStaticObjectSnapshot];
          }
          if (record.origin === 'string-literal') {
            const bytes = memory.inspectStringLiteral(reference);
            if (!bytes) return [];
            return [Object.freeze({
              id: record.allocationId,
              origin: record.origin,
              type: record.typeSummary,
              address,
              size: record.size,
              initialized: true,
              displayValue: debugStringLiteral(bytes),
            }) satisfies DebugStaticObjectSnapshot];
          }
          return [];
        }));
      };
      inspectDebugArrays = (): DebugArrayInspection => {
        const candidates = [...debugObjects.values()].flatMap((record) => {
          if ((record.duration !== 'automatic' && record.duration !== 'static') ||
              (record.origin !== 'variable' && record.origin !== 'string-literal')) return [];
          const reference = memory.rootReference(record.allocationId);
          return reference && isArray(reference.type) && reference.type.length !== null
            ? [{ record, reference }]
            : [];
        });
        const visible = candidates.slice(0, maxArrayObjects);
        const arrays = visible.map(({ record, reference }): DebugArraySnapshot => {
          const arrayType = reference.type;
          if (!isArray(arrayType) || arrayType.length === null) {
            failure('ENGINE_INTERNAL_ERROR', 'El descriptor de array perdió su tipo completo.', debugObjectLocations!.get(record.allocationId) ?? location);
          }
          const length = arrayType.length;
          const elementType = arrayType.element;
          const elementTypeName = typeName(elementType, ir.aggregates);
          const at = debugObjectLocations!.get(record.allocationId) ?? location;
          let status: DebugArraySnapshot['status'];
          if (isArray(elementType)) status = 'multidimensional';
          else if (!isArithmetic(elementType)) status = 'unsupported-element-type';
          else if (length > maxElementsPerArray) status = 'too-many-elements';
          else status = 'available';

          let elements: readonly DebugArrayElementSnapshot[] = Object.freeze([]);
          if (status === 'available') {
            const elementSize = sizeOfType(elementType, ir.aggregates, at);
            const cells: DebugArrayElementSnapshot[] = [];
            for (let index = 0; index < length; index += 1) {
              const inspected = memory.inspectArrayElement(reference, index, at);
              const initialized = inspected?.initialized === true && inspected.value !== undefined;
              const fullValue = initialized ? debugScalarValue(elementType, inspected.value!) : '?';
              const valueTruncated = initialized && fullValue.length > maxValueChars;
              cells.push(Object.freeze({
                key: `${record.allocationId}:${index}`,
                index,
                address: `0x${(record.addressVirtual + BigInt(index) * BigInt(elementSize)).toString(16)}`,
                type: elementTypeName,
                initialized,
                displayValue: valueTruncated ? fullValue.slice(0, maxValueChars) : fullValue,
                valueTruncated,
              }) satisfies DebugArrayElementSnapshot);
            }
            elements = Object.freeze(cells);
          }
          return Object.freeze({
            rootId: record.allocationId,
            ...(record.name === undefined ? {} : { name: record.name }),
            origin: record.origin as DebugArraySnapshot['origin'],
            duration: record.duration as DebugArraySnapshot['duration'],
            region: record.duration === 'automatic' ? 'stack' : 'static',
            frameId: record.frameId,
            scopeId: record.scopeId,
            type: typeName(arrayType, ir.aggregates),
            elementType: elementTypeName,
            address: `0x${record.addressVirtual.toString(16)}`,
            size: record.size,
            length,
            readOnly: record.readOnly || memory.isReadOnly(reference, at),
            status,
            elements,
          }) satisfies DebugArraySnapshot;
        });
        return Object.freeze({ arrays: Object.freeze(arrays), omittedObjects: candidates.length - visible.length });
      };
      inspectDebugAggregates = (): DebugAggregateInspection => {
        const candidates = [...debugObjects.values()].flatMap((record) => {
          if ((record.duration !== 'automatic' && record.duration !== 'static') ||
              (record.origin !== 'variable' && record.origin !== 'parameter')) return [];
          const reference = memory.rootReference(record.allocationId);
          return reference && isAggregate(reference.type) ? [{ record, reference }] : [];
        });
        const visible = candidates.slice(0, maxArrayObjects);
        const aggregates = visible.map(({ record, reference }): DebugAggregateSnapshot => {
          if (!isAggregate(reference.type)) {
            failure('ENGINE_INTERNAL_ERROR', 'El descriptor de agregado perdió su tipo.', debugObjectLocations!.get(record.allocationId) ?? location);
          }
          const aggregateType = reference.type;
          const definition = ir.aggregates.find((candidate) => candidate.id === aggregateType.id);
          if (!definition?.complete || definition.size === undefined) {
            failure('ENGINE_INTERNAL_ERROR', 'El descriptor de agregado no tiene layout completo.', debugObjectLocations!.get(record.allocationId) ?? location);
          }
          const at = debugObjectLocations!.get(record.allocationId) ?? location;
          let status: DebugAggregateStatus = definition.kind === 'union'
            ? 'unsupported-union'
            : definition.members.length > DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers
              ? 'too-many-members'
              : 'available';

          let members: readonly DebugAggregateMemberSnapshot[] = Object.freeze([]);
          let padding: readonly DebugAggregatePaddingSnapshot[] = Object.freeze([]);
          if (status === 'available') {
            members = Object.freeze(definition.members.map((member): DebugAggregateMemberSnapshot => {
              const memberSize = sizeOfType(member.type, ir.aggregates, member.location);
              const memberAddress = `0x${(record.addressVirtual + BigInt(member.offset)).toString(16)}`;
              const common = {
                key: `${record.allocationId}:${member.index}`,
                index: member.index,
                name: member.name,
                type: typeName(member.type, ir.aggregates),
                offset: member.offset,
                size: memberSize,
                address: memberAddress,
              };
              if (isArithmetic(member.type)) {
                const inspected = memory.inspectAggregateScalar(reference, member.index, member.location);
                return Object.freeze({
                  ...common,
                  kind: 'arithmetic',
                  initialized: inspected.initialized,
                  displayValue: inspected.initialized && inspected.value !== undefined
                    ? debugScalarValue(member.type, inspected.value)
                    : '?',
                }) satisfies DebugAggregateMemberSnapshot;
              }
              if (isPointer(member.type)) {
                const inspected = memory.inspectAggregatePointer(reference, member.index, member.location);
                let target: DebugAggregateMemberSnapshot['target'];
                if (inspected.target) {
                  const targetType = debugTypeSummary(member.type.base, ir.aggregates);
                  const targetRecord = debugObjects.get(inspected.target.allocationId);
                  const targetName = inspected.target.byteOffset === 0 && targetRecord?.typeSummary === targetType
                    ? targetRecord.name
                    : undefined;
                  target = Object.freeze({
                    allocationId: inspected.target.allocationId,
                    byteOffset: inspected.target.byteOffset,
                    type: targetType,
                    ...(targetName === undefined ? {} : { name: targetName }),
                  });
                }
                return Object.freeze({
                  ...common,
                  kind: 'pointer',
                  initialized: inspected.initialized,
                  displayValue: inspected.address === undefined ? '?' : `0x${inspected.address.toString(16)}`,
                  pointerStatus: inspected.status,
                  ...(target === undefined ? {} : { target }),
                }) satisfies DebugAggregateMemberSnapshot;
              }
              return Object.freeze({
                ...common,
                kind: 'unsupported',
                initialized: null,
                displayValue: null,
                unsupportedReason: isArray(member.type) ? 'array' : 'aggregate',
              }) satisfies DebugAggregateMemberSnapshot;
            }));

            const paddingRanges: DebugAggregatePaddingSnapshot[] = [];
            let endOfLastMember = 0;
            for (const member of definition.members) {
              if (member.offset > endOfLastMember) {
                paddingRanges.push(Object.freeze({
                  key: `${record.allocationId}:padding:${endOfLastMember}`,
                  offset: endOfLastMember,
                  size: member.offset - endOfLastMember,
                }));
              }
              endOfLastMember = Math.max(endOfLastMember, member.offset + sizeOfType(member.type, ir.aggregates, member.location));
            }
            if (definition.size! > endOfLastMember) {
              paddingRanges.push(Object.freeze({
                key: `${record.allocationId}:padding:${endOfLastMember}`,
                offset: endOfLastMember,
                size: definition.size! - endOfLastMember,
              }));
            }
            padding = Object.freeze(paddingRanges);
          }

          return Object.freeze({
            rootId: record.allocationId,
            ...(record.name === undefined ? {} : { name: record.name }),
            origin: record.origin as DebugAggregateSnapshot['origin'],
            duration: record.duration as DebugAggregateSnapshot['duration'],
            region: record.duration === 'automatic' ? 'stack' : 'static',
            frameId: record.frameId,
            scopeId: record.scopeId,
            type: typeName(reference.type, ir.aggregates),
            kind: definition.kind,
            address: `0x${record.addressVirtual.toString(16)}`,
            size: record.size,
            readOnly: record.readOnly || memory.isReadOnly(reference, at),
            memberCount: definition.members.length,
            status,
            members,
            padding,
          }) satisfies DebugAggregateSnapshot;
        });
        return Object.freeze({ aggregates: Object.freeze(aggregates), omittedObjects: candidates.length - visible.length });
      };
      inspectDebugHeapObjects = (): readonly DebugHeapObjectSnapshot[] => Object.freeze(
        [...debugObjects.values()]
          .filter((record) => record.duration === 'heap')
          .sort((left, right) => left.addressVirtual < right.addressVirtual ? -1 : left.addressVirtual > right.addressVirtual ? 1 : 0)
          .map((record) => Object.freeze({
            id: record.allocationId,
            address: `0x${record.addressVirtual.toString(16)}`,
            size: record.size,
            origin: 'heap',
          }) satisfies DebugHeapObjectSnapshot),
      );
    }
    let nextDebugFrameId = 1;
    let nextDebugScopeId = 1;
    const createDebugObjectRecord = (reference: ObjectReference, metadata: DebugObjectMetadata): DebugObjectRecord => {
      const description = memory.describeObject(reference, metadata.location);
      const record: DebugObjectRecord = {
        objectId: description.objectId,
        allocationId: description.allocationId,
        duration: metadata.duration,
        origin: metadata.origin,
        typeSummary: metadata.typeSummary,
        addressVirtual: description.addressVirtual,
        size: description.size,
        frameId: metadata.frameId,
        scopeId: metadata.scopeId,
        readOnly: metadata.readOnly === true || memory.isReadOnly(reference, metadata.location),
        ...(metadata.name === undefined ? {} : { name: metadata.name }),
      };
      debugObjects!.set(record.allocationId, record);
      debugObjectLocations!.set(record.allocationId, metadata.location);
      debugEvents!.commit({
        kind: 'object-create',
        objectId: record.objectId,
        allocationId: record.allocationId,
        duration: record.duration,
        origin: record.origin,
        ...(record.name === undefined ? {} : { name: record.name }),
        typeSummary: record.typeSummary,
        addressVirtual: record.addressVirtual,
        size: record.size,
        location: metadata.location,
        frameId: metadata.frameId,
        scopeId: metadata.scopeId,
      });
      return record;
    };
    const allocateDebugObject = (
      allocate: () => ObjectReference,
      metadata: DebugObjectMetadata,
    ): ObjectReference => {
      if (!debugEvents) return allocate();
      debugEvents.reserve(metadata.location);
      try {
        const reference = allocate();
        createDebugObjectRecord(reference, metadata);
        return reference;
      } catch (error) {
        debugEvents.cancel();
        throw error;
      }
    };
    const publishDebugObject = (reference: ObjectReference, metadata: DebugObjectMetadata): void => {
      if (!debugEvents || !debugObjects || debugObjects.has(reference.allocationId)) return;
      debugEvents.reserve(metadata.location);
      try {
        createDebugObjectRecord(reference, metadata);
      } catch (error) {
        debugEvents.cancel();
        throw error;
      }
    };
    const publishAutomaticBinding = (
      frame: Frame,
      scope: RuntimeScope,
      binding: Binding,
      reference: ObjectReference,
    ): void => {
      if (binding.storageDuration === 'static') return;
      publishDebugObject(reference, {
        duration: 'automatic', origin: binding.isParameter ? 'parameter' : 'variable',
        typeSummary: debugTypeSummary(binding.type, ir.aggregates),
        location: binding.location, frameId: frame.frameId, scopeId: scope.scopeId, name: binding.name,
        readOnly: binding.isConst === true,
      });
    };
    const allocateDebugHeap = (bytes: number, at: Location): ObjectPointerValue | null => {
      if (!debugEvents || bytes === 0) return memory.allocateRaw(bytes, at);
      debugEvents.reserve(at);
      try {
        const pointer = memory.allocateRaw(bytes, at);
        if (!pointer) {
          debugEvents.cancel();
          return null;
        }
        const reference = memory.rootReference(pointer.allocationId);
        if (!reference) failure('ENGINE_INTERNAL_ERROR', 'Falta la raíz de una asignación heap recién creada.', at);
        createDebugObjectRecord(reference, {
          duration: 'heap', origin: 'heap', typeSummary: 'untyped heap block', location: at,
          frameId: null, scopeId: null,
        });
        return pointer;
      } catch (error) {
        debugEvents.cancel();
        throw error;
      }
    };
    const reallocateDebugHeap = (
      pointer: ObjectPointerValue | null,
      bytes: number,
      at: Location,
    ): ObjectPointerValue | null => {
      if (!debugEvents || !debugObjects || pointer === null) {
        return pointer === null ? allocateDebugHeap(bytes, at) : memory.reallocateRaw(pointer, bytes, at);
      }

      const oldReference = memory.canFree(pointer) ? memory.rootReference(pointer.allocationId) : undefined;
      if (!oldReference) return memory.reallocateRaw(pointer, bytes, at);

      const hasOldRecord = debugObjects.has(pointer.allocationId);
      const reservedEvents = bytes === 0 ? Number(hasOldRecord) : Number(hasOldRecord) + 1;
      debugEvents.reserveMany(reservedEvents, at);

      let resized: ObjectPointerValue | null;
      try {
        resized = memory.reallocateRaw(pointer, bytes, at);
      } catch (error) {
        debugEvents.cancelMany(reservedEvents);
        throw error;
      }
      if (bytes === 0 || resized === null) {
        if (resized === null && bytes > 0) {
          debugEvents.cancelMany(reservedEvents);
        } else if (hasOldRecord && oldReference) {
          commitDebugObjectDelete(oldReference, at, null, null);
        }
        return null;
      }

      const newReference = memory.rootReference(resized.allocationId);
      if (!newReference) {
        debugEvents.cancelMany(reservedEvents);
        failure('ENGINE_INTERNAL_ERROR', 'Falta la raíz de una reasignación heap recién creada.', at);
      }
      if (hasOldRecord && oldReference) commitDebugObjectDelete(oldReference, at, null, null);
      createDebugObjectRecord(newReference, {
        duration: 'heap', origin: 'heap', typeSummary: 'untyped heap block', location: at,
        frameId: null, scopeId: null,
      });
      return resized;
    };
    const commitDebugObjectDelete = (
      reference: ObjectReference,
      at: Location,
      frameId: number | null,
      scopeId: number | null,
    ): void => {
      if (!debugEvents || !debugObjects) return;
      const record = debugObjects.get(reference.allocationId);
      if (!record) return;
      debugEvents.commit({
        kind: 'object-delete', objectId: record.objectId, allocationId: record.allocationId,
        duration: record.duration, origin: record.origin,
        ...(record.name === undefined ? {} : { name: record.name }),
        typeSummary: record.typeSummary, addressVirtual: record.addressVirtual, size: record.size,
        location: at, frameId, scopeId,
      });
      debugObjects.delete(reference.allocationId);
    };
    const work: (() => void)[] = [];
    const operands: Evaluation[] = [];
    const globalReferences = new Map<number, ObjectReference>();
    const initializedStaticExpressions = new WeakSet<object>();
    const initializedStaticBindings = new WeakSet<Binding>();
    const preparedStaticBindings = new WeakSet<Binding>();
    const vaCursors = new Map<number, VaCursor>();
    const filePointers = new Map<string, VirtualStream>();
    const filePointerValues = new Map<VirtualStream, CValue>();
    let errnoReference: ObjectReference | undefined;
    let errnoPointer: CValue | undefined;
    const getErrnoReference = (): ObjectReference => {
      if (!errnoReference) {
        errnoReference = memory.allocate('int', 'static', runtimeLocation);
        memory.zeroInitialize(errnoReference, runtimeLocation);
      }
      return errnoReference;
    };
    let scopeDepth = 0;
    let callDepth = 0;

    const pointerKey = (value: CValue): string | undefined => {
      if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') return undefined;
      return `${value.value.allocationId}:${value.value.byteOffset}`;
    };
    const markerId = (value: CValue): number | undefined => {
      if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') return undefined;
      return value.value.allocationId;
    };
    const asBytePointer = (pointer: CValue, at: Location): CValue => {
      if (!isPointer(pointer.type) || pointer.value === null || typeof pointer.value !== 'object' || pointer.value.kind !== 'object-pointer') {
        failure('INVALID_POINTER_ACCESS', 'La operación de memoria requiere un puntero a objeto no nulo.', at);
      }
      return { type: pointerTo('unsigned char'), value: pointer.value };
    };
    const readBytes = (pointer: CValue, count: number, at: Location): Uint8Array => {
      if (!Number.isSafeInteger(count) || count < 0) failure('INVALID_MEMORY_SIZE', 'La lectura solicita una cantidad de bytes no representable.', at);
      if (count === 0) return new Uint8Array();
      const bytePointer = asBytePointer(pointer, at);
      const address = bytePointer.value as ObjectPointerValue;
      if (count > address.boundsEnd - address.byteOffset) failure('POINTER_BOUNDS', 'La lectura excede el objeto apuntado.', at);
      const bytes = new Uint8Array(count);
      for (let index = 0; index < count; index++) {
        const current = { ...address, byteOffset: address.byteOffset + index };
        const ref = memory.dereference({ type: bytePointer.type, value: current }, at);
        const value = memory.read(ref, at).value;
        if (typeof value !== 'bigint') failure('INVALID_OBJECT_REPRESENTATION', 'El byte leído no tiene una representación entera.', at);
        bytes[index] = Number(BigInt.asUintN(8, value));
      }
      return bytes;
    };
    const preflightMemoryWrite = (pointer: CValue, count: number, at: Location): void => {
      if (!Number.isSafeInteger(count) || count < 0) failure('INVALID_MEMORY_SIZE', 'La escritura solicita una cantidad de bytes no representable.', at);
      if (count === 0) return;
      const bytePointer = asBytePointer(pointer, at);
      const address = bytePointer.value as ObjectPointerValue;
      if (count > address.boundsEnd - address.byteOffset) failure('POINTER_BOUNDS', 'La escritura excede el objeto apuntado.', at);
      for (let index = 0; index < count; index++) {
        const current = { ...address, byteOffset: address.byteOffset + index };
        memory.dereference({ type: bytePointer.type, value: current }, at);
      }
    };
    const writeBytes = (pointer: CValue, bytes: Uint8Array, at: Location): void => {
      preflightMemoryWrite(pointer, bytes.length, at);
      if (!bytes.length) return;
      const bytePointer = asBytePointer(pointer, at);
      const address = bytePointer.value as ObjectPointerValue;
      for (let index = 0; index < bytes.length; index++) {
        const current = { ...address, byteOffset: address.byteOffset + index };
        const ref = memory.dereference({ type: bytePointer.type, value: current }, at);
        memory.write(ref, { type: 'unsigned char', value: BigInt(bytes[index]) }, at);
      }
    };
    const readCString = (pointer: CValue, at: Location): Uint8Array => {
      const bytePointer = asBytePointer(pointer, at);
      const address = bytePointer.value as ObjectPointerValue;
      if (address.byteOffset < address.boundsStart || address.byteOffset >= address.boundsEnd) {
        failure('POINTER_BOUNDS', 'La cadena empieza fuera del objeto apuntado.', at);
      }
      const bytes: number[] = [];
      for (let offset = address.byteOffset; offset < address.boundsEnd; offset++) {
        const current = { ...address, byteOffset: offset };
        const ref = memory.dereference({ type: bytePointer.type, value: current }, at);
        const value = memory.read(ref, at).value;
        if (typeof value !== 'bigint') failure('INVALID_OBJECT_REPRESENTATION', 'El byte de una cadena no es entero.', at);
        const byte = Number(BigInt.asUintN(8, value));
        if (byte === 0) return Uint8Array.from(bytes);
        bytes.push(byte);
      }
      failure('UNTERMINATED_STRING', 'La cadena no contiene un NUL dentro del objeto apuntado.', at);
    };
    const copyBytes = (destination: CValue, source: CValue, count: number, at: Location): void => {
      if (count === 0) {
        writeBytes(destination, readBytes(source, count, at), at);
        return;
      }
      const bytes = readBytes(source, count, at);
      const sourceAddress = asBytePointer(source, at).value as ObjectPointerValue;
      const pointerValues = memory.copyablePointerValues(sourceAddress, count, at);
      const destinationAddress = asBytePointer(destination, at).value as ObjectPointerValue;
      writeBytes(destination, bytes, at);
      memory.restoreCopiedPointerValues(destinationAddress, count, pointerValues, at);
    };
    const writeScalar = (pointer: CValue, value: CValue, at: Location): void => {
      const reference = memory.dereference(pointer, at);
      memory.write(reference, valueForType(value, reference.type, at), at);
    };
    const chargeWork = (count: number, at: Location): void => {
      if (!Number.isSafeInteger(count) || count < 0) failure('INVALID_WORK_SIZE', 'El trabajo solicitado no es representable.', at);
      metrics.instructionCount += count;
      enforceLimit('maxInstructions', metrics.instructionCount, limits.maxInstructions, at);
    };
    const standardFiles = new Map<'stdin' | 'stdout' | 'stderr', CValue>();
    const standardFileKeys = new Set<string>();
    const makeFilePointer = (stream: VirtualStream, at: Location): CValue => {
      const known = filePointerValues.get(stream);
      if (known) return known;
      const marker = memory.allocate('char', 'static', at);
      const value = memory.addressOf(marker, pointerTo('char'));
      filePointers.set(pointerKey(value)!, stream);
      filePointerValues.set(stream, value);
      return value;
    };
    const standardFile = (kind: 'stdin' | 'stdout' | 'stderr', at: Location): CValue => {
      const known = standardFiles.get(kind);
      if (known) return known;
      const stream = kind === 'stdin' ? io!.stdin : kind === 'stdout' ? io!.stdout : io!.stderr;
      const value = makeFilePointer(stream, at);
      standardFiles.set(kind, value);
      standardFileKeys.add(pointerKey(value)!);
      return value;
    };
    const streamFor = (file: CValue, at: Location): VirtualStream | null => {
      if (file.value === null) return null;
      const key = pointerKey(file);
      if (!key) return null;
      const stream = filePointers.get(key) ?? null;
      if (stream?.isClosed) return null;
      void at;
      return stream;
    };
    const libraryContext: LibraryRuntimeContext = {
      get at() { return runtimeLocation; },
      get io() { return io!; },
      readBytes,
      writeBytes,
      readCString,
      copyBytes,
      writeScalar,
      formatPointer: (value, at) => memory.formatPointer(value, at),
      parsePointer: (text, at) => memory.parsePointer(text, at),
      openFile: (path, mode, at) => {
        const stream = io!.open(path, mode, at);
        return stream ? makeFilePointer(stream, at) : null;
      },
      streamFor,
      standardFile,
      makeFilePointer,
      closeFilePointer: (file, at) => {
        const key = pointerKey(file);
        if (!key || standardFileKeys.has(key)) return -1;
        const stream = filePointers.get(key);
        if (!stream || !stream.close()) return -1;
        filePointers.delete(key);
        filePointerValues.delete(stream);
        void at;
        return 0;
      },
      errno: {
        get: () => {
          const value = memory.read(getErrnoReference(), runtimeLocation).value;
          return typeof value === 'bigint' ? Number(value) : 0;
        },
        set: (value) => memory.write(getErrnoReference(), integer(BigInt(value), 'int'), runtimeLocation),
      },
      makeErrnoPointer: () => {
        if (!errnoPointer) errnoPointer = memory.addressOf(getErrnoReference(), pointerTo('int'));
        return errnoPointer;
      },
      makeInt: (value, type) => {
        const target = typeof type === 'string' && isInteger(type) ? type : 'int';
        return valueForType(integer(value, target), target, runtimeLocation);
      },
      chargeWork,
      preflightOutputBytes: (count, at) => io!.preflightBufferBytes(count, at),
      preflightMemoryWrite,
      offsetPointer: (pointer, byteOffset, at) => {
        if (!Number.isSafeInteger(byteOffset)) failure('INVALID_POINTER_ARITHMETIC', 'El desplazamiento en bytes no es representable.', at);
        const bytes = asBytePointer(pointer, at);
        return { type: pointer.type, value: { ...(bytes.value as ObjectPointerValue), byteOffset: (bytes.value as ObjectPointerValue).byteOffset + byteOffset } };
      },
      makeString: (bytes, at) => {
        const reference = memory.allocate(arrayOf('char', bytes.length + 1), 'static', at);
        memory.zeroInitialize(reference, at);
        if (bytes.length) writeBytes(memory.decay(reference), bytes, at);
        return memory.decay(reference);
      },
      fail: (code, message, at) => failure(code, message, at),
    };

    const instruction = (at: Location) => {
      runtimeLocation = at;
      io!.setLocation(at);
      metrics.instructionCount++;
      enforceLimit('maxInstructions', metrics.instructionCount, limits.maxInstructions, at);
    };
    const localCell = (frame: Frame, binding: number, at: Location): Cell => {
      const result = frame.cells.get(binding);
      if (!result) failure('INACTIVE_OBJECT', 'La variable no pertenece a un ámbito activo.', at);
      return result;
    };
    const globalReference = (binding: number, at: Location): ObjectReference => {
      const result = globalReferences.get(binding);
      if (!result) failure('UNKNOWN_OBJECT', 'No existe el objeto global solicitado.', at);
      return result;
    };
    const valueForType = (value: CValue, type: CValue['type'], at: Location): CValue => {
      if (type === '_Bool' && (isPointer(value.type) || value.value === null ||
          (typeof value.value === 'object' && value.value !== null &&
            ((value.value as { kind?: string }).kind === 'object-pointer' || (value.value as { kind?: string }).kind === 'function-pointer')))) {
        return integer(value.value !== null, '_Bool');
      }
      if (isPointer(type)) {
        if (value.value === null) return { type, value: null };
        if (typeof value.value === 'bigint' && value.value === 0n) return { type, value: null };
        if (typeof value.value === 'object' && value.value !== null) {
          const kind = (value.value as { kind?: string }).kind;
          if (kind === 'object-pointer') {
            if (isFunction(type.base)) failure('INVALID_POINTER_CONVERSION', 'Un puntero a objeto no se puede convertir a puntero a función.', at);
            return { type, value: value.value as ObjectPointerValue };
          }
          if (kind === 'function-pointer') {
            if (!isFunction(type.base)) failure('INVALID_POINTER_CONVERSION', 'Un puntero a función no se puede convertir a puntero a objeto.', at);
            return { type, value: value.value };
          }
        }
        failure('INVALID_POINTER_CONVERSION', 'La conversión a puntero requiere un puntero compatible o una constante nula.', at);
      }
      if (isAggregate(type)) {
        if (isAggregate(value.type) && value.type.id === type.id &&
            typeof value.value === 'object' && value.value !== null &&
            (value.value as { kind?: string }).kind === 'aggregate-value') {
          return { type, value: value.value };
        }
        failure('INVALID_AGGREGATE_CONVERSION', 'La conversión por valor requiere el mismo tipo de struct o union.', at);
      }
      return convert(value, type, at);
    };
    const truthValue = (value: CValue): boolean => truth(value, runtimeLocation);
    const addAccess = (evaluation: Evaluation, objectId: number, access: Access): void => {
      const previous = evaluation.accesses.get(objectId);
      evaluation.accesses.set(objectId, {
        read: access.read || !!previous?.read,
        write: access.write || !!previous?.write,
        name: previous?.name ?? access.name,
      });
    };
    const mergeEffects = (left: Evaluation, right: Evaluation, at: Location, sequenced = false): Evaluation => {
      const accesses = new Map(left.accesses);
      for (const [objectId, access] of right.accesses) {
        const previous = accesses.get(objectId);
        if (!sequenced && previous && ((previous.write && (access.write || access.read)) ||
            (access.write && previous.read))) {
          failure('UNSEQUENCED_ACCESS', 'Accesos no secuenciados a «' + (previous.name || access.name) + '»: comportamiento indefinido en C11.', at);
        }
        accesses.set(objectId, {
          read: access.read || !!previous?.read,
          write: access.write || !!previous?.write,
          name: previous?.name ?? access.name,
        });
      }
      return {
        accesses,
        pendingWrites: sequenced ? new Set(right.pendingWrites) : new Set([...left.pendingWrites, ...right.pendingWrites]),
      };
    };
    const referenceEvaluation = (reference: ObjectReference, label: string, effects?: Evaluation): Evaluation => ({
      reference,
      label,
      accesses: effects ? new Map(effects.accesses) : new Map(),
      pendingWrites: effects ? new Set(effects.pendingWrites) : new Set(),
    });
    const markRead = (evaluation: Evaluation, reference: ObjectReference, label: string): void => {
      addAccess(evaluation, reference.objectId, { read: true, write: false, name: label });
    };
    const markWrite = (evaluation: Evaluation, reference: ObjectReference, label: string): void => {
      addAccess(evaluation, reference.objectId, { read: false, write: true, name: label });
      evaluation.pendingWrites.add(reference.objectId);
    };
    const materialize = (evaluation: Evaluation, at: Location): CValue => {
      if (evaluation.value) return evaluation.value;
      const reference = evaluation.reference;
      if (!reference) failure('INVALID_LVALUE', 'La expresión no designa un valor ni un objeto.', at);
      if (isArray(reference.type)) {
        evaluation.value = memory.decay(reference);
      } else if (isFunction(reference.type)) {
        failure('INVALID_OBJECT', 'Una función no se puede leer como un objeto.', at);
      } else {
        evaluation.value = memory.read(reference, at);
        markRead(evaluation, reference, evaluation.label ?? 'objeto');
      }
      evaluation.reference = undefined;
      return evaluation.value;
    };
    const aggregateDefinition = (type: CValue['type'], at: Location): AggregateDefinition => {
      if (!isAggregate(type)) failure('INVALID_MEMBER', 'El acceso a miembros requiere un struct o union.', at);
      const definition = ir.aggregates.find((candidate) => candidate.id === type.id);
      if (!definition || !definition.complete) failure('INCOMPLETE_TYPE', 'El objeto agregado está incompleto.', at);
      return definition;
    };
    const immediateSubobject = (reference: ObjectReference, type: CValue['type'], index: number, at: Location): { reference: ObjectReference; type: CValue['type'] } => {
      if (!Number.isSafeInteger(index) || index < 0) failure('INVALID_INITIALIZER', 'El inicializador selecciona un subobjeto no válido.', at);
      if (isArray(type)) {
        if (type.length === null || index >= type.length) failure('INITIALIZER_BOUNDS', 'El inicializador excede la longitud del array.', at);
        const child = memory.element(reference, index, at);
        return { reference: child, type: type.element };
      }
      if (isAggregate(type)) {
        const definition = aggregateDefinition(type, at);
        const member = definition.members[index];
        if (!member) failure('INITIALIZER_BOUNDS', 'El inicializador excede los miembros del agregado.', at);
        return { reference: memory.member(reference, index, at), type: member.type };
      }
      if (index !== 0) failure('EXCESS_INITIALIZERS', 'Un objeto escalar sólo admite un inicializador.', at);
      return { reference, type };
    };
    const designatedSubobject = (
      root: ObjectReference, rootType: CValue['type'], designators: readonly InitializerDesignator[],
    ): { reference: ObjectReference; type: CValue['type']; firstIndex: number } => {
      let reference = root;
      let type = rootType;
      let firstIndex = 0;
      for (let position = 0; position < designators.length; position++) {
        const designator = designators[position];
        let index: number;
        if (designator.kind === 'member') {
          const definition = aggregateDefinition(type, designator.location);
          index = designator.memberIndex ?? definition.members.findIndex((member) => member.name === designator.name);
          if (index < 0) failure('UNKNOWN_MEMBER', 'El agregado no tiene un miembro llamado «' + designator.name + '».', designator.location);
        } else {
          if (!isArray(type)) failure('INVALID_DESIGNATOR', 'Un designador de índice requiere un array.', designator.location);
          if (designator.index > BigInt(Number.MAX_SAFE_INTEGER)) failure('INITIALIZER_BOUNDS', 'El índice del inicializador excede el rango representable.', designator.location);
          index = Number(designator.index);
        }
        if (position === 0) firstIndex = index;
        const child = immediateSubobject(reference, type, index, designator.location);
        reference = child.reference;
        type = child.type;
      }
      return { reference, type, firstIndex };
    };

    function* scalarSubobjects(root: ObjectReference, rootType: CValue['type'], at: Location): Generator<{ reference: ObjectReference; type: CValue['type'] }> {
      const pending: { reference: ObjectReference; type: CValue['type']; next: number }[] = [{ reference: root, type: rootType, next: 0 }];
      while (pending.length) {
        const current = pending.at(-1)!;
        if (isArray(current.type)) {
          if (current.type.length === null) failure('INCOMPLETE_TYPE', 'El array del inicializador está incompleto.', at);
          if (current.next >= current.type.length) { pending.pop(); continue; }
          const index = current.next++;
          pending.push({ reference: memory.element(current.reference, index, at), type: current.type.element, next: 0 });
        } else if (isAggregate(current.type)) {
          const definition = aggregateDefinition(current.type, at);
          const count = definition.kind === 'union' ? Math.min(definition.members.length, 1) : definition.members.length;
          if (current.next >= count) { pending.pop(); continue; }
          const index = current.next++;
          pending.push({ reference: memory.member(current.reference, index, at), type: definition.members[index].type, next: 0 });
        } else {
          yield { reference: current.reference, type: current.type };
          pending.pop();
        }
      }
    }

    const initializeObject = (reference: ObjectReference, type: CValue['type'], initializer: Initializer, frame: Frame, depth = 1): void => {
      if (initializer.kind === 'expression') {
        const expression = initializer.value;
        if (isArray(type) && type.element === 'char' && expression.kind === 'string') {
          if (type.length === null) failure('INCOMPLETE_TYPE', 'El array de caracteres no tiene una longitud completa.', initializer.location);
          if (expression.bytes.length > type.length + 1) failure('INITIALIZER_BOUNDS', 'El literal de cadena es más largo que el array de destino.', initializer.location);
          memory.zeroInitialize(reference, initializer.location);
          const count = Math.min(type.length, expression.bytes.length);
          for (let index = 0; index < count; index++) {
            const element = memory.element(reference, index, initializer.location);
            memory.write(element, valueForType(integer(BigInt.asIntN(8, BigInt(expression.bytes[index]))), type.element, initializer.location), initializer.location);
          }
          return;
        }
        evaluateFullExpression(expression, frame, () => {
          const result = operands.pop();
          if (!result) failure('ENGINE_STACK_ERROR', 'Falta el valor del inicializador.', initializer.location);
          const value = materialize(result, initializer.location);
          memory.write(reference, valueForType(value, type, initializer.location), initializer.location);
        }, depth + 1);
        return;
      }

      memory.zeroInitialize(reference, initializer.location);
      if (isArray(type) && type.element === 'char' && initializer.items.length === 1 &&
          initializer.items[0].designators.length === 0 && initializer.items[0].initializer.kind === 'expression' &&
          initializer.items[0].initializer.value.kind === 'string') {
        initializeObject(reference, type, initializer.items[0].initializer, frame, depth + 1);
        return;
      }
      if ((isArray(type) || isAggregate(type)) && initializer.items.length > 0 &&
          initializer.items.every((item) => item.designators.length === 0 && item.initializer.kind === 'expression' &&
            !!item.initializer.value.type && isScalar(item.initializer.value.type))) {
        const slots = scalarSubobjects(reference, type, initializer.location);
        const jobs: { reference: ObjectReference; type: CValue['type']; initializer: Initializer }[] = [];
        for (const item of initializer.items) {
          const slot = slots.next();
          if (slot.done) failure('EXCESS_INITIALIZERS', 'El inicializador contiene más valores que subobjetos.', item.location);
          jobs.push({ ...slot.value, initializer: item.initializer });
        }
        for (let index = jobs.length - 1; index >= 0; index--) {
          const job = jobs[index];
          work.push(() => initializeObject(job.reference, job.type, job.initializer, frame, depth + 1));
        }
        return;
      }
      const jobs: { reference: ObjectReference; type: CValue['type']; initializer: Initializer }[] = [];
      let nextIndex = 0;
      for (const item of initializer.items) {
        let selected: { reference: ObjectReference; type: CValue['type'] };
        if (item.designators.length) {
          const designated = designatedSubobject(reference, type, item.designators);
          selected = { reference: designated.reference, type: designated.type };
          nextIndex = designated.firstIndex + 1;
        } else if (isArray(type) || isAggregate(type)) {
          selected = immediateSubobject(reference, type, nextIndex++, item.location);
        } else {
          if (nextIndex++) failure('EXCESS_INITIALIZERS', 'Un objeto escalar sólo admite un inicializador.', item.location);
          selected = { reference, type };
        }
        jobs.push({ ...selected, initializer: item.initializer });
      }
      for (let index = jobs.length - 1; index >= 0; index--) {
        const job = jobs[index];
        work.push(() => initializeObject(job.reference, job.type, job.initializer, frame, depth + 1));
      }
    };
    const stringReference = (node: Extract<Expression, { kind: 'string' }>): ObjectReference => {
      // Parser IR carries the terminating NUL in bytes; VirtualMemory appends it
      // while constructing the read-only static object.
      const bytes = node.bytes.length && node.bytes[node.bytes.length - 1] === 0
        ? node.bytes.slice(0, -1)
        : node.bytes;
      const prior = debugEvents ? memory.findStaticObject(node) : undefined;
      if (prior) return prior;
      const allocate = () => memory.stringLiteral(node, bytes, node.location);
      return debugEvents
        ? allocateDebugObject(allocate, {
          duration: 'static', origin: 'string-literal',
          typeSummary: `char[${bytes.length + 1}]`, location: node.location,
          frameId: null, scopeId: null,
        })
        : allocate();
    };

    function evaluateFullExpression(
      expression: Expression,
      frame: Frame,
      consume: () => void,
      depth = 1,
      used = true,
    ): void {
      const previousToken = frame.fullExpressionToken;
      const token = {};
      frame.fullExpressionToken = token;
      // Keep aggregate rvalue storage alive while the enclosing expression is
      // consumed, then end the temporary objects' lifetime before the next op.
      work.push(() => {
        try { consume(); }
        finally {
          memory.releaseScope(token, expression.location);
          frame.fullExpressionToken = previousToken;
        }
      });
      evaluate(expression, frame, depth, used);
    }

    const operateBinary = (operator: string, left: CValue, right: CValue, at: Location): CValue => {
      const leftPointer = isPointer(left.type);
      const rightPointer = isPointer(right.type);
      if ((operator === '+' || operator === '-') && leftPointer && isInteger(right.type)) {
        const count = right.value;
        if (typeof count !== 'bigint') failure('INVALID_OPERAND_TYPE', 'El desplazamiento de un puntero debe ser entero.', at);
        return memory.pointerAdd(left, operator === '-' ? -count : count, at);
      }
      if (operator === '+' && rightPointer && isInteger(left.type)) {
        if (typeof left.value !== 'bigint') failure('INVALID_OPERAND_TYPE', 'El desplazamiento de un puntero debe ser entero.', at);
        return memory.pointerAdd(right, left.value, at);
      }
      if (operator === '-' && leftPointer && rightPointer) return memory.pointerDifference(left, right, at);
      if ((operator === '==' || operator === '!=') && (leftPointer || rightPointer)) {
        const pointerType = leftPointer ? left.type : right.type;
        const convertedLeft = valueForType(left, pointerType, at);
        const convertedRight = valueForType(right, pointerType, at);
        const leftFunction = typeof convertedLeft.value === 'object' && convertedLeft.value !== null &&
          (convertedLeft.value as { kind?: string }).kind === 'function-pointer';
        const rightFunction = typeof convertedRight.value === 'object' && convertedRight.value !== null &&
          (convertedRight.value as { kind?: string }).kind === 'function-pointer';
        let equal: boolean;
        if (convertedLeft.value === null || convertedRight.value === null) equal = convertedLeft.value === convertedRight.value;
        else if (leftFunction || rightFunction) {
          if (!leftFunction || !rightFunction) failure('INVALID_POINTER_COMPARISON', 'No se pueden comparar punteros a objetos y funciones.', at);
          equal = (convertedLeft.value as { functionIndex: number }).functionIndex === (convertedRight.value as { functionIndex: number }).functionIndex;
        } else equal = memory.pointerEqual(convertedLeft, convertedRight, at);
        return integer(operator === '==' ? equal : !equal);
      }
      if (['<', '<=', '>', '>='].includes(operator) && leftPointer && rightPointer) {
        return integer(memory.pointerRelationalCompare(left, right, operator, at));
      }
      return binary(operator, left, right, at);
    };

    function evaluate(root: Expression, frame: Frame, depth = 1, used = true, _wantLvalue = false): void {
      work.push(() => {
        const node = root;
        const at = node.location;
        instruction(at);
        enforceLimit('maxDepth', scopeDepth + depth, limits.maxDepth, at);
        if (node.kind === 'literal') operands.push(plain(node.value));
        else if (node.kind === 'string') operands.push(referenceEvaluation(stringReference(node), 'cadena'));
        else if (node.kind === 'variable') {
          const target = node.binding !== undefined
            ? localCell(frame, node.binding, at)
            : node.globalBinding !== undefined ? { binding: { id: node.globalBinding, name: node.name, type: node.type ?? 'int', location: at }, reference: globalReference(node.globalBinding, at) }
              : undefined;
          if (!target) failure('UNKNOWN_OBJECT', 'No se encontró la variable «' + node.name + '».', at);
          operands.push(referenceEvaluation(target.reference, node.name));
        } else if (node.kind === 'function') {
          const index = node.functionIndex ?? (node.symbolKey ? functionSymbolIndices.get(node.symbolKey) : undefined) ?? functionIndices.get(node.name);
          if (index === undefined || !functions[index]) failure('UNKNOWN_FUNCTION', 'No existe la función «' + node.name + '».', at);
          const functionType = node.type && isFunction(node.type) ? node.type : {
            kind: 'function' as const,
            returnType: functions[index].fn.returnType,
            parameters: functions[index].fn.parameters.map((parameter) => parameter.type),
          };
          operands.push(plain({ type: node.type && isPointer(node.type) ? node.type : pointerTo(functionType), value: { kind: 'function-pointer', functionIndex: index } }));
        } else if (node.kind === 'sizeof') {
          const type = node.valueType ?? node.operand?.type;
          if (!type) failure('INVALID_SIZEOF', 'No se pudo determinar el tipo del operando de sizeof.', at);
          operands.push(plain({ type: 'unsigned long', value: BigInt(sizeOfType(type, ir.aggregates, at)) }));
        } else if (node.kind === 'unary' && node.operator === '&') {
          if (node.operand.kind === 'index') {
            const subscript = node.operand;
            work.push(() => {
              const indexResult = operands.pop();
              const baseResult = operands.pop();
              if (!indexResult || !baseResult) failure('ENGINE_STACK_ERROR', 'Falta un operando de &(array[index]).', at);
              const indexValue = materialize(indexResult, at);
              if (!isInteger(indexValue.type) || typeof indexValue.value !== 'bigint') failure('INVALID_INDEX', 'El índice de array debe ser entero.', at);
              const baseValue = materialize(baseResult, at);
              if (!isPointer(baseValue.type)) failure('INVALID_INDEX', 'La dirección del subíndice requiere un puntero.', at);
              const result = memory.pointerAdd(baseValue, indexValue.value, at);
              const effects = mergeEffects(baseResult, indexResult, at);
              result.type = node.type && isPointer(node.type) ? node.type : result.type;
              effects.value = result;
              operands.push(effects);
            });
            evaluate(subscript.index, frame, depth + 1);
            evaluate(subscript.base, frame, depth + 1);
            return;
          }
          if (node.operand.kind === 'unary' && node.operand.operator === '*') {
            const dereference = node.operand;
            work.push(() => {
              const operand = operands.pop();
              if (!operand) failure('ENGINE_STACK_ERROR', 'Falta el operando de &*.', at);
              const pointer = materialize(operand, at);
              if (!isPointer(pointer.type)) failure('INVALID_OPERAND_TYPE', 'El operador * requiere un puntero.', at);
              if (node.type && isPointer(node.type)) pointer.type = node.type;
              operands.push(plain(pointer));
            });
            evaluate(dereference.operand, frame, depth + 1);
            return;
          }
          work.push(() => {
            const operand = operands.pop();
            if (!operand) failure('ENGINE_STACK_ERROR', 'Falta el operando de &.', at);
            if (operand.reference) {
              operands.push(plain(memory.addressOf(operand.reference, node.type && isPointer(node.type) ? node.type : pointerTo(operand.reference.type))));
            } else {
              const value = materialize(operand, at);
              if (typeof value.value === 'object' && value.value !== null &&
                  (value.value as { kind?: string }).kind === 'function-pointer') operands.push(plain(value));
              else failure('INVALID_LVALUE', 'El operador & requiere un objeto o función.', at);
            }
          });
          evaluate(node.operand, frame, depth + 1, true, true);
        } else if (node.kind === 'unary' && node.operator === '*') {
          work.push(() => {
            const operand = operands.pop();
            if (!operand) failure('ENGINE_STACK_ERROR', 'Falta el operando de *.', at);
            const pointer = materialize(operand, at);
            if (!isPointer(pointer.type)) failure('INVALID_OPERAND_TYPE', 'El operador * requiere un puntero.', at);
            if (isFunction(pointer.type.base)) operands.push(plain(pointer));
            else operands.push(referenceEvaluation(memory.dereference(pointer, at), 'objeto apuntado', operand));
          });
          evaluate(node.operand, frame, depth + 1);
        } else if (node.kind === 'unary') {
          work.push(() => {
            const result = operands.pop();
            if (!result) failure('ENGINE_STACK_ERROR', 'Falta el operando unario.', at);
            const value = materialize(result, at);
            result.value = node.operator === '!' ? integer(!truthValue(value)) : unary(node.operator, value, at);
            operands.push(result);
          });
          evaluate(node.operand, frame, depth + 1);
        } else if (node.kind === 'cast') {
          work.push(() => {
            const result = operands.pop();
            if (!result) failure('ENGINE_STACK_ERROR', 'Falta el operando del cast.', at);
            result.value = valueForType(materialize(result, at), node.targetType, at);
            result.reference = undefined;
            operands.push(result);
          });
          // An explicit cast to void discards the operand's value. In particular,
          // a non-void function may fall through when its result is discarded.
          evaluate(node.operand, frame, depth + 1, node.targetType !== 'void');
        } else if (node.kind === 'decay') {
          work.push(() => {
            const result = operands.pop();
            if (!result) failure('ENGINE_STACK_ERROR', 'Falta el operando de la conversión de array.', at);
            if (result.reference && isArray(result.reference.type)) {
              result.value = memory.decay(result.reference);
              result.reference = undefined;
            } else result.value = materialize(result, at);
            operands.push(result);
          });
          evaluate(node.operand, frame, depth + 1, true, true);
        } else if (node.kind === 'update') {
          work.push(() => {
            const target = operands.pop();
            if (!target?.reference) failure('INVALID_LVALUE', 'El incremento requiere un objeto modificable.', at);
            const reference = target.reference;
            if (isArray(reference.type) || isAggregate(reference.type) || isFunction(reference.type)) {
              failure('INVALID_LVALUE', 'El incremento requiere un escalar modificable.', at);
            }
            const old = memory.read(reference, at);
            const readEvaluation = plain(old);
            markRead(readEvaluation, reference, target.label ?? 'objeto');
            const combined = mergeEffects(target, readEvaluation, at);
            let next: CValue;
            if (isPointer(old.type)) next = memory.pointerAdd(old, node.operator === '++' ? 1n : -1n, at);
            else next = binary(node.operator === '++' ? '+' : '-', old, integer(1), at);
            next = valueForType(next, reference.type, at);
            memory.write(reference, next, at);
            markWrite(combined, reference, target.label ?? 'objeto');
            combined.value = node.prefix ? next : old;
            operands.push(combined);
          });
          evaluate(node.operand, frame, depth + 1, true, true);
        } else if (node.kind === 'assignment') {
          work.push(() => {
            const target = operands.pop();
            if (!target?.reference) failure('INVALID_LVALUE', 'La asignación requiere un objeto modificable.', at);
            const reference = target.reference;
            if (isArray(reference.type) || isAggregate(reference.type) && node.operator !== '=' || isFunction(reference.type)) {
              failure('INVALID_LVALUE', 'El destino de asignación no es un escalar modificable.', at);
            }
            const name = target.label ?? 'objeto';
            let old: CValue | undefined;
            if (node.operator !== '=') {
              old = memory.read(reference, at);
              markRead(target, reference, name);
            }
            work.push(() => {
              const right = operands.pop();
              if (!right) failure('ENGINE_STACK_ERROR', 'Falta el valor derecho de la asignación.', at);
              let effects = mergeEffects(target, right, at);
              let value = materialize(right, at);
              if (old) value = operateBinary(node.operator.slice(0, -1), old, value, at);
              if (right.pendingWrites.has(reference.objectId)) {
                failure('UNSEQUENCED_ACCESS', 'Escrituras no secuenciadas a «' + name + '».', at);
              }
              value = valueForType(value, reference.type, at);
              memory.write(reference, value, at);
              markWrite(effects, reference, name);
              effects.value = value;
              operands.push(effects);
            });
            evaluate(node.value, frame, depth + 1);
          });
          evaluate(node.target, frame, depth + 1, true, true);
        } else if (node.kind === 'index') {
          work.push(() => {
            const indexResult = operands.pop();
            const baseResult = operands.pop();
            if (!indexResult || !baseResult) failure('ENGINE_STACK_ERROR', 'Falta un operando de indexación.', at);
            const indexValue = materialize(indexResult, at);
            if (!isInteger(indexValue.type) || typeof indexValue.value !== 'bigint') {
              failure('INVALID_INDEX', 'El índice de array debe ser entero.', at);
            }
            let reference: ObjectReference;
            if (baseResult.reference && isArray(baseResult.reference.type)) {
              reference = memory.element(baseResult.reference, indexValue.value, at);
            } else {
              const base = materialize(baseResult, at);
              if (!isPointer(base.type)) failure('INVALID_INDEX', 'La indexación requiere un array o puntero.', at);
              reference = memory.dereference(memory.pointerAdd(base, indexValue.value, at), at);
            }
            const effects = mergeEffects(baseResult, indexResult, at);
            operands.push(referenceEvaluation(reference, 'elemento', effects));
          });
          evaluate(node.index, frame, depth + 1);
          evaluate(node.base, frame, depth + 1, true, true);
        } else if (node.kind === 'member') {
          work.push(() => {
            const baseResult = operands.pop();
            if (!baseResult) failure('ENGINE_STACK_ERROR', 'Falta el objeto del miembro.', at);
            let baseReference: ObjectReference;
            let effects = baseResult;
            if (node.arrow) {
              const pointer = materialize(baseResult, at);
              baseReference = memory.dereference(pointer, at);
            } else if (baseResult.reference) {
              baseReference = baseResult.reference;
            } else {
              const value = materialize(baseResult, at);
              if (!isAggregate(value.type)) failure('INVALID_MEMBER', 'El operador . requiere un valor agregado.', at);
              const temporary = memory.automaticObject(
                node, value.type, frame.fullExpressionToken ?? frame.scopes.at(-1)?.token ?? frame, at,
              );
              memory.write(temporary, value, at);
              baseReference = temporary;
              effects = plain(value);
            }
            const definition = aggregateDefinition(baseReference.type, at);
            const memberIndex = node.memberIndex ?? definition.members.findIndex((member) => member.name === node.name);
            if (memberIndex < 0 || !definition.members[memberIndex]) failure('UNKNOWN_MEMBER', 'El agregado no tiene un miembro llamado «' + node.name + '».', at);
            const memberReference = memory.member(baseReference, memberIndex, at);
            operands.push(referenceEvaluation(memberReference, node.name, effects));
          });
          evaluate(node.base, frame, depth + 1, true, !node.arrow);
        } else if (node.kind === 'conditional') {
          work.push(() => {
            const condition = operands.pop();
            if (!condition) failure('ENGINE_STACK_ERROR', 'Falta la condición de ?: .', at);
            const conditionValue = truthValue(materialize(condition, at));
            work.push(() => {
              const result = operands.pop();
              if (!result) failure('ENGINE_STACK_ERROR', 'Falta el resultado de ?: .', at);
              const value = valueForType(materialize(result, at), node.type ?? result.value!.type, at);
              const combined = mergeEffects(condition, result, at, true);
              combined.value = value;
              operands.push(combined);
            });
            evaluate(conditionValue ? node.then : node.else, frame, depth + 1, used);
          });
          evaluate(node.condition, frame, depth + 1);
        } else if (node.kind === 'binary') {
          work.push(() => {
            const left = operands.pop();
            if (!left) failure('ENGINE_STACK_ERROR', 'Falta el operando izquierdo.', at);
            const leftValue = materialize(left, at);
            if ((node.operator === '&&' && !truthValue(leftValue)) || (node.operator === '||' && truthValue(leftValue))) {
              left.value = integer(node.operator === '||' ? 1 : 0);
              left.pendingWrites.clear();
              operands.push(left);
              return;
            }
            work.push(() => {
              const right = operands.pop();
              if (!right) failure('ENGINE_STACK_ERROR', 'Falta el operando derecho.', at);
              const rightValue = materialize(right, at);
              const sequenced = [',', '&&', '||'].includes(node.operator);
              const result = node.operator === ','
                ? rightValue
                : node.operator === '&&' || node.operator === '||'
                  ? integer(truthValue(rightValue))
                  : operateBinary(node.operator, leftValue, rightValue, at);
              const combined = mergeEffects(left, right, at, sequenced);
              combined.value = result;
              operands.push(combined);
            });
            evaluate(node.right, frame, depth + 1, node.operator === ',' ? used : true);
          });
          evaluate(node.left, frame, depth + 1, node.operator !== ',');
        } else if (node.kind === 'compoundLiteral') {
          const activeScope = frame.scopes.at(-1);
          const objectReference = node.duration === 'static'
            ? debugEvents
              ? memory.findStaticObject(node) ?? allocateDebugObject(
                () => memory.staticObject(node, node.objectType, at),
                {
                  duration: 'static', origin: 'compound-literal',
                  typeSummary: debugTypeSummary(node.objectType, ir.aggregates), location: at,
                  frameId: null, scopeId: null,
                },
              )
              : memory.staticObject(node, node.objectType, at)
            : debugEvents
              ? (() => {
                const scopeToken = activeScope?.token ?? frame;
                return memory.findAutomaticObject(node, scopeToken) ?? allocateDebugObject(
                  () => memory.automaticObject(node, node.objectType, scopeToken, at),
                  {
                    duration: 'compound-literal', origin: 'compound-literal',
                    typeSummary: debugTypeSummary(node.objectType, ir.aggregates), location: at,
                    frameId: frame.frameId, scopeId: activeScope?.scopeId ?? null,
                  },
                );
              })()
              : memory.automaticObject(node, node.objectType, activeScope?.token ?? frame, at);
          if (node.duration === 'static' && initializedStaticExpressions.has(node)) {
            operands.push(referenceEvaluation(objectReference, 'literal compuesto'));
          } else {
            if (node.duration === 'static') initializedStaticExpressions.add(node);
            work.push(() => operands.push(referenceEvaluation(objectReference, 'literal compuesto')));
            initializeObject(objectReference, node.objectType, node.initializer, frame, depth + 1);
          }
        } else if (node.kind === 'vaArg') {
          work.push(() => {
            const handleResult = operands.pop();
            if (!handleResult) failure('ENGINE_STACK_ERROR', 'Falta la lista de argumentos de va_arg.', at);
            const handle = materialize(handleResult, at);
            const id = markerId(handle);
            const cursor = id === undefined ? undefined : vaCursors.get(id);
            if (!cursor?.active || cursor.frame.returned || !cursor.frame.vaCursorIds.has(id!)) {
              failure('INVALID_VA_LIST', 'va_arg requiere una lista activa dentro de la vida de su llamada.', at);
            }
            const argument = cursor.args[cursor.index];
            if (!argument) failure('VA_ARG_EXHAUSTED', 'va_arg solicitó un argumento después del final de la lista.', at);
            if (!compatibleType(argument.type, node.valueType) && !sameType(argument.type, node.valueType)) {
              failure('VA_ARG_TYPE_MISMATCH', `va_arg solicitó ${String(node.valueType)} pero el argumento promovido es ${String(argument.type)}.`, at);
            }
            cursor.index++;
            operands.push(plain(valueForType(argument, node.valueType, at)));
          });
          evaluate(node.ap, frame, depth + 1);
        } else if (node.kind === 'call') {
          const start = operands.length;
          // va_start/va_copy/va_end are direct runtime intrinsics without a linked function object.
          const intrinsicBuiltin = !!node.builtin && node.functionIndex === undefined && node.symbolKey === undefined;
          work.push(() => {
            const evaluated = operands.splice(start);
            const callee = node.callee && !intrinsicBuiltin ? evaluated.shift() : undefined;
            if (evaluated.length !== node.args.length) failure('ENGINE_STACK_ERROR', 'La cantidad de argumentos evaluados no coincide.', at);
            let effects = plain(integer(0));
            if (callee) {
              materialize(callee, at);
              effects = mergeEffects(effects, callee, at);
            }
            const args: CValue[] = [];
            for (const item of evaluated) {
              const argument = materialize(item, at);
              effects = mergeEffects(effects, item, at);
              args.push(argument);
            }
            effects.pendingWrites.clear();
            let functionIndex = node.functionIndex;
            if (callee) {
              const calleeValue = materialize(callee, at);
              if (!isPointer(calleeValue.type) || !isFunction(calleeValue.type.base) ||
                  typeof calleeValue.value !== 'object' || calleeValue.value === null ||
                  (calleeValue.value as { kind?: string }).kind !== 'function-pointer') {
                failure('INVALID_CALL', 'La expresión llamada no es un puntero a función.', at);
              }
              functionIndex = (calleeValue.value as { functionIndex: number | null }).functionIndex ?? undefined;
            }
            const symbolIndex = node.symbolKey ? functionSymbolIndices.get(node.symbolKey) : undefined;
            if (functionIndex === undefined) functionIndex = symbolIndex;
            const targetFunction = functionIndex === undefined ? undefined : functions[functionIndex]?.fn;
            const functionName = node.name ?? targetFunction?.name;
            const builtinTarget = !!node.builtin || functionIndex !== undefined && !!functions[functionIndex]?.fn.builtin;
            const calleeType = node.callee?.type;
            const signature = calleeType && isPointer(calleeType) && isFunction(calleeType.base)
              ? calleeType.base
              : targetFunction ? {
                kind: 'function' as const, returnType: targetFunction.returnType,
                parameters: targetFunction.parameters.map((parameter) => parameter.type),
                variadic: !!targetFunction.variadic, prototype: targetFunction.prototype,
              } : undefined;
            const callArgs = args.map((argument, index) => {
              if (signature && signature.prototype !== false && index < signature.parameters.length) {
                return valueForType(argument, signature.parameters[index], at);
              }
              return defaultArgumentPromotion(argument, at);
            });
            if (builtinTarget && functionName) {
              const runtimeArgs = isFloatingClassificationBuiltin(functionName) ? args : callArgs;
              const result = invokeBuiltin(functionName, runtimeArgs, node.type, at, frame);
              if (isBuiltinContinuation(result)) {
                const continuation = (): void => {
                  const next = result.next();
                  if (next.done) {
                    effects.value = next.value;
                    operands.push(effects);
                  } else {
                    awaitingInput = true;
                    work.push(continuation);
                  }
                };
                continuation();
              } else {
                effects.value = result;
                operands.push(effects);
              }
            } else {
              if (functionIndex === undefined && functionName) functionIndex = functionIndices.get(functionName);
              if (functionIndex === undefined) failure('UNKNOWN_FUNCTION', 'No se pudo resolver la función llamada.', at);
              work.push(() => {
                const result = operands.pop();
                if (!result) failure('ENGINE_STACK_ERROR', 'La llamada no produjo un resultado.', at);
                effects.value = result.value;
                operands.push(effects);
              });
              invoke(functions[functionIndex], callArgs, at, used);
            }
          });
          for (let index = node.args.length - 1; index >= 0; index--) evaluate(node.args[index], frame, depth + 1);
          if (node.callee && !intrinsicBuiltin) evaluate(node.callee, frame, depth + 1);
        }
      });
    }

    function cursorFromHandle(handle: CValue, at: Location): { id: number; cursor: VaCursor } {
      const id = markerId(handle);
      const cursor = id === undefined ? undefined : vaCursors.get(id);
      if (!cursor?.active || cursor.frame.returned || !cursor.frame.vaCursorIds.has(id!)) {
        failure('INVALID_VA_LIST', 'La lista de argumentos no está activa o su función terminó.', at);
      }
      memory.assertAlive(handle, at);
      return { id: id!, cursor };
    }
    function storeVaCursor(destination: CValue, owner: Frame, args: readonly CValue[], index: number, at: Location): void {
      if (!isPointer(destination.type) || destination.value === null) failure('INVALID_VA_LIST', 'La operación va_list requiere la dirección de una lista.', at);
      const target = memory.dereference(destination, at);
      if (!isPointer(target.type) || target.type.base !== 'void') failure('INVALID_VA_LIST', 'El destino no tiene tipo va_list.', at);
      const marker = memory.allocate('char', 'automatic', at);
      const value = memory.addressOf(marker, pointerTo('char'));
      const handle = valueForType(value, pointerTo('void'), at);
      memory.write(target, handle, at);
      const cursor: VaCursor = { frame: owner, args, index, active: true, marker };
      const id = marker.allocationId;
      vaCursors.set(id, cursor);
      owner.vaCursorIds.add(id);
      owner.temporaryObjects.push(marker);
    }
    function endVaCursor(id: number, cursor: VaCursor, at: Location): void {
      cursor.active = false;
      vaCursors.delete(id);
      cursor.frame.vaCursorIds.delete(id);
      const index = cursor.frame.temporaryObjects.indexOf(cursor.marker);
      if (index >= 0) cursor.frame.temporaryObjects.splice(index, 1);
      memory.release(cursor.marker, at);
    }
    function invokeBuiltin(
      name: string, args: CValue[], resultType: CValue['type'] | undefined, at: Location, frame: Frame,
    ): LibraryBuiltinResult {
      runtimeLocation = at;
      io!.setLocation(at);
      if (name === '__builtin_va_start') {
        if (args.length !== 2) failure('ARGUMENT_COUNT', 'va_start requiere la dirección de la lista y el último parámetro nombrado.', at);
        if (!frame.compiled.fn.variadic || !frame.compiled.fn.parameters.length) failure('INVALID_VA_START', 'va_start requiere una función variádica con al menos un parámetro nombrado.', at);
        const last = memory.dereference(args[1], at);
        const lastParameter = frame.compiled.fn.parameters.at(-1)!;
        const expected = frame.cells.get(lastParameter.binding!)?.reference;
        if (!expected || expected.objectId !== last.objectId) failure('INVALID_VA_START', 'El segundo argumento de va_start debe designar el último parámetro nombrado.', at);
        const target = memory.dereference(args[0], at);
        if (!isPointer(target.type) || target.type.base !== 'void') failure('INVALID_VA_LIST', 'El primer argumento de va_start no es una va_list.', at);
        storeVaCursor(args[0], frame, frame.variadicArgs, 0, at);
        return { type: 'void', value: 0n };
      }
      if (name === '__builtin_va_copy') {
        if (args.length !== 2) failure('ARGUMENT_COUNT', 'va_copy requiere el destino y el origen.', at);
        const source = cursorFromHandle(args[1], at).cursor;
        storeVaCursor(args[0], frame, source.args, source.index, at);
        return { type: 'void', value: 0n };
      }
      if (name === '__builtin_va_end') {
        if (args.length !== 1) failure('ARGUMENT_COUNT', 'va_end requiere la dirección de la lista.', at);
        const target = memory.dereference(args[0], at);
        const handle = memory.read(target, at);
        const { id, cursor } = cursorFromHandle(handle, at);
        endVaCursor(id, cursor, at);
        memory.write(target, { type: target.type, value: null }, at);
        return { type: 'void', value: 0n };
      }
      const library = dispatchLibraryBuiltin(name, args, resultType, libraryContext);
      if (library) return library;
      if (name === 'malloc') {
        if (args.length !== 1) failure('ARGUMENT_COUNT', 'malloc requiere un argumento.', at);
        const amount = args[0].value;
        if (typeof amount !== 'bigint' || amount < 0n) failure('INVALID_ALLOCATION_SIZE', 'malloc requiere un tamaño entero no negativo.', at);
        if (amount > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'El tamaño de malloc excede el rango representable.', at);
        const pointer = allocateDebugHeap(Number(amount), at);
        return { type: resultType && isPointer(resultType) ? resultType : pointerTo('void'), value: pointer };
      }
      if (name === 'realloc') {
        if (args.length !== 2) failure('ARGUMENT_COUNT', 'realloc requiere dos argumentos.', at);
        const source = valueForType(args[0], pointerTo('void'), at);
        const amount = args[1].value;
        if (typeof amount !== 'bigint' || amount < 0n) failure('INVALID_ALLOCATION_SIZE', 'realloc requiere un tamaño entero no negativo.', at);
        if (amount > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'El tamaño de realloc excede el rango representable.', at);
        const pointer = reallocateDebugHeap(source.value as ObjectPointerValue | null, Number(amount), at);
        return { type: resultType && isPointer(resultType) ? resultType : pointerTo('void'), value: pointer };
      }
      if (name === 'free') {
        if (args.length !== 1) failure('ARGUMENT_COUNT', 'free requiere un argumento.', at);
        const pointer = valueForType(args[0], pointerTo('void'), at);
        const objectPointer = pointer.value as ObjectPointerValue | null;
        const shouldTraceDelete = !!debugEvents && !!debugObjects && memory.canFree(objectPointer) &&
          debugObjects.has(objectPointer!.allocationId);
        const reference = shouldTraceDelete ? memory.rootReference(objectPointer!.allocationId) : undefined;
        if (shouldTraceDelete) debugEvents!.reserve(at);
        try {
          memory.free(objectPointer, at);
        } catch (error) {
          if (shouldTraceDelete) debugEvents!.cancel();
          throw error;
        }
        if (shouldTraceDelete && reference) commitDebugObjectDelete(reference, at, null, null);
        return { type: 'void', value: 0n };
      }
      return callBuiltin(name, args, at);
    }

    function defaultArgumentPromotion(value: CValue, at: Location): CValue {
      if (value.type === 'float') return valueForType(value, 'double', at);
      if (isInteger(value.type)) {
        const promoted = promote(value.type);
        return promoted === value.type ? value : valueForType(value, promoted, at);
      }
      return value;
    }

    function enter(frame: Frame, layout: Scope): void {
      enforceLimit('maxDepth', scopeDepth + 1, limits.maxDepth, layout.location);
      const scopeId = debugEvents ? nextDebugScopeId++ : 0;
      debugEvents?.reserve(layout.location);
      const runtimeScope: RuntimeScope = { layout, token: {}, scopeId, cells: [] };
      frame.scopes.push(runtimeScope);
      scopeDepth++;
      debugEvents?.commit({
        kind: 'scope-enter', location: layout.location,
        frameId: frame.frameId, scopeId, functionName: frame.compiled.fn.name, scopeName: layout.name,
      });
      for (const binding of layout.bindings) {
        let reference: ObjectReference;
        if (binding.storageDuration === 'static') {
          if (debugEvents) {
            reference = memory.findStaticObject(binding) ?? allocateDebugObject(
              () => memory.staticObject(binding, binding.type, binding.location),
              {
                duration: 'static', origin: 'variable', typeSummary: debugTypeSummary(binding.type, ir.aggregates),
                location: binding.location, frameId: null, scopeId: null, name: binding.name,
                readOnly: binding.isConst === true,
              },
            );
          } else reference = memory.staticObject(binding, binding.type, binding.location);
          if (!preparedStaticBindings.has(binding)) {
            memory.zeroInitialize(reference, binding.location);
            preparedStaticBindings.add(binding);
          }
        } else reference = memory.allocate(binding.type, 'automatic', binding.location);
        frame.cells.set(binding.id, { binding, reference });
        runtimeScope.cells.push(binding.id);
      }
      if (frame.scopes.length === 1) {
        frame.compiled.fn.parameters.forEach((parameter, index) => {
          const target = localCell(frame, parameter.binding!, parameter.location);
          const argument = frame.args[index];
          if (!argument) failure('ARGUMENT_COUNT', 'Falta un argumento de función para «' + parameter.name + '».', parameter.location);
          if (debugEvents) publishAutomaticBinding(frame, runtimeScope, target.binding, target.reference);
          memory.write(target.reference, valueForType(argument, parameter.type, parameter.location), parameter.location);
        });
      }
    }
    function leave(frame: Frame, eventLocation: Location = runtimeLocation): void {
      const scope = frame.scopes.at(-1);
      if (!scope) failure('INVALID_SCOPE', 'No hay un ámbito activo para cerrar.', runtimeLocation);
      if (!debugEvents || !debugObjects) {
        frame.scopes.pop();
        scopeDepth--;
        memory.releaseScope(scope.token, scope.layout.location);
        for (const bindingId of scope.cells) {
          const target = frame.cells.get(bindingId);
          if (target && target.binding.storageDuration !== 'static') memory.release(target.reference, target.binding.location);
          frame.cells.delete(bindingId);
        }
        return;
      }

      const compoundReferences = [...memory.scopeObjectReferences(scope.token)].reverse();
      const bindingReferences = scope.cells.flatMap((bindingId) => {
        const target = frame.cells.get(bindingId);
        return target && target.binding.storageDuration !== 'static' ? [target.reference] : [];
      });
      const trackedReferences = [...compoundReferences, ...bindingReferences]
        .filter((reference) => debugObjects.has(reference.allocationId));
      const uniqueReferences = [...new Map(trackedReferences.map((reference) => [reference.allocationId, reference])).values()];
      const releaseLocation = scope.layout.location;
      debugEvents.reserveMany(uniqueReferences.length + 1, eventLocation);
      frame.scopes.pop();
      scopeDepth--;
      try {
        memory.releaseScope(scope.token, releaseLocation);
        for (const bindingId of scope.cells) {
          const target = frame.cells.get(bindingId);
          if (target && target.binding.storageDuration !== 'static') memory.release(target.reference, target.binding.location);
          frame.cells.delete(bindingId);
        }
      } catch (error) {
        let committed = 0;
        for (const reference of uniqueReferences) {
          if (!memory.isAlive(reference)) {
            commitDebugObjectDelete(reference, eventLocation, frame.frameId, scope.scopeId);
            committed++;
          }
        }
        debugEvents.cancelMany(uniqueReferences.length + 1 - committed);
        throw error;
      }
      for (const reference of uniqueReferences) {
        commitDebugObjectDelete(reference, eventLocation, frame.frameId, scope.scopeId);
      }
      debugEvents.commit({
        kind: 'scope-exit', location: eventLocation, frameId: frame.frameId,
        scopeId: scope.scopeId, functionName: frame.compiled.fn.name, scopeName: scope.layout.name,
      });
    }
    function jump(frame: Frame, target: number): void {
      const path = frame.compiled.code[target]?.path ?? [];
      let shared = 0;
      while (shared < path.length && shared < frame.scopes.length && path[shared] === frame.scopes[shared].layout) shared++;
      while (frame.scopes.length > shared) leave(frame);
      for (let index = shared; index < path.length; index++) enter(frame, path[index]);
      frame.pc = target;
    }
    function initializeGlobal(globalIndex: number, frame: Frame): void {
      const global = ir.globals[globalIndex];
      if (!global.declarationOnly && global.initializer) {
        const reference = globalReferences.get(global.id);
        if (!reference) failure('UNKNOWN_OBJECT', 'No se encontró el objeto global durante su inicialización.', global.location);
        initializeObject(reference, global.type, global.initializer, frame);
      }
    }
    const sameDebugLine = (left: Location | undefined, right: Location): boolean =>
      !!left && left.file === right.file && left.line === right.line;
    function step(frame: Frame): void {
      work.push(() => {
        if (frame.returned || frame.pc >= frame.compiled.code.length) return;
        const node = frame.compiled.code[frame.pc];
        if (debugOptions !== undefined && debugStartPhase && frame.compiled.fn.name === 'main') {
          // Enter main's root scope before exposing the first user instruction.
          if (frame.pc === 0 && node.op === 'enter') {
            debugLocation = node.location;
          } else {
            debugStartPhase = false;
            debugEntryReady = true;
            debugLocation = node.location;
            work.push(() => step(frame));
            return;
          }
        }
        if (debugOptions !== undefined && debugStepActive) {
          let visited = debugVisitedInstructions!.get(frame);
          if (!visited) { visited = new Set(); debugVisitedInstructions!.set(frame, visited); }
          const repeatedVisit = visited.has(frame.pc);
          const changedLine = debugStepExecuted && !sameDebugLine(debugStepStartLocation, node.location);
          if (debugStepExecuted && (changedLine || repeatedVisit)) {
            debugLocation = node.location;
            debugPause = {
              kind: 'paused',
              location: Object.freeze({ file: node.location.file, line: node.location.line, column: node.location.column }),
              metrics,
              ...output(),
            };
            work.push(() => step(frame));
            return;
          }
          visited.add(frame.pc);
          debugStepExecuted = true;
          debugLocation = node.location;
        }
        frame.pc++;
        instruction(node.location);
        work.push(() => step(frame));
        if (node.op === 'enter') enter(frame, node.scope);
        else if (node.op === 'leave') leave(frame);
        else if (node.op === 'declaration') {
          const target = localCell(frame, node.binding, node.location);
          if (debugEvents && target.binding.storageDuration !== 'static') {
            let ownerScope: RuntimeScope | undefined;
            for (let index = frame.scopes.length - 1; index >= 0; index--) {
              if (frame.scopes[index].cells.includes(node.binding)) {
                ownerScope = frame.scopes[index];
                break;
              }
            }
            if (!ownerScope) failure('INACTIVE_OBJECT', 'La declaración no pertenece a un ámbito activo.', node.location);
            publishAutomaticBinding(frame, ownerScope, target.binding, target.reference);
          }
          if (node.initializer && (target.binding.storageDuration !== 'static' || !initializedStaticBindings.has(target.binding))) {
            if (target.binding.storageDuration === 'static') initializedStaticBindings.add(target.binding);
            initializeObject(target.reference, target.binding.type, node.initializer, frame);
          }
        } else if (node.op === 'expression') {
          evaluateFullExpression(node.value, frame, () => {
            const result = operands.pop();
            if (result) materialize(result, node.location);
          }, 1, false);
        } else if (node.op === 'return') {
          if (debugEvents) frame.returnLocation = node.location;
          const consume = () => {
            const result = node.value ? operands.pop() : undefined;
            const value = result ? valueForType(materialize(result, node.location), frame.compiled.fn.returnType, node.location)
              : { type: 'void', value: 0n } as CValue;
            frame.result = value;
            frame.returned = true;
          };
          if (node.value) evaluateFullExpression(node.value, frame, consume);
          else work.push(consume);
        } else if (node.op === 'jump') jump(frame, node.target);
        else if (node.op === 'branch') {
          evaluateFullExpression(node.condition, frame, () => {
            const result = operands.pop();
            if (!result || !truthValue(materialize(result, node.location))) jump(frame, node.target);
          });
        } else if (node.op === 'switch') {
          evaluateFullExpression(node.value, frame, () => {
            const result = operands.pop();
            if (!result) failure('ENGINE_STACK_ERROR', 'Falta el valor del switch.', node.location);
            const value = valueForType(materialize(result, node.location), promote(node.value.type!), node.location);
            const match = node.cases.find((item) => valueForType(item.value, value.type, node.location).value === value.value);
            jump(frame, match?.target ?? node.target);
          });
        }
      });
    }
    function invoke(compiled: CompiledFunction, args: CValue[], at: Location, used = true): void {
      if (!compiled?.fn.body) failure('UNDEFINED_FUNCTION', 'La función llamada no tiene definición en este archivo.', at);
      const parameterCount = compiled.fn.parameters.length;
      if (args.length < parameterCount || !compiled.fn.variadic && args.length !== parameterCount) {
        failure('ARGUMENT_COUNT', 'La función «' + compiled.fn.name + '» requiere ' + compiled.fn.parameters.length + ' argumentos.', at);
      }
      enforceLimit('maxDepth', callDepth + 1, limits.maxDepth, at);
      const frameId = debugEvents ? nextDebugFrameId++ : null;
      debugEvents?.reserve(compiled.fn.location);
      callDepth++;
      const frame: Frame = {
        compiled, frameId, args, variadicArgs: args.slice(parameterCount), vaCursorIds: new Set(), temporaryObjects: [],
        pc: 0, cells: new Map(), scopes: [], returned: false,
      };
      activeDebugFrames?.push(frame);
      debugEvents?.commit({
        kind: 'frame-enter', location: compiled.fn.location,
        frameId, scopeId: null, functionName: compiled.fn.name,
      });
      work.push(() => {
        const exitLocation = debugEvents
          ? frame.returnLocation ?? frame.compiled.fn.body?.endLocation ?? runtimeLocation
          : runtimeLocation;
        let reservedFrameExit = false;
        if (debugEvents) {
          debugEvents.reserve(exitLocation);
          reservedFrameExit = true;
        }
        try {
          while (frame.scopes.length) leave(frame, exitLocation);
          for (const id of [...frame.vaCursorIds]) {
            const cursor = vaCursors.get(id);
            if (cursor) endVaCursor(id, cursor, at);
          }
          frame.returned = true;
          callDepth--;
          activeDebugFrames?.pop();
          if (reservedFrameExit) {
            debugEvents!.commit({
              kind: 'frame-exit', location: exitLocation,
              frameId, scopeId: null, functionName: compiled.fn.name,
            });
            reservedFrameExit = false;
          }
        } catch (error) {
          if (reservedFrameExit) debugEvents!.cancel();
          throw error;
        }
        if (compiled.fn.noreturn) failure('NORETURN_RETURN', `La función «${compiled.fn.name}» fue declarada _Noreturn pero regresó.`, compiled.fn.location);
        let value = frame.result;
        if (!value) {
          if (compiled.fn.name === 'main') value = integer(0);
          else if (compiled.fn.returnType === 'void') value = { type: 'void', value: 0n };
          else if (!used) value = defaultReturn(compiled.fn.returnType, at);
          else failure('MISSING_RETURN', 'La función «' + compiled.fn.name + '» termina sin devolver un valor.', compiled.fn.location);
        }
        operands.push(plain(value));
      });
      step(frame);
    }
    function defaultReturn(type: CValue['type'], at: Location): CValue {
      if (isAggregate(type)) return { type, value: { kind: 'aggregate-value', snapshot: { initialized: true, zeroInitialized: true } } };
      if (isArray(type) || isFunction(type) || type === 'void') failure('MISSING_RETURN', 'La función termina sin un valor de retorno válido.', at);
      return valueForType(integer(0), type, at);
    }

    function mainArguments(compiled: CompiledFunction): CValue[] {
      const parameters = compiled.fn.parameters;
      if (parameters.length === 0) return [];
      if (parameters.length !== 2 || parameters[0].type !== 'int' || !isPointer(parameters[1].type) ||
          !isPointer(parameters[1].type.base) || parameters[1].type.base.base !== 'char') {
        failure('INVALID_ENTRY_SIGNATURE', 'main debe tener la forma int main(void) o int main(int, char **).', compiled.fn.location);
      }
      if (io!.argv.length > 2147483647) failure('ARGUMENT_COUNT_RANGE', 'El vector argv excede el rango de int para argc.', compiled.fn.location);
      const pointerToChar = pointerTo('char');
      const vector = memory.allocate(arrayOf(pointerToChar, io!.argv.length + 1), 'static', compiled.fn.location);
      memory.zeroInitialize(vector, compiled.fn.location);
      for (let index = 0; index < io!.argv.length; index++) {
        const encoded = new TextEncoder().encode(io!.argv[index]);
        chargeWork(encoded.length + 1, compiled.fn.location);
        const string = memory.allocate(arrayOf('char', encoded.length + 1), 'static', compiled.fn.location);
        memory.zeroInitialize(string, compiled.fn.location);
        for (let byte = 0; byte < encoded.length; byte++) {
          memory.write(memory.element(string, byte, compiled.fn.location), integer(BigInt.asIntN(8, BigInt(encoded[byte])), 'char'), compiled.fn.location);
        }
        memory.write(
          memory.element(vector, index, compiled.fn.location),
          valueForType(memory.decay(string), pointerToChar, compiled.fn.location),
          compiled.fn.location,
        );
      }
      return [integer(BigInt(io!.argv.length), 'int'), valueForType(memory.decay(vector), parameters[1].type, compiled.fn.location)];
    }

    for (const global of ir.globals) {
      if (global.declarationOnly) continue;
      const reference = debugEvents
        ? memory.findStaticObject(global) ?? allocateDebugObject(
          () => memory.staticObject(global, global.type, global.location),
          {
            duration: 'static', origin: 'variable', typeSummary: debugTypeSummary(global.type, ir.aggregates),
            location: global.location, frameId: null, scopeId: null, name: global.name,
            readOnly: global.isConst === true,
          },
        )
        : memory.staticObject(global, global.type, global.location);
      memory.zeroInitialize(reference, global.location);
      globalReferences.set(global.id, reference);
    }
    const initializationFrame: Frame = {
      compiled: functions[ir.mainIndex], frameId: null, args: [], variadicArgs: [], vaCursorIds: new Set(), temporaryObjects: [],
      pc: 0, cells: new Map(), scopes: [], returned: false,
    };
    const entryFunction = functions[ir.mainIndex];
    if (!entryFunction?.fn.body) failure('UNDEFINED_ENTRY', 'main no tiene una definición ejecutable.', entryFunction?.fn.location ?? location);
    const entryArgs = mainArguments(entryFunction);
    work.push(() => invoke(entryFunction, entryArgs, entryFunction.fn.location));
    for (let index = ir.globals.length - 1; index >= 0; index--) {
      const globalIndex = index;
      work.push(() => initializeGlobal(globalIndex, initializationFrame));
    }
    runRuntime = () => {
      while (work.length && !awaitingInput && !debugPause) work.pop()!();
      if (debugPause) {
        debugStepActive = false;
        return debugPause;
      }
      if (awaitingInput) return { kind: 'input-needed', metrics, ...output() };

      const mainReturn = Number(valueForType(operands.pop()!.value!, 'int', location).value);
      return {
        kind: 'terminated',
        exitCode: ((mainReturn % 256) + 256) % 256,
        rawExitStatus: mainReturn,
        mainReturn,
        metrics,
        ...output(),
      };
    };
    if (debugOptions !== undefined) {
      // Run global initialization and enter main's root scope once, stopping before its first source instruction.
      while (work.length && !debugEntryReady) work.pop()!();
      debugLocation = debugEntryReady ? debugLocation : null;
    }
    // Include synchronous VM setup in execution time, then count only actual
    // resume work; wall time spent waiting for input is excluded.
    metrics.executeMs += now() - started;
    return session;
  } catch (error) {
    terminalResult = resultForError(error);
    if (debugOptions !== undefined) debugLocation = null;
    metrics.executeMs += now() - started;
    return session;
  }
}
