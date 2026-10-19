import { enforceLimit, type Location } from './internal.ts';
import { MAX_INTERNAL_DEPTH } from './preprocessor-constants.ts';
import { preprocessError } from './preprocessor-errors.ts';
import { parseLiteral } from './numeric.ts';
import type { PPExpression, PPToken, PPValue } from './preprocessor-types.ts';
import type { PrepareLimits } from './types.ts';

const ppPrecedence: Readonly<Record<string, number>> = Object.freeze({
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
});
const ppSignedMin = -(1n << 63n);
const ppSignedMax = (1n << 63n) - 1n;

class PreprocessorExpressionParser {
  private readonly tokens: readonly PPToken[];
  private readonly limits: PrepareLimits;
  private cursor = 0;

  constructor(tokens: readonly PPToken[], limits: PrepareLimits) { this.tokens = tokens; this.limits = limits; }

  private peek(): PPToken | undefined { return this.tokens[this.cursor]; }
  private take(text?: string): PPToken | undefined {
    const token = this.peek();
    if (!token || (text !== undefined && token.text !== text)) return undefined;
    this.cursor++;
    return token;
  }
  private expect(text: string): PPToken {
    const token = this.take(text);
    if (!token) preprocessError(`Expected «${text}» in the #if expression.`, this.peek()?.at ?? this.tokens.at(-1)?.at ?? { file: 'main.c', line: 1, column: 1 });
    return token;
  }
  private checkDepth(depth: number, at: Location): void {
    if (depth > MAX_INTERNAL_DEPTH) preprocessError('The #if expression exceeds the supported internal depth.', at, 'LIMIT_EXCEEDED');
    enforceLimit('maxDepth', depth, this.limits.maxDepth, at);
  }

  parse(): PPExpression {
    if (!this.tokens.length) preprocessError('Empty #if expression.', { file: 'main.c', line: 1, column: 1 });
    const expression = this.parseConditional(0);
    if (this.peek()) preprocessError(`Invalid token «${this.peek()!.text}» in the #if expression.`, this.peek()!.at);
    return expression;
  }

  private parseConditional(depth: number): PPExpression {
    const at = this.peek()?.at ?? this.tokens.at(-1)!.at;
    this.checkDepth(depth + 1, at);
    const condition = this.parseBinary(1, depth + 1);
    if (!this.take('?')) return condition;
    const then = this.parseConditional(depth + 1);
    this.expect(':');
    const otherwise = this.parseConditional(depth + 1);
    return { kind: 'conditional', condition, then, otherwise, at };
  }

  private parseBinary(minimum: number, depth: number): PPExpression {
    const at = this.peek()?.at ?? this.tokens.at(-1)!.at;
    this.checkDepth(depth + 1, at);
    let left = this.parseUnary(depth + 1);
    for (;;) {
      const operator = this.peek()?.text;
      const precedence = operator === undefined ? undefined : ppPrecedence[operator];
      if (precedence === undefined || precedence < minimum) break;
      const operatorToken = this.take()!;
      const right = this.parseBinary(precedence + 1, depth + 1);
      left = { kind: 'binary', operator: operatorToken.text, left, right, at: operatorToken.at };
    }
    return left;
  }

