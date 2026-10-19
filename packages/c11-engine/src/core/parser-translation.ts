import type { ParsedProgram } from './internal.ts';
import { failure } from './internal.ts';
import { arrayOf, arrayType, isComplete } from './type-system.ts';
import type { ParserContext } from './parser-context-types.ts';
import { parseExternalDeclaration } from './parser-external-declarations.ts';

export function parseTranslationUnit(context: ParserContext): ParsedProgram {
  const { functions, aggregates, enums, globals, staticAssertions, translationUnit, recovery } = context;
  const peek = (offset = 0) => context.peek(offset);
  const parseStaticAssert = () => context.initializers.parseStaticAssert();
  const { captureParserCheckpoint, finishParserCheckpoint, recordRecovery } = context.recoveryActions;

  while (peek().kind !== 'eof') {
    const externalStart = context.cursor;
    const checkpoint = recovery ? captureParserCheckpoint() : undefined;
    try {
    if (peek().text === '_Static_assert') { staticAssertions.push(parseStaticAssert()); continue; }
    else parseExternalDeclaration(context);
    } catch (error) {
      if (!checkpoint || !recordRecovery(error, checkpoint, externalStart, 'external')) throw error;
    } finally {
      if (checkpoint) finishParserCheckpoint(checkpoint);
    }
  }
  if (context.cursor === 0) failure('SYNTAX_ERROR', 'The file contains no external declarations.', peek());
  for (const global of globals) {
    const array = arrayType(global.type);
    if (global.tentative && array?.length === null && isComplete(array.element, aggregates)) global.type = arrayOf(array.element, 1);
  }
  context.commitParserIds();
  return { functions, aggregates, enums, globals, staticAssertions, translationUnit };
}
