import type { AggregateDefinition, AggregateMember, CType, CValue, Expression, GenericAssociation, Location } from './internal.ts';
import { failure } from './internal.ts';
import { binary, commonType, convert, promote, truth, unary } from './numeric.ts';
import {
  aggregateType, compatibleType, decayType, hasVariableLengthObjectSize, isArithmetic, isArray, isComplete,
  isFunction, isInteger, isPointer, isScalar, pointedToType, sizeOfType, unqualifiedType,
} from './type-system.ts';

export const isNullPointerConstant = (node: Expression, aggregates: readonly AggregateDefinition[] = []): boolean => {
  if (node.kind === 'cast' && isPointer(node.targetType) && pointedToType(node.targetType) === 'void') {
    return isNullPointerConstant(node.operand, aggregates);
  }
  try {
    if (!isIntegerConstantExpression(node, aggregates)) return false;
    const value = constantExpression(node, aggregates);
    return isInteger(value.type) && typeof value.value === 'bigint' && value.value === 0n;
  } catch {
    return false;
  }
};

export function expressionChildren(node: Expression): Expression[] {
  switch (node.kind) {
    case 'literal': case 'string': case 'variable': case 'function': return [];
    case 'unary': case 'update': case 'cast': case 'decay': return [node.operand];
    case 'sizeof': return node.operand ? [node.operand] : [];
    case 'binary': return [node.left, node.right];
    case 'assignment': return [node.target, node.value];
    case 'conditional': return [node.condition, node.then, node.else];
    case 'index': return [node.base, node.index];
    case 'member': return [node.base];
    case 'generic': return [node.control, ...node.associations.map((association) => association.expression)];
    case 'compoundLiteral': return [];
    case 'vaArg': return [node.ap];
    case 'call': return [...(node.callee ? [node.callee] : []), ...node.args];
  }
}

type GenericSelectionResolver = (node: Extract<Expression, { kind: 'generic' }>) => Expression | undefined;

export function selectGenericAssociation(
  controlType: CType,
  associations: readonly GenericAssociation[],
  aggregates: readonly AggregateDefinition[],
  at: Location,
): Expression {
  const normalizedControlType = isArray(controlType) || isFunction(controlType)
    ? decayType(controlType)
    : unqualifiedType(controlType);
  let selected: Expression | undefined;
  let defaultExpression: Expression | undefined;
  const seenAssociationTypes: CType[] = [];
  for (const association of associations) {
    if (!association.type) {
      if (defaultExpression) failure('TYPE_ERROR', '_Generic cannot repeat the default association.', association.location);
      defaultExpression = association.expression;
      continue;
    }
    const associationType = association.type;
    if (!isComplete(associationType, aggregates) || isFunction(associationType) || unqualifiedType(associationType) === 'void') {
      failure('TYPE_ERROR', 'A _Generic association must name a complete object type.', association.location);
    }
    if (seenAssociationTypes.some((prior) => compatibleType(prior, associationType))) {
      failure('TYPE_ERROR', '_Generic associations cannot have compatible types.', association.location);
    }
    seenAssociationTypes.push(associationType);
    if (compatibleType(normalizedControlType, associationType)) selected = association.expression;
  }
  selected ??= defaultExpression;
  if (!selected) failure('NO_GENERIC_ASSOCIATION', 'No _Generic association matches the controlling type.', at);
  return selected;
}

export function isIntegerConstantExpression(
  root: Expression,
  aggregates: readonly AggregateDefinition[],
  resolveGeneric?: GenericSelectionResolver,
): boolean {
  const pending: { node: Expression; evaluated: boolean }[] = [{ node: root, evaluated: true }];
  while (pending.length) {
    const { node, evaluated } = pending.pop()!;
    switch (node.kind) {
      case 'literal':
        if (!isInteger(node.value.type)) return false;
        break;
      case 'sizeof':
        // A VLA's runtime size is not an integer constant expression.
        if (!node.valueType && !node.operand?.type) return false;
        if (hasVariableLengthObjectSize(node.valueType ?? node.operand!.type!)) return false;
        break;
      case 'generic': {
        const selected = resolveGeneric?.(node) ?? node.selected;
        if (!selected) return false;
        pending.push({ node: selected, evaluated });
        break;
      }
      case 'cast':
        if (!isInteger(node.targetType)) return false;
        if (node.operand.kind === 'literal' && isArithmetic(node.operand.value.type) && !isInteger(node.operand.value.type)) break;
        pending.push({ node: node.operand, evaluated });
        break;
      case 'unary':
        if (!['+', '-', '~', '!'].includes(node.operator)) return false;
        pending.push({ node: node.operand, evaluated });
        break;
      case 'binary': {
        if (node.operator === ',' && evaluated) return false;
        if (!['||', '&&', '|', '^', '&', '==', '!=', '<', '>', '<=', '>=', '<<', '>>', '+', '-', '*', '/', '%'].includes(node.operator)) return false;
        pending.push({ node: node.left, evaluated });
        if (evaluated && (node.operator === '&&' || node.operator === '||')) {
          try {
            const left = constantExpression(node.left, aggregates, resolveGeneric);
            const shortCircuits = node.operator === '&&' ? !truth(left) : truth(left);
            pending.push({ node: node.right, evaluated: !shortCircuits });
          } catch { return false; }
        } else pending.push({ node: node.right, evaluated });
        break;
      }
      case 'conditional': {
        pending.push({ node: node.condition, evaluated });
        if (!evaluated) {
          pending.push({ node: node.then, evaluated: false }, { node: node.else, evaluated: false });
        } else try {
          const condition = constantExpression(node.condition, aggregates, resolveGeneric);
          pending.push({ node: node.then, evaluated: truth(condition) });
          pending.push({ node: node.else, evaluated: !truth(condition) });
        } catch { return false; }
        break;
      }
      case 'assignment':
        if (evaluated) return false;
        pending.push({ node: node.target, evaluated: false }, { node: node.value, evaluated: false });
        break;
      case 'update':
        if (evaluated) return false;
        pending.push({ node: node.operand, evaluated: false });
        break;
      case 'call':
        if (evaluated) return false;
        if (node.callee) pending.push({ node: node.callee, evaluated: false });
        for (const argument of node.args) pending.push({ node: argument, evaluated: false });
        break;
      case 'variable': case 'function': case 'string': case 'index': case 'member': case 'decay': case 'compoundLiteral': case 'vaArg':
        return false;
    }
  }
  return true;
}

