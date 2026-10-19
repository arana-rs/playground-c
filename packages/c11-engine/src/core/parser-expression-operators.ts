import type { Expression } from './internal.ts';
import { enforceLimit, failure } from './internal.ts';
import type { ExpressionMarker, ExpressionOperator, ExpressionOperatorContext } from './parser-expression-types.ts';
import type { Token } from './internal.ts';

export const operators: Record<string, number> = {
  ',': 1, '=': 2, '+=': 2, '-=': 2, '*=': 2, '/=': 2, '%=': 2, '&=': 2, '|=': 2, '^=': 2, '<<=': 2, '>>=': 2, '?:': 3,
  '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '<<': 11, '>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13,
};
export const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

export function createExpressionOperatorActions(context: ExpressionOperatorContext) {
  const { values, stack, markers, questionCounts, limits, peek, consume, pushValue, relatedFragment, syntaxFailureWithRelated } = context;

const operatorPrecedence = (operator: ExpressionOperator): number => operator.kind === 'unary' ? 14 :
  operator.kind === 'binary' || operator.kind === 'conditional' ? operators[operator.operator] ?? 0 : 0;
const reduce = (): void => {
  const operator = stack.pop();
  if (!operator || operator.kind === 'group' || operator.kind === 'call' || operator.kind === 'index' || operator.kind === 'question') {
    failure('SYNTAX_ERROR', 'Incomplete expression.', operator?.token ?? peek());
  }
  const right = values.pop();
  if (!right) failure('SYNTAX_ERROR', 'Missing right operand.', operator.token);
  if (operator.kind === 'unary') {
    const expression: Expression = operator.operator === 'sizeof'
      ? { kind: 'sizeof', operand: right.expression, location: operator.token }
      : operator.operator === '++' || operator.operator === '--'
        ? { kind: 'update', operator: operator.operator, operand: right.expression, prefix: true, location: operator.token }
        : operator.operator === 'cast'
          ? { kind: 'cast', targetType: operator.targetType!, operand: right.expression, location: operator.token }
          : { kind: 'unary', operator: operator.operator, operand: right.expression, location: operator.token };
    pushValue(expression, right.depth + 1);
    return;
  }
  const left = values.pop();
  if (!left) failure('SYNTAX_ERROR', 'Missing left operand.', operator.token);
  if (operator.kind === 'conditional') {
    const condition = values.pop();
    if (!condition) failure('SYNTAX_ERROR', 'Missing condition in ?: expression.', operator.token);
    pushValue({ kind: 'conditional', condition: condition.expression, then: left.expression, else: right.expression, location: operator.token },
      Math.max(condition.depth, left.depth, right.depth) + 1);
  } else {
    const node = assignments.has(operator.operator)
      ? { kind: 'assignment' as const, target: left.expression, operator: operator.operator, value: right.expression, location: operator.token }
      : { kind: 'binary' as const, operator: operator.operator, left: left.expression, right: right.expression, location: operator.token };
    pushValue(node, Math.max(left.depth, right.depth) + 1);
  }
};
const openMarker = (marker: ExpressionMarker): void => {
  enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, marker.token);
  markers.push(stack.length);
  stack.push(marker);
  questionCounts.push(0);
};
const openingMarkerMessage = (marker: ExpressionMarker): string =>
  marker.kind === 'index' ? 'Opening subscript bracket for this expression.' :
    marker.kind === 'call' ? 'Opening parenthesis for this function call.' : 'Opening parenthesis for this expression.';
const expectedClosingDelimiter = (marker: ExpressionMarker): ')' | ']' => marker.kind === 'index' ? ']' : ')';
const closeMarker = (kind: ExpressionMarker['kind'], token: Token): void => {
  const open = markers[markers.length - 1];
  if (open === undefined) failure('SYNTAX_ERROR', `«${token.text}» has no matching opening delimiter.`, token);
  while (stack.length > open + 1) reduce();
  const marker = stack.pop()! as ExpressionMarker;
  if (marker.kind !== kind) {
    const related = relatedFragment(
      marker.token,
      token,
      openingMarkerMessage(marker),
    );
    syntaxFailureWithRelated(`Expected closing «${expectedClosingDelimiter(marker)}».`, token, related);
  }
  markers.pop(); questionCounts.pop(); consume();
  if (marker.kind === 'group') {
    if (values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Invalid expression inside parentheses.', token);
    context.expectingOperand = false;
    return;
  }
  if (marker.kind === 'call') {
    if (context.expectingOperand) {
      if (values.length !== marker.valueStart || marker.args.length || stack.length !== open) failure('SYNTAX_ERROR', 'Missing function-call argument.', token);
    } else {
      if (values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Invalid argument.', token);
      const argument = values.pop()!;
      marker.args.push(argument.expression); marker.maxDepth = Math.max(marker.maxDepth, argument.depth);
    }
    const depth = Math.max(marker.baseDepth, marker.maxDepth) + 1;
    pushValue({ kind: 'call', callee: marker.callee, args: marker.args, location: marker.token }, depth);
    context.expectingOperand = false;
    return;
  }
  if (context.expectingOperand || values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Subscript requires an expression.', token);
  const index = values.pop()!;
  pushValue({ kind: 'index', base: marker.base, index: index.expression, location: marker.token }, Math.max(marker.baseDepth, index.depth) + 1);
  context.expectingOperand = false;
};

const failForOpenMarker = (message: string, marker: ExpressionMarker, boundary: Token, unclosed = false): never => {
  const related = relatedFragment(
    marker.token,
    boundary,
    unclosed
      ? marker.kind === 'index' ? 'Unclosed subscript starts here.' :
        marker.kind === 'call' ? 'Unclosed function call starts here.' : 'Unclosed parenthesized expression starts here.'
      : openingMarkerMessage(marker),
  );
  return syntaxFailureWithRelated(message, boundary, related);
};
  return { operatorPrecedence, reduce, openMarker, openingMarkerMessage, expectedClosingDelimiter, closeMarker, failForOpenMarker };
}
