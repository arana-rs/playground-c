import type { CType, Expression, Location, Statement, Token } from './internal.ts';
import { enforceLimit, failure } from './internal.ts';
import type { Block, ParserContext, StatementGrammar } from './parser-context-types.ts';
import { C_KEYWORDS } from '../syntax.ts';

const reserved = new Set(C_KEYWORDS);
const unsupportedWords = new Set(['_Atomic', '_Complex', '_Imaginary']);

export function createStatementGrammar(context: ParserContext): StatementGrammar {
  const { limits, recovery } = context;
  const peek = (offset = 0) => context.peek(offset);
  const consume = () => context.consume();
  const expect = (text: string) => context.expect(text);
  const identifier = () => context.identifier();
  const unsupported = (token: Token, message?: string): never => context.unsupported(token, message);
  const relatedFragment = (...args: Parameters<ParserContext['relatedFragment']>) => context.relatedFragment(...args);
  const declareOrdinary = (...args: Parameters<ParserContext['declareOrdinary']>) => context.declareOrdinary(...args);
  const pushTags = () => context.pushTags();
  const popTags = () => context.popTags();
  const isDeclarationStart = (token?: Token) => context.isDeclarationStart(token);
  const parseDeclaration = (...args: Parameters<ParserContext['declarations']['parseDeclaration']>) => context.declarations.parseDeclaration(...args);
  const parseStaticAssert = () => context.initializers.parseStaticAssert();
  const parseExpression = (...args: Parameters<ParserContext['expressions']['parseExpression']>) => context.expressions.parseExpression(...args);
  const { captureParserCheckpoint, finishParserCheckpoint, recordRecovery } = context.recoveryActions;

  const parseBody = (depth = 1, parameterNames: readonly { name: string; location: Location; type: CType }[] = []): Block => {
    enforceLimit('maxDepth', depth, limits.maxDepth, peek());
    const open = expect('{');
    const block: Block = { kind: 'block', statements: [], location: open, endLocation: open };
    pushTags();
    for (const parameter of parameterNames) if (parameter.name) declareOrdinary(parameter.name, parameter.location, parameter.type);
    const pending: { block: Block; depth: number }[] = [{ block, depth }];
    while (pending.length) {
      const current = pending[pending.length - 1];
      if (peek().text === '}') {
        current.block.endLocation = consume(); popTags(); pending.pop(); continue;
      }
      if (peek().kind === 'eof') {
        if (!recovery) failure('SYNTAX_ERROR', 'Missing closing } for block.', peek());
        if (recovery.diagnostics.length < recovery.maxDiagnostics) {
          const eof = peek();
          const related = pending.flatMap(({ block }) => {
            const location = relatedFragment(block.location, eof, 'Unclosed block starts here.');
            return location ? [location] : [];
          });
          recovery.diagnostics.push({
            code: 'SYNTAX_ERROR', message: 'Missing closing } for block.',
            file: eof.file, line: eof.line, column: eof.column,
            ...(related.length ? { related } : {}),
          });
        } else {
          recovery.truncated.value = true;
        }
        while (pending.length) { popTags(); pending.pop(); }
        block.endLocation = peek();
        break;
      }
      enforceLimit('maxDepth', current.depth + 1, limits.maxDepth, peek());
      if (peek().text === '{') {
        const nestedOpen = consume();
        const nested: Block = { kind: 'block', statements: [], location: nestedOpen, endLocation: nestedOpen };
        current.block.statements.push(nested); pushTags(); pending.push({ block: nested, depth: current.depth + 1 });
        continue;
      }
      const statementStart = context.cursor;
      const checkpoint = recovery ? captureParserCheckpoint() : undefined;
      try {
        current.block.statements.push(parseStatement(current.depth + 1, true));
      } catch (error) {
        if (!checkpoint || !recordRecovery(error, checkpoint, statementStart, 'statement')) throw error;
      } finally {
        if (checkpoint) finishParserCheckpoint(checkpoint);
      }
    }
    return block;
  };

  const parseStatement = (depth: number, allowDeclaration: boolean): Statement => {
    const token = peek(); enforceLimit('maxDepth', depth, limits.maxDepth, token);
    if (token.text === '{') return parseBody(depth);
    if (token.text === ';') { consume(); return { kind: 'empty', location: token }; }
    if (token.text === '_Static_assert') {
      const assertion = parseStaticAssert();
      return { kind: 'staticAssert', ...assertion };
    }
    if (isDeclarationStart(token)) {
      if (!allowDeclaration) failure('SYNTAX_ERROR', 'A declaration must be inside a block or in a for initializer.', token);
      return parseDeclaration(depth, true);
    }
    if (unsupportedWords.has(token.text)) unsupported(token);
    if (token.text === 'if') {
      consume(); expect('('); const condition = parseExpression(1, new Set([')'])); expect(')');
      const then = parseStatement(depth + 1, false);
      const node: Extract<Statement, { kind: 'if' }> = { kind: 'if', condition, scopeName: 'if(...)', then, location: token };
      if (peek().text === 'else') { consume(); node.else = parseStatement(depth + 1, false); }
      return node;
    }
    if (token.text === 'while' || token.text === 'switch') {
      consume(); expect('('); const value = parseExpression(1, new Set([')'])); expect(')');
      const scopeName = `${token.text}(...)`;
      const body = parseStatement(depth + 1, false);
      return token.text === 'while'
        ? { kind: 'while', condition: value, scopeName, body, location: token }
        : { kind: 'switch', value, scopeName, body, location: token };
    }
    if (token.text === 'do') {
      consume(); const body = parseStatement(depth + 1, false);
      expect('while'); expect('('); const condition = parseExpression(1, new Set([')'])); expect(')');
      expect(';');
      return { kind: 'do', condition, scopeName: 'do { ... } while (...)', body, location: token };
    }
    if (token.text === 'for') {
      consume(); pushTags(); expect('(');
      let initializer: Statement | undefined; let condition: Expression | undefined; let increment: Expression | undefined;
      if (peek().text === ';') consume();
      else if (isDeclarationStart()) initializer = parseForDeclaration(depth + 1);
      else { const at = peek(); initializer = { kind: 'expression', value: parseExpression(1, new Set([';'])), location: at }; expect(';'); }
      if (peek().text !== ';') condition = parseExpression(1, new Set([';'])); expect(';');
      if (peek().text !== ')') increment = parseExpression(1, new Set([')'])); expect(')');
      const body = parseStatement(depth + 1, false);
      popTags();
      return { kind: 'for', initializer, condition, increment, scopeName: 'for(...)', body, location: token };
    }
    if (token.text === 'return') {
      consume(); const value = peek().text === ';' ? undefined : parseExpression(1, new Set([';'])); expect(';');
      return { kind: 'return', value, location: token };
    }
    if (token.text === 'break' || token.text === 'continue') { consume(); expect(';'); return { kind: token.text, location: token }; }
    if (token.text === 'goto') { consume(); const target = identifier(); expect(';'); return { kind: 'goto', target: target.text, location: token }; }
    if (token.text === 'case' || token.text === 'default') {
      consume(); const value = token.text === 'case' ? parseExpression(2, new Set([':'])) : undefined; expect(':');
      const statement = parseStatement(depth + 1, true);
      return { kind: 'case', value, statement, location: token };
    }
    if (token.kind === 'identifier' && !reserved.has(token.text) && peek(1).text === ':') {
      consume(); consume(); const statement = parseStatement(depth + 1, true);
      return { kind: 'label', name: token.text, statement, location: token };
    }
    const value = parseExpression(1, new Set([';'])); expect(';');
    return { kind: 'expression', value, location: token };
  };

  function parseForDeclaration(depth: number): Statement {
    return parseDeclaration(depth, true);
  }

  return { parseBody, parseStatement, parseForDeclaration };
}