export function requireIntegerConstantExpression(
  expression: Expression,
  context: string,
  aggregates: readonly AggregateDefinition[],
  resolveGeneric?: GenericSelectionResolver,
): void {
  if (!isIntegerConstantExpression(expression, aggregates, resolveGeneric)) {
    failure('TYPE_ERROR', `${context} must be an integer constant expression.`, expression.location);
  }
}

export const requireInteger = (type: CType, location: Location) => {
  if (!isInteger(type)) failure('TYPE_ERROR', 'This operator requires integer operands.', location);
};
export const requireArithmetic = (type: CType, location: Location) => {
  if (!isArithmetic(type)) failure('TYPE_ERROR', 'This operator requires an arithmetic type.', location);
};
export const requireScalar = (type: CType, location: Location) => {
  if (!isScalar(type)) failure('TYPE_ERROR', 'This operator requires a scalar operand.', location);
};

export function aggregateMemberPath(type: CType, name: string, aggregates: readonly AggregateDefinition[], at: Location): AggregateMember[] {
  const rootType = aggregateType(type);
  if (!rootType) failure('TYPE_ERROR', 'Member access requires a struct or union.', at);
  const root = aggregates.find(item => item.id === rootType.id);
  if (!root || !root.complete) failure('INCOMPLETE_TYPE', 'Cannot access members of an incomplete aggregate.', at);
  const matches: AggregateMember[][] = [];
  const pending: { definition: AggregateDefinition; path: AggregateMember[] }[] = [{ definition: root, path: [] }];
  while (pending.length) {
    const current = pending.pop()!;
    for (let index = current.definition.members.length - 1; index >= 0; index--) {
      const member = current.definition.members[index];
      const path = [...current.path, member];
      if (member.name === name) matches.push(path);
      else if (member.name === '') {
        const nestedType = aggregateType(member.type);
        const nested = nestedType && aggregates.find(item => item.id === nestedType.id);
        if (nested?.complete) pending.push({ definition: nested, path });
      }
    }
  }
  if (!matches.length) failure('UNKNOWN_MEMBER', `The aggregate has no member «${name}».`, at);
  if (matches.length > 1) failure('AMBIGUOUS_MEMBER', `Member «${name}» is promoted by more than one anonymous member.`, at);
  return matches[0];
}

