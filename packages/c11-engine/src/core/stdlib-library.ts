import type { AggregateValue, CValue, CType, ObjectPointerValue } from './internal.ts';
import { pointerTo } from './type-system.ts';
import type { LibraryBuiltinGenerator } from './library-requests.ts';
import type { StdlibTimeRuntimeContext } from './stdlib-time-context.ts';
import { ERRNO_CODES } from './errno-metadata.ts';

const RAND_MASK = 0x7fff_ffff;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const { ENOMEM, EINVAL, EILSEQ, ENOSYS } = ERRNO_CODES;

function count(name: string, args: readonly CValue[], expected: number, context: StdlibTimeRuntimeContext): void {
  if (args.length !== expected) context.fail('LIBRARY_ARGUMENT', `${name} recibió una cantidad de argumentos no válida.`, context.at);
}

function integer(value: CValue, name: string, context: StdlibTimeRuntimeContext): bigint {
  if (typeof value.value !== 'bigint') return context.fail('LIBRARY_ARGUMENT', `${name} requiere argumentos enteros.`, context.at);
  return value.value;
}

function objectPointer(value: CValue, name: string, context: StdlibTimeRuntimeContext, nullable = false): ObjectPointerValue | null {
  if (value.value === null && nullable) return null;
  if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') {
    return context.fail('LIBRARY_ARGUMENT', `${name} requiere un puntero a objeto.`, context.at);
  }
  return value.value;
}

function resultPointer(pointer: ObjectPointerValue | null, resultType: CType | undefined): CValue {
  return { type: resultType ?? pointerTo('void'), value: pointer };
}

function sessionState(context: StdlibTimeRuntimeContext) {
  if (!context.stdlibState) return context.fail('ENGINE_INTERNAL_ERROR', 'Falta el estado por ejecución de stdlib/time.', context.at);
  return context.stdlibState;
}

function functionPointer(value: CValue, name: string, context: StdlibTimeRuntimeContext): void {
  if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'function-pointer' || value.value.functionIndex === null) {
    context.fail('LIBRARY_ARGUMENT', `${name} requiere un puntero a función C válido.`, context.at);
  }
}

function *registerHandler(
  mode: 'normal' | 'quick', callee: CValue, context: StdlibTimeRuntimeContext,
): LibraryBuiltinGenerator {
  functionPointer(callee, mode === 'normal' ? 'atexit' : 'at_quick_exit', context);
  const accepted = yield { kind: 'register-termination-handler', mode, callee };
  return context.makeInt(typeof accepted === 'object' && accepted !== null && typeof accepted.value === 'bigint' && accepted.value !== 0n ? 1 : 0, 'int');
}

function *terminate(mode: 'normal' | 'quick' | 'immediate' | 'abort', status: bigint, context: StdlibTimeRuntimeContext): LibraryBuiltinGenerator {
  yield { kind: 'terminate', mode, status };
  return context.fail('INVALID_TERMINATION', 'El scheduler reanudó una terminación que debía ser definitiva.', context.at);
}

function compareResult(value: CValue, context: StdlibTimeRuntimeContext): number {
  if (typeof value.value !== 'bigint') return context.fail('LIBRARY_ARGUMENT', 'El comparador de qsort/bsearch debe devolver int.', context.at);
  return value.value < 0n ? -1 : value.value > 0n ? 1 : 0;
}

function *compareElements(
  comparator: CValue, left: CValue, right: CValue, context: StdlibTimeRuntimeContext,
): Generator<import('./library-requests.ts').LibraryBuiltinRequest, number, CValue | void> {
  const returned = yield { kind: 'call-user', callee: comparator, args: [left, right] };
  return compareResult(returned as CValue, context);
}

