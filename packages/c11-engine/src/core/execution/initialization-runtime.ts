import { failure } from '../internal.ts';
import type {
  AggregateDefinition, CValue, Expression, Initializer, InitializerDesignator,
  Location, ObjectReference, ProgramIR,
} from '../internal.ts';
import { aggregateType, arrayType, isAggregate, isArray, isInteger, isScalar, isPointer, unqualifiedType } from '../type-system.ts';
import type { VirtualMemory } from '../memory.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { DebugObjectMetadata, Evaluation, Frame } from './runtime-types.ts';
import type { EffectsRuntime } from './effects-runtime.ts';

/** Runtime state and operations required to initialize C objects. */
export interface InitializationRuntimeContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  readonly operands: Evaluation[];
  readonly work: Array<() => void>;
  readonly integerValueBases: WeakMap<CValue, Set<number>>;
  readonly unknownIntegerValueBases: WeakMap<CValue, Set<number>>;
  readonly integer: (value: bigint | number | boolean, type?: CValue['type']) => CValue;
  readonly valueForType: (value: CValue, type: CValue['type'], at: Location) => CValue;
  readonly evaluateFullExpression: EffectsRuntime['evaluateFullExpression'];
  readonly materialize: EffectsRuntime['materialize'];
  readonly setPointerBasesForObject: (
    reference: ObjectReference,
    bases?: Iterable<number>,
    unknownBases?: Iterable<number>,
  ) => void;
  readonly setIntegerPointerBasesForObject: (
    reference: ObjectReference,
    bases?: Iterable<number>,
    unknownBases?: Iterable<number>,
  ) => void;
  get debugEvents(): DebugEventCollector | undefined;
  readonly allocateDebugObject: (allocate: () => ObjectReference, metadata: DebugObjectMetadata) => ObjectReference;
}

export interface InitializationRuntime {
  readonly aggregateDefinition: (type: CValue['type'], at: Location) => AggregateDefinition;
  readonly positionalAggregateMembers: (type: CValue['type'], at: Location) => AggregateDefinition['members'][number][];
  readonly immediateSubobject: (
    reference: ObjectReference,
    type: CValue['type'],
    index: number,
    at: Location,
  ) => { reference: ObjectReference; type: CValue['type'] };
  readonly designatedSubobject: (
    root: ObjectReference,
    rootType: CValue['type'],
    designators: readonly InitializerDesignator[],
  ) => { reference: ObjectReference; type: CValue['type']; firstIndex: number };
  readonly initializeObject: (
    reference: ObjectReference,
    type: CValue['type'],
    initializer: Initializer,
    frame: Frame,
    depth?: number,
  ) => void;
  readonly stringReference: (node: Extract<Expression, { kind: 'string' }>) => ObjectReference;
}