export function constantExpression(
  root: Expression,
  aggregates: readonly AggregateDefinition[],
  resolveGeneric?: GenericSelectionResolver,
): CValue {
  type Task =
    | { kind: 'evaluate'; node: Expression }
    | { kind: 'unary'; node: Extract<Expression, { kind: 'unary' | 'cast' }> }
    | { kind: 'binary-left'; node: Extract<Expression, { kind: 'binary' }> }
    | { kind: 'binary-right'; node: Extract<Expression, { kind: 'binary' }>; left: CValue }
    | { kind: 'conditional'; node: Extract<Expression, { kind: 'conditional' }>; selected?: Expression };
  const inferIntegerType = (root: Expression): CType => {
    const types = new Map<Expression, CType>();
    const pending: { node: Expression; done: boolean }[] = [{ node: root, done: false }];
    while (pending.length) {
      const current = pending.pop()!;
      const node = current.node;
      if (!current.done) {
        if (node.type) { types.set(node, node.type); continue; }
        pending.push({ node, done: true });
        const selected = node.kind === 'generic' ? resolveGeneric?.(node) ?? node.selected : undefined;
        const children = node.kind === 'sizeof' ? [] : node.kind === 'generic' ? selected ? [selected] : [] : expressionChildren(node);
        for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], done: false });
        continue;
      }
      switch (node.kind) {
        case 'literal': types.set(node, node.value.type); break;
        case 'sizeof': types.set(node, 'unsigned long'); break;
        case 'generic': {
          const selected = resolveGeneric?.(node) ?? node.selected;
          if (!selected || !types.get(selected)) failure('NON_CONSTANT_CASE', 'Cannot determine the selected _Generic association.', node.location);
          types.set(node, types.get(selected)!);
          break;
        }
        case 'cast': types.set(node, node.targetType); break;
        case 'unary': types.set(node, node.operator === '!' ? 'int' : promote(types.get(node.operand)!)); break;
        case 'binary':
          types.set(node, node.operator === ',' ? types.get(node.right)!
            : ['&&', '||', '==', '!=', '<', '>', '<=', '>='].includes(node.operator)
              ? 'int' : node.operator === '<<' || node.operator === '>>' ? promote(types.get(node.left)!) : commonType(types.get(node.left)!, types.get(node.right)!));
          break;
        case 'conditional': types.set(node, commonType(types.get(node.then)!, types.get(node.else)!)); break;
        default: failure('NON_CONSTANT_CASE', 'case requires an integer constant expression.', node.location);
      }
    }
    return types.get(root)!;
  };
  const values = new Map<Expression, CValue>();
  const tasks: Task[] = [{ kind: 'evaluate', node: root }];
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === 'evaluate') {
      const node = task.node;
      if (node.kind === 'literal') { values.set(node, node.value); continue; }
      if (node.kind === 'sizeof') {
        const type = node.valueType ?? node.operand?.type;
        if (!type) failure('NON_CONSTANT_CASE', 'sizeof requires a known type in a constant expression.', node.location);
        values.set(node, { type: 'unsigned long', value: BigInt(sizeOfType(type, aggregates, node.location)) }); continue;
      }
      if (node.kind === 'generic') {
        const selected = resolveGeneric?.(node) ?? node.selected;
        if (!selected) failure('NON_CONSTANT_CASE', 'Cannot determine the selected _Generic association.', node.location);
        values.set(node, constantExpression(selected, aggregates, resolveGeneric)); continue;
      }
      if (node.kind === 'cast' || node.kind === 'unary') {
        tasks.push({ kind: 'unary', node }); tasks.push({ kind: 'evaluate', node: node.operand }); continue;
      }
      if (node.kind === 'binary') {
        tasks.push({ kind: 'binary-left', node }); tasks.push({ kind: 'evaluate', node: node.left }); continue;
      }
      if (node.kind === 'conditional') {
        tasks.push({ kind: 'conditional', node }); tasks.push({ kind: 'evaluate', node: node.condition }); continue;
      }
      failure('NON_CONSTANT_CASE', 'case requires an integer constant expression.', node.location);
    }
    if (task.kind === 'unary') {
      const operand = values.get(task.node.operand)!;
      if (task.node.kind === 'cast') {
        if (!isInteger(task.node.targetType)) failure('NON_CONSTANT_CASE', 'A constant can only be converted to an integer type.', task.node.location);
        values.set(task.node, convert(operand, task.node.targetType, task.node.location));
      } else if (task.node.operator === '!') values.set(task.node, { type: 'int', value: truth(operand) ? 0n : 1n });
      else values.set(task.node, unaryConstant(task.node.operator, operand, task.node.location));
      continue;
    }
    if (task.kind === 'binary-left') {
      const left = values.get(task.node.left)!;
      if (task.node.operator === '&&' && !truth(left)) { values.set(task.node, { type: 'int', value: 0n }); continue; }
      if (task.node.operator === '||' && truth(left)) { values.set(task.node, { type: 'int', value: 1n }); continue; }
      if (task.node.operator === ',') failure('NON_CONSTANT_CASE', 'The comma operator is not part of an evaluated integer constant expression.', task.node.location);
      tasks.push({ kind: 'binary-right', node: task.node, left }); tasks.push({ kind: 'evaluate', node: task.node.right }); continue;
    }
    if (task.kind === 'binary-right') {
      const right = values.get(task.node.right)!;
      values.set(task.node, binary(task.node.operator, task.left, right, task.node.location)); continue;
    }
    if (task.selected) {
      const selectedValue = values.get(task.selected)!;
      const resultType = task.node.type ?? commonType(inferIntegerType(task.node.then), inferIntegerType(task.node.else));
      values.set(task.node, convert(selectedValue, resultType, task.node.location));
    } else {
      const condition = values.get(task.node.condition)!;
      const selected = truth(condition) ? task.node.then : task.node.else;
      tasks.push({ kind: 'conditional', node: task.node, selected });
      tasks.push({ kind: 'evaluate', node: selected });
    }
  }
  const result = values.get(root)!;
  if (!isInteger(result.type)) failure('NON_CONSTANT_CASE', 'case requires an integer constant expression.', root.location);
  return result;
}
export function unaryConstant(operator: string, value: CValue, at: Location): CValue {
  return unary(operator, value, at);
}
