import type {
  AggregateMember, CType, Expression, Initializer, InitializerDesignator, Location,
} from './internal.ts';
import { failure } from './internal.ts';
import { aggregateMemberPath, constantExpression, isNullPointerConstant } from './parser-constant-expressions.ts';
import type { ExpressionOperations, FunctionAnalysisContext } from './parser-analysis-context.ts';
import { aggregateType, arrayType, isAggregate, isArithmetic, isArray, isComplete, isInteger, isPointer, unqualifiedType, typeName } from './type-system.ts';

export function analyzeInitializerWithContext(
  context: FunctionAnalysisContext,
  operations: ExpressionOperations,
  type: CType,
  initializer: Initializer,
  fileDuration: boolean,
): Initializer {
  const { aggregates } = context.environment;
  const { fn } = context;
  const analyzeExpression = operations.analyzeExpression;
  const convertedValue = operations.convertedValue;
  const canAssign = operations.canAssign;
  const findMemberPath = (memberType: CType, name: string, at: Location): AggregateMember[] =>
    aggregateMemberPath(memberType, name, aggregates, at);
    const integerConstantValue = (node: Expression): bigint | undefined => {
      try {
        const value = constantExpression(node, aggregates);
        return isInteger(value.type) && typeof value.value === 'bigint' ? value.value : undefined;
      } catch { return undefined; }
    };
    const isArithmeticConstantExpression = (root: Expression): boolean => {
      const pending: Expression[] = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.kind === 'literal') { if (!isArithmetic(node.value.type)) return false; continue; }
        if (node.kind === 'call') {
          if (node.builtin === true && node.args.length === 0 && (node.name === '__c11_inf' || node.name === '__c11_nan')) continue;
          return false;
        }
        if (node.kind === 'sizeof') continue;
        if (node.kind === 'cast') {
          if (!isArithmetic(node.targetType)) return false;
          pending.push(node.operand); continue;
        }
        if (node.kind === 'unary') {
          if (!['+', '-', '!', '~'].includes(node.operator)) return false;
          pending.push(node.operand); continue;
        }
        if (node.kind === 'binary') {
          if (node.operator === ',') return false;
          pending.push(node.left, node.right); continue;
        }
        if (node.kind === 'conditional') { pending.push(node.condition, node.then, node.else); continue; }
        return false;
      }
      return true;
    };
    const isStaticAddressConstant = (node: Expression): boolean => {
      if (node.kind === 'function' || node.kind === 'string') return true;
      if (node.kind === 'unary' && node.operator === '&') {
        const operand = node.operand;
        if (operand.kind === 'function') return true;
        if (operand.kind === 'variable') return operand.globalBinding !== undefined;
        if (operand.kind === 'index' || operand.kind === 'member') return isStaticObjectDesignator(operand);
        if (operand.kind === 'unary' && operand.operator === '*') return isStaticAddressConstant(operand.operand);
        if (operand.kind === 'compoundLiteral') return operand.duration === 'static' && isStaticInitializer(operand.initializer);
        return false;
      }
      if (node.kind === 'decay') return node.operand.kind === 'string' || node.operand.kind === 'function' || node.operand.kind === 'variable' && node.operand.globalBinding !== undefined ||
        node.operand.kind === 'compoundLiteral' && node.operand.duration === 'static' && isStaticInitializer(node.operand.initializer);
      if (node.kind === 'cast' && isPointer(node.targetType)) return isStaticAddressConstant(node.operand) || integerConstantValue(node.operand) !== undefined;
      if (node.kind === 'binary' && (node.operator === '+' || node.operator === '-')) {
        return isStaticAddressConstant(node.left) && integerConstantValue(node.right) !== undefined ||
          node.operator === '+' && integerConstantValue(node.left) !== undefined && isStaticAddressConstant(node.right);
      }
      if (node.kind === 'compoundLiteral') return node.duration === 'static' && isStaticInitializer(node.initializer);
      return false;
    };
    const isStaticObjectDesignator = (node: Expression): boolean => {
      if (node.kind === 'variable') return node.globalBinding !== undefined;
      if (node.kind === 'member') return node.arrow ? isStaticAddressConstant(node.base) : isStaticObjectDesignator(node.base);
      if (node.kind === 'index') return integerConstantValue(node.index) !== undefined &&
        (isStaticObjectDesignator(node.base) || isStaticAddressConstant(node.base));
      if (node.kind === 'unary' && node.operator === '*') return isStaticAddressConstant(node.operand);
      return false;
    };
    const isStaticInitializerExpression = (node: Expression): boolean => {
      if (node.kind === 'string') return true;
      if (isArithmetic(node.type ?? 'void')) return isArithmeticConstantExpression(node);
      if (isPointer(node.type ?? 'void')) return isNullPointerConstant(node, aggregates) || isStaticAddressConstant(node);
      if (node.kind === 'compoundLiteral') return node.duration === 'static' && isStaticInitializer(node.initializer);
      return false;
    };
    function isStaticInitializer(initializer: Initializer): boolean {
      if (initializer.kind === 'expression') return isStaticInitializerExpression(initializer.value);
      return initializer.items.every(item => isStaticInitializer(item.initializer));
    }
    function* scalarInitializerTypes(root: CType): Generator<CType> {
      const pending: { type: CType; next: number; count: number }[] = [{ type: root, next: 0, count: 0 }];
      while (pending.length) {
        const current = pending[pending.length - 1];
        if (isArray(current.type)) {
          const array = arrayType(current.type)!;
          if (array.length === null) failure('INCOMPLETE_TYPE', 'An incomplete array cannot be initialized by subobjects.', fn.location);
          if (current.next >= array.length) { pending.pop(); continue; }
          current.next++;
          pending.push({ type: array.element, next: 0, count: 0 });
          continue;
        }
        if (isAggregate(current.type)) {
          const aggregate = aggregateType(current.type)!;
          const definition = aggregates.find(value => value.id === aggregate.id)!;
          current.count = definition.kind === 'union' ? Math.min(1, definition.members.length) : definition.members.length;
          if (current.next >= current.count) { pending.pop(); continue; }
          const member = definition.members[current.next++];
          pending.push({ type: member.type, next: 0, count: 0 });
          continue;
        }
        yield current.type;
        pending.pop();
      }
    }
    const analyzeInitializer = (type: CType, initializer: Initializer, fileDuration: boolean): Initializer => {
      if (!isComplete(type, aggregates)) failure('INCOMPLETE_TYPE', 'Initializer requires a complete object.', initializer.location);
      if (initializer.kind === 'expression') {
        const original = initializer.value;
        const sourceType = analyzeExpression(original);
        const targetArray = arrayType(type);
        if (targetArray && unqualifiedType(targetArray.element) === 'char' && original.kind === 'string') {
          const textLength = original.bytes.length - 1;
          if (targetArray.length! < textLength) failure('INITIALIZER_TOO_LARGE', 'The string does not fit in the character array.', original.location);
        } else {
          initializer.value = convertedValue(original);
          if (!canAssign(type, initializer.value.type!, initializer.value)) failure('TYPE_ERROR', `Cannot initialize ${typeName(type, aggregates)} with ${typeName(sourceType, aggregates)}.`, original.location);
        }
        if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'An object with static storage duration requires a constant initializer.', initializer.location);
        return initializer;
      }

      const targetArray = arrayType(type);
      if (targetArray && unqualifiedType(targetArray.element) === 'char' && initializer.items.length === 1 && initializer.items[0].designators.length === 0) {
        const single = initializer.items[0].initializer;
        if (single.kind === 'expression' && single.value.kind === 'string') return analyzeInitializer(type, single, fileDuration);
      }
      if ((isArray(type) || isAggregate(type)) && initializer.items.length > 0 &&
          initializer.items.every(item => item.designators.length === 0 && item.initializer.kind === 'expression') &&
          initializer.items.every(item => !isAggregate(analyzeExpression((item.initializer as Extract<Initializer, { kind: 'expression' }>).value)))) {
        const slots = scalarInitializerTypes(type);
        for (const item of initializer.items) {
          const slot = slots.next();
          if (slot.done) failure('INITIALIZER_TOO_LARGE', 'The initializer has more values than scalar subobjects.', item.location);
          analyzeInitializer(slot.value, item.initializer, fileDuration);
        }
        if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'An object with static storage duration requires a constant initializer.', initializer.location);
        return initializer;
      }
      let nextIndex = 0;
      let count = 0;
      for (const item of initializer.items) {
        if (isArray(type)) {
          const array = arrayType(type)!;
          let selected = nextIndex;
          let childType: CType = array.element;
          if (item.designators.length) {
            const first = item.designators[0];
            if (first.kind !== 'index') failure('INVALID_DESIGNATOR', 'An array requires an index designator.', first.location);
            if (first.index > BigInt(Number.MAX_SAFE_INTEGER)) failure('INVALID_DESIGNATOR', 'The designated index exceeds the representable range.', first.location);
            selected = Number(first.index);
            if (array.length !== null && selected >= array.length) failure('INVALID_DESIGNATOR', 'The designated index exceeds the array bounds.', first.location);
            nextIndex = selected + 1;
            childType = followDesignators(type, item.designators);
          } else {
            if (array.length !== null && selected >= array.length) failure('INITIALIZER_TOO_LARGE', 'There are more elements than array slots.', item.location);
            nextIndex++; childType = followDesignators(childType, []);
          }
          analyzeInitializer(childType, item.initializer, fileDuration); count++; continue;
        }
        if (isAggregate(type)) {
          const aggregate = aggregateType(type)!;
          const definition = aggregates.find(value => value.id === aggregate.id)!;
          if (definition.kind === 'union' && count > 0) failure('INITIALIZER_TOO_LARGE', 'A union can only initialize one member.', item.location);
          let member: AggregateMember;
          if (item.designators.length) {
            const first = item.designators[0];
            if (first.kind !== 'member') failure('INVALID_DESIGNATOR', 'A struct or union requires a member designator.', first.location);
            const nestedType = followDesignators(type, item.designators);
            const selected = item.designators[0];
            if (selected.kind !== 'member') failure('ENGINE_INTERNAL_ERROR', 'The member path lost its initial designator.', item.location);
            member = definition.members[selected.memberIndex ?? definition.members.findIndex(value => value.name === selected.name)];
            if (!member) failure('UNKNOWN_MEMBER', `The aggregate has no member «${first.name}».`, first.location);
            nextIndex = member.index + 1;
            analyzeInitializer(nestedType, item.initializer, fileDuration); count++; continue;
          }
          if (nextIndex >= definition.members.length) failure('INITIALIZER_TOO_LARGE', 'There are more initializers than aggregate members.', item.location);
          member = definition.members[nextIndex++];
          analyzeInitializer(member.type, item.initializer, fileDuration); count++; continue;
        }
        if (item.designators.length) failure('INVALID_DESIGNATOR', 'A scalar cannot use designators.', item.designators[0].location);
        if (count > 0) failure('INITIALIZER_TOO_LARGE', 'A scalar can only have one initializer.', item.location);
        analyzeInitializer(type, item.initializer, fileDuration); count++;
      }
      if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'An object with static storage duration requires a constant initializer.', initializer.location);
      return initializer;
    };
    const followDesignators = (initial: CType, designators: InitializerDesignator[]): CType => {
      let type = initial;
      const expanded: InitializerDesignator[] = [];
      for (const designator of designators) {
        if (designator.kind === 'member') {
          if (!isAggregate(type)) failure('INVALID_DESIGNATOR', 'A member designator requires a struct or union.', designator.location);
          const aggregate = aggregateType(type)!;
          const definition = aggregates.find(value => value.id === aggregate.id)!;
          let path: AggregateMember[];
          if (designator.memberIndex !== undefined) {
            const member = definition.members[designator.memberIndex];
            if (!member || member.name !== designator.name) failure('INVALID_DESIGNATOR', 'The designated member index does not match the aggregate.', designator.location);
            path = [member];
          } else path = findMemberPath(aggregate, designator.name, designator.location);
          for (const member of path) {
            expanded.push({ kind: 'member', name: member.name, memberIndex: member.index, location: designator.location });
            type = member.type;
          }
        } else {
          const array = arrayType(type);
          if (!array) failure('INVALID_DESIGNATOR', 'An index designator requires an array.', designator.location);
          if (designator.index > BigInt(Number.MAX_SAFE_INTEGER) || array.length !== null && designator.index >= BigInt(array.length)) failure('INVALID_DESIGNATOR', 'The designated index exceeds the array bounds.', designator.location);
          expanded.push(designator);
          type = array.element;
        }
      }
      designators.splice(0, designators.length, ...expanded);
      return type;
    };
  return analyzeInitializer(type, initializer, fileDuration);
}
