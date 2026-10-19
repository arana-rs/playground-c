import type { PrepareLimits } from './types.ts';
import type { ParsedProgram, Token } from './internal.ts';
import type { ParserRecoveryOptions } from './parser-context-types.ts';
import { ParserRuntime } from './parser-runtime.ts';
import { parseTranslationUnit } from './parser-translation.ts';

export type { ParserRecoveryOptions } from './parser-context-types.ts';
export { analyze } from './parser-analysis.ts';

export function parse(
  tokens: Token[],
  limits: PrepareLimits,
  translationUnit = tokens[0]?.file ?? 'main.c',
  recovery?: ParserRecoveryOptions,
): ParsedProgram {
  return parseTranslationUnit(new ParserRuntime(tokens, limits, translationUnit, recovery));
}
