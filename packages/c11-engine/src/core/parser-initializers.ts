import type { CType, Initializer, InitializerDesignator, StaticAssertion, Token, Location } from './internal.ts';
import { encodeUtf8Bytes } from './numeric.ts';
import { failure } from './internal.ts';
import { alignOfType, isComplete, isFunction, isInteger } from './type-system.ts';
import { constantExpression, requireIntegerConstantExpression } from './parser-constant-expressions.ts';
import type { InitializerGrammar, ParserContext } from './parser-context-types.ts';

export function createInitializerGrammar(context: ParserContext): InitializerGrammar {
  const { aggregates } = context;
  const peek = (offset = 0): Token => context.peek(offset);
  const consume = (): Token => context.consume();
  const expect = (text: string): Token => context.expect(text);
  const identifier = (): Token => context.identifier();
  const unsupported = (token: Token, message?: string): never => context.unsupported(token, message);
  const relatedFragment = (opening: Location, boundary: Location, message: string) => context.relatedFragment(opening, boundary, message);
  const syntaxFailureWithRelated = (message: string, location: Location, related?: import('./types.ts').RelatedDiagnosticLocation): never => context.syntaxFailureWithRelated(message, location, related);

const decodeString = (text: string, at: Location): number[] => {
  const utf8 = text.startsWith('u8"');
  const prefixLength = utf8 ? 2 : 0;
  if ((!utf8 && !text.startsWith('"')) || !text.endsWith('"')) failure('UNTERMINATED_STRING', 'Unterminated string literal.', at);
  const result: number[] = [];
  const body = text.slice(prefixLength + 1, -1);
  for (let index = 0; index < body.length; index++) {
    let code = 0;
    const char = body[index];
    if (char !== '\\') {
      const codePoint = body.codePointAt(index)!;
      if (utf8 && codePoint >= 0xd800 && codePoint <= 0xdfff) {
        failure('INVALID_STRING_LITERAL', 'A UTF-8 string literal contains an invalid Unicode code point.', at);
      }
      if (utf8 && codePoint > 127) {
        result.push(...encodeUtf8Bytes(codePoint));
        if (codePoint > 0xffff) index++;
        continue;
      }
      if (codePoint > 127) unsupported({ ...at, text: char, kind: 'string' }, 'P3 supports ASCII string literals; Unicode support is pending.');
      code = codePoint;
    } else {
      const next = body[++index];
      if (next === undefined) failure('SYNTAX_ERROR', 'Incomplete escape in string literal.', at);
      const simple: Record<string, number> = { "'": 39, '"': 34, '?': 63, '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
      if (Object.hasOwn(simple, next)) code = simple[next];
      else if (/[0-7]/.test(next)) {
        let digits = next;
        while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) digits += body[++index];
        code = Number.parseInt(digits, 8);
      } else if (next === 'x') {
        let digits = '';
        while (/[0-9a-fA-F]/.test(body[index + 1] ?? '')) digits += body[++index];
        if (!digits) failure('SYNTAX_ERROR', 'A hexadecimal string escape requires at least one digit.', at);
        code = Number.parseInt(digits, 16);
      } else if (next === 'u' || next === 'U') unsupported({ ...at, text: `\\${next}`, kind: 'string' }, 'P3 does not implement Unicode escapes.');
  else failure('SYNTAX_ERROR', `Unknown string escape: \\${next}.`, at);
    }
    result.push(code);
  }
  return result;
};

const parseIntegerConstant = (description: string): bigint => {
  const at = peek();
  const expression = context.expressions.parseExpression(1, new Set([']', ',', ';', '}']));
  requireIntegerConstantExpression(expression, description, aggregates, context.expressions.resolveGenericSelection);
  const value = constantExpression(expression, aggregates, context.expressions.resolveGenericSelection);
  if (!isInteger(value.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', `${description} must be an integer constant expression.`, at);
  return value.value;
};


const parseInitializer = (): Initializer => {
  const at = peek();
  if (peek().text !== '{') {
    const value = context.expressions.parseExpression(2, new Set([',', ';', '}']));
    return { kind: 'expression', value, location: at };
  }
  const openBrace = consume();
  const list: { designators: InitializerDesignator[]; initializer: Initializer; location: Location }[] = [];
  while (peek().text !== '}') {
    if (peek().kind === 'eof') {
      const message = 'Missing closing } for initializer.';
      syntaxFailureWithRelated(message, peek(), relatedFragment(openBrace, peek(), 'Unclosed initializer starts here.'));
    }
    const itemAt = peek();
    const designators: InitializerDesignator[] = [];
    while (peek().text === '.' || peek().text === '[') {
      if (peek().text === '.') {
        const designator = consume(); const name = identifier();
        designators.push({ kind: 'member', name: name.text, location: designator });
      } else {
        const designator = consume();
        const index = parseIntegerConstant('The array designator');
        if (index < 0n) failure('INVALID_DESIGNATOR', 'A designator index cannot be negative.', designator);
        expect(']'); designators.push({ kind: 'index', index, location: designator });
      }
    }
    if (designators.length) expect('=');
    const initializer = parseInitializer();
    list.push({ designators, initializer, location: itemAt });
    if (peek().text !== ',') break;
    consume();
    if (peek().text === '}') break;
  }
  if (!list.length) failure('SYNTAX_ERROR', 'A braced initializer requires at least one element in C11.', at);
  expect('}');
  return { kind: 'list', items: list, location: at };
};

const typeName = (): CType => {
  const base = context.typeSpecifiers.parseTypeSpecifier();
  const qualifiers = { ...context.lastSpecifierQualifiers };
  const declarator = context.declarators.parseDeclarator(true);
  return context.declarators.declaredType(declarator, base, qualifiers);
};

function parseAlignmentSpecifier(): number {
  const at = expect('_Alignas');
  expect('(');
  let alignment: bigint;
  if (context.startsType()) {
    const type = typeName();
    if (!isComplete(type, aggregates) || isFunction(type)) failure('INCOMPLETE_TYPE', '_Alignas requires a complete object type.', at);
    alignment = BigInt(alignOfType(type, aggregates, at));
  } else {
    const expression = context.expressions.parseExpression(1, new Set([')']));
    requireIntegerConstantExpression(expression, '_Alignas', aggregates, context.expressions.resolveGenericSelection);
    const value = constantExpression(expression, aggregates, context.expressions.resolveGenericSelection);
    if (!isInteger(value.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', '_Alignas requires an integer constant expression or a type name.', at);
    alignment = value.value;
  }
  expect(')');
  if (alignment < 0n || alignment > 65536n || alignment !== 0n && (alignment & (alignment - 1n)) !== 0n) {
    failure('TYPE_ERROR', 'The profile supports _Alignas(0) or power-of-two alignments from 1 to 65536.', at);
  }
  return Number(alignment);
}

const parseStaticAssert = (): StaticAssertion => {
  const at = expect('_Static_assert');
  expect('(');
  const condition = context.expressions.parseExpression(1, new Set([',']));
  requireIntegerConstantExpression(condition, '_Static_assert', aggregates, context.expressions.resolveGenericSelection);
  expect(',');
  if (peek().kind !== 'string') failure('SYNTAX_ERROR', '_Static_assert requires a string literal message.', peek());
  const first = consume();
  const bytes = decodeString(first.text, first);
  while (peek().kind === 'string') bytes.push(...decodeString(consume().text, first));
  expect(')');
  expect(';');
  return { condition, message: String.fromCharCode(...bytes), location: at };
};
  return { decodeString, parseIntegerConstant, parseInitializer, typeName, parseAlignmentSpecifier, parseStaticAssert };
}