function *siftDown(
  base: CValue, comparator: CValue, first: number, rootInput: number, count: number, size: number,
  context: StdlibTimeRuntimeContext,
): LibraryBuiltinGenerator {
  let root = rootInput;
  while (root * 2 + 1 < count) {
    const child = root * 2 + 1;
    let greater = root;
    const rootPointer = context.offsetPointer(base, (first + greater) * size, context.at);
    const childPointer = context.offsetPointer(base, (first + child) * size, context.at);
    if ((yield* compareElements(comparator, childPointer, rootPointer, context)) > 0) greater = child;
    if (child + 1 < count) {
      const greaterPointer = context.offsetPointer(base, (first + greater) * size, context.at);
      const rightPointer = context.offsetPointer(base, (first + child + 1) * size, context.at);
      if ((yield* compareElements(comparator, rightPointer, greaterPointer, context)) > 0) greater = child + 1;
    }
    if (greater === root) return { type: 'void', value: 0n };
    const left = context.offsetPointer(base, (first + root) * size, context.at);
    const right = context.offsetPointer(base, (first + greater) * size, context.at);
    if (!context.swapObjectBytes) return context.fail('ENGINE_INTERNAL_ERROR', 'qsort requiere el servicio de intercambio que conserva metadatos de memoria.', context.at);
    context.swapObjectBytes(objectPointer(left, 'qsort', context)!, objectPointer(right, 'qsort', context)!, size, context.at);
    context.chargeWork(1, context.at);
    root = greater;
  }
  return { type: 'void', value: 0n };
}

function *qsort(args: readonly CValue[], context: StdlibTimeRuntimeContext): LibraryBuiltinGenerator {
  const base = objectPointer(args[0], 'qsort', context, true);
  const countValue = integer(args[1], 'qsort', context);
  const sizeValue = integer(args[2], 'qsort', context);
  if (countValue < 0n || sizeValue < 0n || countValue > MAX_SAFE || sizeValue > MAX_SAFE) return context.fail('LIBRARY_ARGUMENT', 'qsort recibió un rango no representable.', context.at);
  const length = Number(countValue), size = Number(sizeValue);
  if (length <= 1 || size === 0) return { type: 'void', value: 0n };
  if (length > Math.floor(Number.MAX_SAFE_INTEGER / size)) return context.fail('LIBRARY_ARGUMENT', 'El tamaño total de qsort excede el rango seguro.', context.at);
  if (!base) return context.fail('LIBRARY_ARGUMENT', 'qsort requiere un buffer no nulo cuando hay varios elementos.', context.at);
  functionPointer(args[3], 'qsort', context);
  const comparator = args[3];
  for (let start = Math.floor(length / 2) - 1; start >= 0; start--) yield* siftDown(args[0], comparator, 0, start, length, size, context);
  for (let end = length - 1; end > 0; end--) {
    const first = context.offsetPointer(args[0], 0, context.at);
    const last = context.offsetPointer(args[0], end * size, context.at);
    if (!context.swapObjectBytes) return context.fail('ENGINE_INTERNAL_ERROR', 'qsort requiere el servicio de intercambio que conserva metadatos de memoria.', context.at);
    context.swapObjectBytes(objectPointer(first, 'qsort', context)!, objectPointer(last, 'qsort', context)!, size, context.at);
    context.chargeWork(1, context.at);
    yield* siftDown(args[0], comparator, 0, 0, end, size, context);
  }
  return { type: 'void', value: 0n };
}

