import type { CType, Expression, Location, Token } from './internal.ts';
import { enforceLimit, failure } from './internal.ts';
import { parseLiteral } from './numeric.ts';
import {
  alignOfType, arrayType, isComplete, isFunction, isInteger, sizeOfType,
} from './type-system.ts';
import { aggregateMemberPath, constantExpression } from './parser-constant-expressions.ts';
import { assignments, createExpressionOperatorActions, operators } from './parser-expression-operators.ts';
import type { ExpressionMarker, ExpressionOperator, ExpressionOperatorContext, ExpressionValue } from './parser-expression-types.ts';
import type { ExpressionGrammar, ParserContext } from './parser-context-types.ts';
import { C_KEYWORDS } from '../syntax.ts';

const reserved = new Set(C_KEYWORDS);
const unsupportedWords = new Set(['_Atomic', '_Complex', '_Imaginary']);

export function createExpressionParser(context: ParserContext): Pick<ExpressionGrammar, 'parseExpression'> {
  const { aggregates, limits } = context;
  const peek = (offset = 0): Token => context.peek(offset);
  const consume = (): Token => context.consume();
  const expect = (text: string): Token => context.expect(text);
  const identifier = (): Token => context.identifier();
  const unsupported = (token: Token, message?: string): never => context.unsupported(token, message);

const parseExpression = (minPrecedence = 1, stops: ReadonlySet<string> = new Set()): Expression => {
  const values: ExpressionValue[] = [];
  const stack: ExpressionOperator[] = [];
  const markers: number[] = [];
  const questionCounts = [0];
  let expectingOperand = true;
  const pushValue = (expression: Expression, depth: number) => {
    enforceLimit('maxDepth', depth, limits.maxDepth, expression.location);
    values.push({ expression, depth });
  };
  const operatorState: ExpressionOperatorContext = {
    values, stack, markers, questionCounts, limits,
    peek: () => context.peek(),
    consume: () => context.consume(),
    pushValue,
    relatedFragment: (opening: Location, boundary: Location, message: string) => context.relatedFragment(opening, boundary, message),
    syntaxFailureWithRelated: (message: string, location: Location, related?: import('./types.ts').RelatedDiagnosticLocation): never => context.syntaxFailureWithRelated(message, location, related),
    get expectingOperand() { return expectingOperand; },
    set expectingOperand(value: boolean) { expectingOperand = value; },
  };
  const { operatorPrecedence, reduce, openMarker, expectedClosingDelimiter, closeMarker, failForOpenMarker } = createExpressionOperatorActions(operatorState);

  while (true) {
    const token = peek();
    const open = markers[markers.length - 1] ?? -1;
    const pendingQuestion = questionCounts[questionCounts.length - 1] > 0;
    if (token.kind === 'eof' || open < 0 && stops.has(token.text) && !((token.text === ':' || token.text === ',') && pendingQuestion)) break;
    if (expectingOperand) {
      if (token.text === ')' && open >= 0 && stack[open].kind === 'call') {
        closeMarker('call', token); continue;
      }
      if (token.text === '+' || token.text === '-' || token.text === '!' || token.text === '~' || token.text === '&' || token.text === '*' || token.text === '++' || token.text === '--') {
        enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, token);
        stack.push({ kind: 'unary', token: consume(), operator: token.text });
        continue;
      }
      if (token.text === 'sizeof') {
        consume();
        if (peek().text === '(' && context.startsType(peek(1))) {
          consume(); const valueType = context.initializers.typeName(); expect(')');
          pushValue({ kind: 'sizeof', valueType, location: token }, 1); expectingOperand = false;
        } else {
          enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, token);
          stack.push({ kind: 'unary', token, operator: 'sizeof' });
        }
        continue;
      }
      if (token.text === '_Alignof') {
        consume();
        expect('(');
        if (!context.startsType()) failure('SYNTAX_ERROR', '_Alignof requires a parenthesized type name in C11.', peek());
        const type = context.initializers.typeName();
        expect(')');
        if (!isComplete(type, aggregates) || isFunction(type)) failure('INCOMPLETE_TYPE', '_Alignof requires a complete object type.', token);
        const alignment = alignOfType(type, aggregates, token);
        pushValue({ kind: 'literal', value: { type: 'unsigned long', value: BigInt(alignment) }, location: token }, 1);
        expectingOperand = false;
        continue;
      }
      if (token.text === '_Generic') {
        consume();
        expect('(');
        const control = context.expressions.parseExpression(2, new Set([',']));
        expect(',');
        const associations: import('./internal.ts').GenericAssociation[] = [];
        let defaultSeen = false;
        while (true) {
          const associationAt = peek();
          let associationType: CType | undefined;
          if (peek().text === 'default') {
            consume();
            if (defaultSeen) failure('TYPE_ERROR', '_Generic cannot repeat the default association.', associationAt);
            defaultSeen = true;
          } else {
            if (!context.startsType()) failure('SYNTAX_ERROR', 'Expected a type or default in a _Generic association.', peek());
            associationType = context.initializers.typeName();
            if (arrayType(associationType) && arrayType(associationType)!.length === null) failure('TYPE_ERROR', 'A _Generic association cannot use an incomplete array type.', associationAt);
          }
          expect(':');
          const expression = context.expressions.parseExpression(2, new Set([',', ')']));
          associations.push({ ...(associationType ? { type: associationType } : {}), expression, location: associationAt });
          if (peek().text !== ',') break;
          consume();
          if (peek().text === ')') failure('SYNTAX_ERROR', 'Missing association after the comma in _Generic.', peek());
        }
        expect(')');
        if (!associations.length) failure('SYNTAX_ERROR', '_Generic requires at least one association.', token);
        const genericNode: Extract<Expression, { kind: 'generic' }> = {
          kind: 'generic', control, associations, selected: associations[0].expression, location: token,
        };
        genericNode.selected = context.expressions.resolveGenericSelection?.(genericNode) ?? genericNode.selected;
        const depth = associations.length + 1;
        pushValue(genericNode, depth);
        expectingOperand = false;
        continue;
      }
      if (token.text === '__builtin_offsetof') {
        consume();
        expect('(');
        const objectType = context.initializers.typeName();
        expect(',');
        let offset = 0;
        let currentType = objectType;
        const firstMember = identifier();
        const addMember = (name: string, at: Location): void => {
          const path = aggregateMemberPath(currentType, name, aggregates, at);
          for (const member of path) {
            if (member.bitField) failure('TYPE_ERROR', 'offsetof cannot designate a bit-field.', at);
            offset += member.offset;
            currentType = member.type;
          }
        };
        addMember(firstMember.text, firstMember);
        while (peek().text === '.' || peek().text === '[') {
          if (peek().text === '.') {
            const dot = consume();
            addMember(identifier().text, dot);
          } else {
            const bracket = consume();
            const indexExpression = context.expressions.parseExpression(1, new Set([']']));
            const indexValue = constantExpression(indexExpression, aggregates);
            if (!isInteger(indexValue.type) || typeof indexValue.value !== 'bigint' || indexValue.value < 0n || indexValue.value > BigInt(Number.MAX_SAFE_INTEGER)) {
              failure('TYPE_ERROR', 'An offsetof index must be a representable nonnegative integer constant.', bracket);
            }
            expect(']');
            const array = arrayType(currentType);
            if (!array) failure('TYPE_ERROR', 'An indexed offsetof designator requires an array member.', bracket);
            if (array.length !== null && indexValue.value >= BigInt(array.length)) failure('INVALID_DESIGNATOR', 'The offsetof index exceeds the array bounds.', bracket);
            offset += Number(indexValue.value) * sizeOfType(array.element, aggregates, bracket);
            currentType = array.element;
          }
        }
        expect(')');
        pushValue({ kind: 'literal', value: { type: 'unsigned long', value: BigInt(offset) }, location: token }, 1);
        expectingOperand = false;
        continue;
      }
      if (token.text === '(' && context.startsType(peek(1))) {
        consume(); const targetType = context.initializers.typeName(); expect(')');
        if (peek().text === '{') {
          const initializer = context.initializers.parseInitializer();
          const literal: Expression = { kind: 'compoundLiteral', objectType: context.declarations.inferArrayType(targetType, initializer), initializer, duration: context.expressionDuration, location: token };
          pushValue(literal, 1); expectingOperand = false;
        } else {
          enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, token);
          stack.push({ kind: 'unary', token, operator: 'cast', targetType });
        }
        continue;
      }
      if (token.text === '(') {
        consume(); openMarker({ kind: 'group', token, valueStart: values.length }); continue;
      }
      if (token.text === '__builtin_va_arg' && peek(1).text === '(') {
        consume(); consume();
        const ap = context.expressions.parseExpression(1, new Set([',']));
        expect(',');
        const valueType = context.initializers.typeName();
        expect(')');
        pushValue({ kind: 'vaArg', ap, valueType, location: token }, 1);
        expectingOperand = false;
        continue;
      }
      if (token.kind === 'integer' || token.kind === 'floating' || token.kind === 'character') {
        consume(); pushValue({ kind: 'literal', value: parseLiteral(token.text, token), location: token }, 1); expectingOperand = false; continue;
      }
      if (token.kind === 'string') {
        const first = consume(); const bytes = context.initializers.decodeString(first.text, first);
        while (peek().kind === 'string') bytes.push(...context.initializers.decodeString(consume().text, first));
        bytes.push(0); pushValue({ kind: 'string', bytes, location: first }, 1); expectingOperand = false; continue;
      }
      if (token.kind === 'identifier' && !reserved.has(token.text)) {
        consume();
        const enumerator = context.lookupEnumerator(token.text);
        pushValue(enumerator === undefined
          ? { kind: 'variable', name: token.text, location: token, ...(context.lookupOrdinaryType(token.text) ? { type: context.lookupOrdinaryType(token.text)! } : {}) }
          : { kind: 'literal', value: { type: 'int', value: enumerator }, location: token }, 1);
        expectingOperand = false; continue;
      }
      if (unsupportedWords.has(token.text)) unsupported(token);
      failure('SYNTAX_ERROR', 'Expected a C expression.', token);
    }

    if (token.text === ')' || token.text === ']') {
      if (open < 0) {
        if (stops.has(token.text)) break;
        failure('SYNTAX_ERROR', `«${token.text}» has no matching opening delimiter.`, token);
      }
      const marker = stack[open];
      const wanted: ExpressionMarker['kind'] = token.text === ']' ? 'index' : marker.kind === 'call' ? 'call' : 'group';
      closeMarker(wanted, token); continue;
    }
    if (token.text === '[' || token.text === '(') {
      const base = values.pop();
      if (!base) failure('SYNTAX_ERROR', `Operator «${token.text}» has no base expression.`, token);
      consume();
      if (token.text === '[') openMarker({ kind: 'index', token, valueStart: values.length, base: base.expression, baseDepth: base.depth });
      else openMarker({ kind: 'call', token, valueStart: values.length, callee: base.expression, baseDepth: base.depth, args: [], maxDepth: 0 });
      expectingOperand = true; continue;
    }
    if (token.text === '.' || token.text === '->') {
      const base = values.pop()!; consume(); const name = identifier();
      const node: Expression = { kind: 'member', base: base.expression, name: name.text, arrow: token.text === '->', location: token };
      pushValue(node, base.depth + 1); continue;
    }
    if (token.text === '++' || token.text === '--') {
      const operand = values.pop()!; consume();
      pushValue({ kind: 'update', operand: operand.expression, operator: token.text, prefix: false, location: token }, operand.depth + 1); continue;
    }
    if (token.text === '?') {
      if (3 < minPrecedence && open < 0 && !pendingQuestion) break;
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.kind === 'group' || top.kind === 'call' || top.kind === 'index' || top.kind === 'question') break;
        if (operatorPrecedence(top) <= 3) break;
        reduce();
      }
      stack.push({ kind: 'question', token: consume(), operator: '?:' }); questionCounts[questionCounts.length - 1]++; expectingOperand = true; continue;
    }
    if (token.text === ':') {
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.kind === 'group' || top.kind === 'call' || top.kind === 'index') break;
        if (top.kind === 'question') break;
        reduce();
      }
      const question = stack[stack.length - 1];
      if (!question || question.kind !== 'question') {
        if (open < 0 && stops.has(':')) break;
        failure('SYNTAX_ERROR', '«:» has no matching «?».', token);
      }
      stack.pop(); questionCounts[questionCounts.length - 1]--;
      stack.push({ kind: 'conditional', token: question.token, operator: '?:' }); consume(); expectingOperand = true; continue;
    }
    if (token.text === ',' && open >= 0 && stack[open].kind === 'call' && !pendingQuestion) {
      while (stack.length > open + 1) reduce();
      const call = stack[open] as Extract<ExpressionMarker, { kind: 'call' }>;
      if (values.length !== call.valueStart + 1) failure('SYNTAX_ERROR', 'Invalid argument.', token);
      const argument = values.pop()!;
      call.args.push(argument.expression); call.maxDepth = Math.max(call.maxDepth, argument.depth);
      consume(); expectingOperand = true; continue;
    }
    const precedence = operators[token.text];
    if (precedence !== undefined) {
      if (open < 0 && precedence < minPrecedence && !pendingQuestion) break;
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.kind === 'group' || top.kind === 'call' || top.kind === 'index' || top.kind === 'question') break;
        const topPrecedence = operatorPrecedence(top);
        if (topPrecedence < precedence || topPrecedence === precedence && assignments.has(token.text)) break;
        reduce();
      }
      stack.push({ kind: 'binary', token: consume(), operator: token.text }); expectingOperand = true; continue;
    }
    if (unsupportedWords.has(token.text)) unsupported(token);
    if (open >= 0 && (token.text === ';' || token.text === '}')) {
      const marker = stack[open] as ExpressionMarker;
      failForOpenMarker(`Expected closing «${expectedClosingDelimiter(marker)}» before «${token.text}».`, marker, token);
    }
    failure('SYNTAX_ERROR', `Missing operator before «${token.text}».`, token);
  }
  if (expectingOperand) {
    if (markers.length) failForOpenMarker('Missing expression or operand.', stack[markers[markers.length - 1]] as ExpressionMarker, peek());
    failure('SYNTAX_ERROR', 'Missing expression or operand.', peek());
  }
  if (markers.length) failForOpenMarker('Missing closing parenthesis or subscript bracket.', stack[markers[markers.length - 1]] as ExpressionMarker, peek(), true);
  while (stack.length) reduce();
  if (values.length !== 1) failure('SYNTAX_ERROR', 'Invalid expression.', peek());
  return values[0].expression;
};
  return { parseExpression };
}