export function createInitializationRuntime(context: InitializationRuntimeContext): InitializationRuntime {
  const aggregateDefinition = (type: CValue['type'], at: Location): AggregateDefinition => {
    if (!isAggregate(type)) failure('INVALID_MEMBER', 'Member access requires a struct or union.', at);
    const descriptor = aggregateType(type);
    const definition = descriptor && context.ir.aggregates.find((candidate) => candidate.id === descriptor.id);
    if (!definition || !definition.complete) failure('INCOMPLETE_TYPE', 'The aggregate object is incomplete.', at);
    return definition;
  };
  const positionalAggregateMembers = (type: CValue['type'], at: Location): AggregateDefinition['members'][number][] =>
    aggregateDefinition(type, at).members.filter((member) => !(member.bitField && !member.name));
  const immediateSubobject = (
    reference: ObjectReference,
    type: CValue['type'],
    index: number,
    at: Location,
  ): { reference: ObjectReference; type: CValue['type'] } => {
    if (!Number.isSafeInteger(index) || index < 0) failure('INVALID_INITIALIZER', 'The initializer selects an invalid subobject.', at);
    const array = arrayType(type);
    if (array) {
      if (array.length === null || index >= array.length) failure('INITIALIZER_BOUNDS', 'Initializer exceeds the array length.', at);
      const child = context.memory.element(reference, index, at);
      return { reference: child, type: array.element };
    }
    if (isAggregate(type)) {
      const definition = aggregateDefinition(type, at);
      const member = definition.members[index];
      if (!member) failure('INITIALIZER_BOUNDS', 'Initializer exceeds the aggregate members.', at);
      return { reference: context.memory.member(reference, index, at), type: member.type };
    }
    if (index !== 0) failure('EXCESS_INITIALIZERS', 'A scalar object can only have one initializer.', at);
    return { reference, type };
  };
  const designatedSubobject = (
    root: ObjectReference,
    rootType: CValue['type'],
    designators: readonly InitializerDesignator[],
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
        if (index < 0) failure('UNKNOWN_MEMBER', 'The aggregate has no member named «' + designator.name + '».', designator.location);
      } else {
        if (!isArray(type)) failure('INVALID_DESIGNATOR', 'An index designator requires an array.', designator.location);
        if (designator.index > BigInt(Number.MAX_SAFE_INTEGER)) failure('INITIALIZER_BOUNDS', 'The initializer index exceeds the representable range.', designator.location);
        index = Number(designator.index);
      }
      if (position === 0) firstIndex = index;
      const child = immediateSubobject(reference, type, index, designator.location);
      reference = child.reference;
      type = child.type;
    }
    return { reference, type, firstIndex };
  };

  function* scalarSubobjects(
    root: ObjectReference,
    rootType: CValue['type'],
    at: Location,
  ): Generator<{ reference: ObjectReference; type: CValue['type'] }> {
    const pending: { reference: ObjectReference; type: CValue['type']; next: number }[] = [{ reference: root, type: rootType, next: 0 }];
    while (pending.length) {
      const current = pending.at(-1)!;
      const array = arrayType(current.type);
      if (array) {
        if (array.length === null) failure('INCOMPLETE_TYPE', 'The initializer array is incomplete.', at);
        if (current.next >= array.length) { pending.pop(); continue; }
        const index = current.next++;
        pending.push({ reference: context.memory.element(current.reference, index, at), type: array.element, next: 0 });
      } else if (isAggregate(current.type)) {
        const definition = aggregateDefinition(current.type, at);
        const members = positionalAggregateMembers(current.type, at);
        const count = definition.kind === 'union' ? Math.min(members.length, 1) : members.length;
        if (current.next >= count) { pending.pop(); continue; }
        const index = current.next++;
        const member = members[index];
        pending.push({ reference: context.memory.member(current.reference, member.index, at), type: member.type, next: 0 });
      } else {
        yield { reference: current.reference, type: current.type };
        pending.pop();
      }
    }
  }

  const initializeObject = (
    reference: ObjectReference,
    type: CValue['type'],
    initializer: Initializer,
    frame: Frame,
    depth = 1,
  ): void => {
    if (initializer.kind === 'expression') {
      const expression = initializer.value;
      const array = arrayType(type);
      if (array && unqualifiedType(array.element) === 'char' && expression.kind === 'string') {
        if (array.length === null) failure('INCOMPLETE_TYPE', 'The character array does not have a complete length.', initializer.location);
        if (expression.bytes.length > array.length + 1) failure('INITIALIZER_BOUNDS', 'The string literal is longer than the destination array.', initializer.location);
        context.memory.zeroInitialize(reference, initializer.location);
        const count = Math.min(array.length, expression.bytes.length);
        for (let index = 0; index < count; index++) {
          const element = context.memory.element(reference, index, initializer.location);
          context.memory.write(element, context.valueForType(context.integer(BigInt.asIntN(8, BigInt(expression.bytes[index]))), array.element, initializer.location), initializer.location, true);
        }
        return;
      }
      context.evaluateFullExpression(expression, frame, () => {
        const result = context.operands.pop();
        if (!result) failure('ENGINE_STACK_ERROR', 'Missing initializer value.', initializer.location);
        const value = context.materialize(result, initializer.location);
        const converted = context.valueForType(value, type, initializer.location);
        context.memory.write(reference, converted, initializer.location, true);
        if (isPointer(type)) context.setPointerBasesForObject(reference, result.pointerBases, result.unknownPointerBases);
        if (isInteger(type)) {
          context.setIntegerPointerBasesForObject(reference, context.integerValueBases.get(converted), context.unknownIntegerValueBases.get(converted));
        }
      }, depth + 1);
      return;
    }

    context.memory.zeroInitialize(reference, initializer.location);
    const array = arrayType(type);
    if (array && unqualifiedType(array.element) === 'char' && initializer.items.length === 1 &&
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
        if (slot.done) failure('EXCESS_INITIALIZERS', 'The initializer contains more values than subobjects.', item.location);
        jobs.push({ ...slot.value, initializer: item.initializer });
      }
      for (let index = jobs.length - 1; index >= 0; index--) {
        const job = jobs[index];
        context.work.push(() => initializeObject(job.reference, job.type, job.initializer, frame, depth + 1));
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
      } else if (isArray(type)) {
        selected = immediateSubobject(reference, type, nextIndex++, item.location);
      } else if (isAggregate(type)) {
        const members = positionalAggregateMembers(type, item.location);
        const member = members.find((candidate) => candidate.index >= nextIndex);
        if (!member) failure('EXCESS_INITIALIZERS', 'The initializer contains more values than subobjects.', item.location);
        selected = immediateSubobject(reference, type, member.index, item.location);
        nextIndex = member.index + 1;
      } else {
        if (nextIndex++) failure('EXCESS_INITIALIZERS', 'A scalar object can only have one initializer.', item.location);
        selected = { reference, type };
      }
      jobs.push({ ...selected, initializer: item.initializer });
    }
    for (let index = jobs.length - 1; index >= 0; index--) {
      const job = jobs[index];
      context.work.push(() => initializeObject(job.reference, job.type, job.initializer, frame, depth + 1));
    }
  };
  const stringReference = (node: Extract<Expression, { kind: 'string' }>): ObjectReference => {
    // Parser IR carries the terminating NUL in bytes; VirtualMemory appends it
    // while constructing the read-only static object.
    const bytes = node.bytes.length && node.bytes[node.bytes.length - 1] === 0
      ? node.bytes.slice(0, -1)
      : node.bytes;
    const prior = context.debugEvents ? context.memory.findStaticObject(node) : undefined;
    if (prior) return prior;
    const allocate = () => context.memory.stringLiteral(node, bytes, node.location);
    return context.debugEvents
      ? context.allocateDebugObject(allocate, {
        duration: 'static', origin: 'string-literal',
        typeSummary: `char[${bytes.length + 1}]`, location: node.location,
        frameId: null, scopeId: null,
      })
      : allocate();
  };

  return {
    aggregateDefinition,
    positionalAggregateMembers,
    immediateSubobject,
    designatedSubobject,
    initializeObject,
    stringReference,
  };
}