function *bsearch(args: readonly CValue[], resultType: CType | undefined, context: StdlibTimeRuntimeContext): LibraryBuiltinGenerator {
  const key = args[0];
  const basePointer = objectPointer(args[1], 'bsearch', context, true);
  const countValue = integer(args[2], 'bsearch', context);
  const sizeValue = integer(args[3], 'bsearch', context);
  if (countValue < 0n || sizeValue < 0n || countValue > MAX_SAFE || sizeValue > MAX_SAFE) return context.fail('LIBRARY_ARGUMENT', 'bsearch recibió un rango no representable.', context.at);
  const length = Number(countValue), size = Number(sizeValue);
  if (length === 0) return resultPointer(null, resultType);
  if (!basePointer || size === 0 || length > Math.floor(Number.MAX_SAFE_INTEGER / size)) return context.fail('LIBRARY_ARGUMENT', 'bsearch recibió un buffer inválido.', context.at);
  functionPointer(args[4], 'bsearch', context);
  let low = 0, high = length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const item = context.offsetPointer(args[1], middle * size, context.at);
    const order = yield* compareElements(args[4], key, item, context);
    context.chargeWork(1, context.at);
    if (order === 0) return { type: resultType ?? args[1].type, value: (item.value as ObjectPointerValue) };
    if (order < 0) high = middle;
    else low = middle + 1;
  }
  return resultPointer(null, resultType);
}

function division(name: string, args: readonly CValue[], resultType: CType | undefined, context: StdlibTimeRuntimeContext): CValue {
  count(name, args, 2, context);
  const numerator = integer(args[0], name, context), denominator = integer(args[1], name, context);
  if (denominator === 0n) return context.fail('DIVISION_BY_ZERO', `${name} no admite divisor cero.`, context.at);
  const bits = name === 'div' ? 32n : 64n;
  const minimum = -(1n << (bits - 1n)), maximum = (1n << (bits - 1n)) - 1n;
  if (numerator === minimum && denominator === -1n) return context.fail('INTEGER_OVERFLOW', `${name} excede el rango del tipo cociente.`, context.at);
  const quotient = numerator / denominator;
  if (quotient < minimum || quotient > maximum) return context.fail('INTEGER_OVERFLOW', `${name} excede el rango del tipo cociente.`, context.at);
  const remainder = numerator - quotient * denominator;
  const aggregate: AggregateValue = {
    kind: 'aggregate-value',
    snapshot: { initialized: true, children: {
      0: { initialized: true, value: quotient },
      1: { initialized: true, value: remainder },
    } },
  };
  return { type: resultType ?? 'void', value: aggregate };
}