  private parseUnary(depth: number): PPExpression {
    const token = this.peek();
    if (token && ['+', '-', '!', '~'].includes(token.text)) {
      this.cursor++;
      this.checkDepth(depth + 1, token.at);
      return { kind: 'unary', operator: token.text, operand: this.parseUnary(depth + 1), at: token.at };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): PPExpression {
    const token = this.take();
    if (!token) preprocessError('Missing operand in the #if expression.', this.tokens.at(-1)?.at ?? { file: 'main.c', line: 1, column: 1 });
    if (token.text === '(') {
      this.checkDepth(depth + 1, token.at);
      const nested = this.parseConditional(depth + 1);
      this.expect(')');
      return nested;
    }
    if (token.kind !== 'number' && token.kind !== 'character') preprocessError(`Expected an integer constant in #if; found «${token.text}».`, token.at);
    const literal = parseLiteral(token.text, token.at);
    if (typeof literal.value !== 'bigint') preprocessError('The #if expression only accepts integer constants.', token.at);
    return { kind: 'value', value: { value: literal.value, unsigned: String(literal.type).startsWith('unsigned') } };
  }
}

function ppTruthy(value: PPValue): boolean { return value.value !== 0n; }
function ppExpressionUnsigned(expression: PPExpression): boolean {
  if (expression.kind === 'value') return expression.value.unsigned;
  if (expression.kind === 'unary') return expression.operator === '!' ? false : ppExpressionUnsigned(expression.operand);
  if (expression.kind === 'conditional') return ppExpressionUnsigned(expression.then) || ppExpressionUnsigned(expression.otherwise);
  if (['&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(expression.operator)) return false;
  if (expression.operator === '<<' || expression.operator === '>>') return ppExpressionUnsigned(expression.left);
  return ppExpressionUnsigned(expression.left) || ppExpressionUnsigned(expression.right);
}
function ppAsUnsigned(value: PPValue): bigint { return BigInt.asUintN(64, value.value); }
function ppUsual(left: PPValue, right: PPValue): { left: bigint; right: bigint; unsigned: boolean } {
  const unsigned = left.unsigned || right.unsigned;
  return unsigned
    ? { left: ppAsUnsigned(left), right: ppAsUnsigned(right), unsigned }
    : { left: left.value, right: right.value, unsigned };
}
function ppResult(value: bigint, unsigned: boolean, at: Location): PPValue {
  if (unsigned) return { value: BigInt.asUintN(64, value), unsigned: true };
  if (value < ppSignedMin || value > ppSignedMax) preprocessError('Signed overflow in a #if constant expression.', at, 'INVALID_PREPROCESSOR_EXPRESSION');
  return { value, unsigned: false };
}

export function evaluatePreprocessorExpression(tokens: readonly PPToken[], limits: PrepareLimits): boolean {
  const tree = new PreprocessorExpressionParser(tokens, limits).parse();
  const evaluate = (expression: PPExpression, active = true): PPValue => {
    if (!active) return { value: 0n, unsigned: false };
    if (expression.kind === 'value') return expression.value;
    if (expression.kind === 'unary') {
      const operand = evaluate(expression.operand);
      if (expression.operator === '!') return { value: ppTruthy(operand) ? 0n : 1n, unsigned: false };
      if (expression.operator === '+') return operand;
      if (expression.operator === '-') return ppResult(-operand.value, operand.unsigned, expression.at);
      if (expression.operator === '~') return ppResult(~operand.value, operand.unsigned, expression.at);
      return preprocessError(`Unsupported unary operator in #if: ${expression.operator}.`, expression.at);
    }
    if (expression.kind === 'conditional') {
      const condition = evaluate(expression.condition);
      const selected = ppTruthy(condition) ? evaluate(expression.then) : evaluate(expression.otherwise);
      return ppResult(selected.value, ppExpressionUnsigned(expression), expression.at);
    }
    const left = evaluate(expression.left);
    if (expression.operator === '&&') return ppTruthy(left) ? { value: ppTruthy(evaluate(expression.right)) ? 1n : 0n, unsigned: false } : { value: 0n, unsigned: false };
    if (expression.operator === '||') return ppTruthy(left) ? { value: 1n, unsigned: false } : { value: ppTruthy(evaluate(expression.right)) ? 1n : 0n, unsigned: false };
    const right = evaluate(expression.right);
    const operands = ppUsual(left, right);
    const a = operands.left, b = operands.right, unsigned = operands.unsigned;
    switch (expression.operator) {
      case '+': return ppResult(a + b, unsigned, expression.at);
      case '-': return ppResult(a - b, unsigned, expression.at);
      case '*': return ppResult(a * b, unsigned, expression.at);
      case '/':
        if (b === 0n) preprocessError('Division by zero in a #if expression.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        if (!unsigned && a === ppSignedMin && b === -1n) preprocessError('Division overflow in a #if expression.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        return ppResult(a / b, unsigned, expression.at);
      case '%':
        if (b === 0n) preprocessError('Remainder by zero in a #if expression.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        return ppResult(a % b, unsigned, expression.at);
      case '<<': case '>>': {
        if (right.value < 0n || right.value >= 64n) preprocessError('Shift count out of range in a #if expression.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        const shift = Number(right.value);
        if (expression.operator === '>>') return ppResult((unsigned ? BigInt.asUintN(64, a) : a) >> BigInt(shift), unsigned, expression.at);
        if (!unsigned && (a < 0n || (a << BigInt(shift)) > ppSignedMax)) preprocessError('Signed shift out of range in a #if expression.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        return ppResult(a << BigInt(shift), unsigned, expression.at);
      }
      case '&': return ppResult(a & b, unsigned, expression.at);
      case '^': return ppResult(a ^ b, unsigned, expression.at);
      case '|': return ppResult(a | b, unsigned, expression.at);
      case '==': return { value: a === b ? 1n : 0n, unsigned: false };
      case '!=': return { value: a !== b ? 1n : 0n, unsigned: false };
      case '<': return { value: a < b ? 1n : 0n, unsigned: false };
      case '<=': return { value: a <= b ? 1n : 0n, unsigned: false };
      case '>': return { value: a > b ? 1n : 0n, unsigned: false };
      case '>=': return { value: a >= b ? 1n : 0n, unsigned: false };
      default: return preprocessError(`Unsupported binary operator in #if: ${expression.operator}.`, expression.at);
    }
  };
  return ppTruthy(evaluate(tree));
}