/** C11 narrow stdlib services not supplied by the numeric or allocator dispatchers. */
export function dispatchStdlibBuiltin(
  name: string, args: readonly CValue[], resultType: CType | undefined, context: StdlibTimeRuntimeContext,
): CValue | LibraryBuiltinGenerator | undefined {
  const at = context.at;
  if (name === 'rand') {
    count(name, args, 0, context);
    const state = sessionState(context);
    state.randState = (Math.imul(1_103_515_245, state.randState & RAND_MASK) + 12_345) & RAND_MASK;
    return context.makeInt(state.randState, resultType ?? 'int');
  }
  if (name === 'srand') {
    count(name, args, 1, context);
    sessionState(context).randState = Number(BigInt.asUintN(31, integer(args[0], name, context))) || 1;
    return { type: 'void', value: 0n };
  }
  if (name === 'atexit' || name === 'at_quick_exit') {
    count(name, args, 1, context);
    return registerHandler(name === 'atexit' ? 'normal' : 'quick', args[0], context);
  }
  if (name === 'exit' || name === '_Exit' || name === 'quick_exit' || name === 'abort') {
    count(name, args, name === 'abort' ? 0 : 1, context);
    const status = name === 'abort' ? 134n : integer(args[0], name, context);
    const mode = name === 'exit' ? 'normal' : name === 'quick_exit' ? 'quick' : name === '_Exit' ? 'immediate' : 'abort';
    return terminate(mode, status, context);
  }
  if (name === 'getenv') {
    count(name, args, 1, context);
    const nameBytes = context.readCString(args[0], at);
    context.chargeWork(nameBytes.length, at);
    const key = new TextDecoder().decode(nameBytes);
    const value = context.environment?.[key];
    if (value === undefined) return { type: resultType ?? args[0].type, value: null };
    const state = sessionState(context);
    let buffer = state.environmentBuffers.get(key);
    if (!buffer) {
      const bytes = new TextEncoder().encode(value);
      buffer = context.makeString(bytes, at);
      state.environmentBuffers.set(key, buffer);
    }
    return { type: resultType ?? args[0].type, value: buffer.value as ObjectPointerValue };
  }
  if (name === 'system') {
    count(name, args, 1, context);
    if (args[0].value === null) return context.makeInt(0, resultType ?? 'int');
    context.readCString(args[0], at);
    context.errno.set(ENOSYS);
    return context.makeInt(-1, resultType ?? 'int');
  }
  if (name === 'qsort') {
    count(name, args, 4, context);
    return qsort(args, context);
  }
  if (name === 'bsearch') {
    count(name, args, 5, context);
    return bsearch(args, resultType, context);
  }
  if (name === 'calloc') {
    count(name, args, 2, context);
    const countValue = integer(args[0], name, context), sizeValue = integer(args[1], name, context);
    if (countValue < 0n || sizeValue < 0n) return context.fail('LIBRARY_ARGUMENT', 'calloc requiere tamaños no negativos.', at);
    const total = countValue * sizeValue;
    if (total > MAX_SAFE) { context.errno.set(ENOMEM); return resultPointer(null, resultType); }
    if (!context.allocateHeap || !context.zeroHeap) return context.fail('ENGINE_INTERNAL_ERROR', 'calloc requiere los servicios de memoria heap de la VM.', at);
    const pointer = context.allocateHeap(Number(total), at);
    if (pointer) context.zeroHeap(pointer, Number(total), at);
    else context.errno.set(ENOMEM);
    return resultPointer(pointer, resultType);
  }
  if (name === 'aligned_alloc') {
    count(name, args, 2, context);
    const alignment = integer(args[0], name, context), size = integer(args[1], name, context);
    if (alignment <= 0n || alignment > 65_536n || (alignment & (alignment - 1n)) !== 0n || size < 0n || size % alignment !== 0n) {
      context.errno.set(EINVAL);
      return resultPointer(null, resultType);
    }
    if (size > MAX_SAFE) { context.errno.set(ENOMEM); return resultPointer(null, resultType); }
    if (!context.allocateHeapAligned) return context.fail('ENGINE_INTERNAL_ERROR', 'aligned_alloc requiere el servicio de asignación alineada de la VM.', at);
    const pointer = context.allocateHeapAligned(Number(size), Number(alignment), at);
    if (!pointer) context.errno.set(ENOMEM);
    return resultPointer(pointer, resultType);
  }
  if (name === 'mblen') {
    count(name, args, 2, context);
    const text = objectPointer(args[0], name, context, true);
    if (!text) return context.makeInt(0, resultType ?? 'int');
    const maximum = integer(args[1], name, context);
    if (maximum <= 0n) return context.makeInt(-1, resultType ?? 'int');
    const first = context.readBytes(args[0], 1, at)[0];
    if (first === 0) return context.makeInt(0, resultType ?? 'int');
    if (first > 0x7f) { context.errno.set(EILSEQ); return context.makeInt(-1, resultType ?? 'int'); }
    return context.makeInt(1, resultType ?? 'int');
  }
  if (name === 'abs' || name === 'labs' || name === 'llabs') {
    count(name, args, 1, context);
    const value = integer(args[0], name, context);
    const bits = name === 'abs' ? 32n : 64n;
    const minimum = -(1n << (bits - 1n));
    if (value === minimum) return context.fail('INTEGER_OVERFLOW', `${name} no puede representar el valor absoluto del mínimo.`, at);
    return context.makeInt(value < 0n ? -value : value, resultType ?? (name === 'abs' ? 'int' : name === 'labs' ? 'long' : 'long long'));
  }
  if (name === 'div' || name === 'ldiv' || name === 'lldiv') return division(name, args, resultType, context);
  return undefined;
}
