import type { PrepareLimits } from './types.ts';
import type { ParsedProgram, Token } from './internal.ts';
import { ParserState } from './parser-state.ts';
import type {
  DeclaratorGrammar, ExpressionGrammar, InitializerGrammar, ParserContext, ParserRecoveryOptions,
  ParserRecoveryActions, StatementGrammar, TypeSpecifierGrammar, DeclarationGrammar,
} from './parser-context-types.ts';
import { createParserRecoveryActions } from './parser-recovery.ts';
import { createAggregateSpecifierGrammar } from './parser-aggregate-specifiers.ts';
import { createTypeSpecifierGrammar } from './parser-type-specifiers.ts';
import { createDeclaratorGrammar } from './parser-declarators.ts';
import { createInitializerGrammar } from './parser-initializers.ts';
import { createExpressionParser } from './parser-expressions.ts';
import { createExpressionInference } from './parser-expression-inference.ts';
import { createDeclarationGrammar } from './parser-declarations.ts';
import { createStatementGrammar } from './parser-statements.ts';

export class ParserRuntime extends ParserState implements ParserContext {
  readonly recoveryActions: ParserRecoveryActions;
  typeSpecifiers!: TypeSpecifierGrammar;
  declarators!: DeclaratorGrammar;
  initializers!: InitializerGrammar;
  expressions!: ExpressionGrammar;
  declarations!: DeclarationGrammar;
  statements!: StatementGrammar;

  constructor(tokens: Token[], limits: PrepareLimits, translationUnit: string, recovery?: ParserRecoveryOptions) {
    super(tokens, limits, translationUnit, recovery);
    this.recoveryActions = createParserRecoveryActions(this);
    this.expressions = {
      ...createExpressionParser(this),
      ...createExpressionInference(this),
    };
    this.typeSpecifiers = {
      ...createAggregateSpecifierGrammar(this),
      ...createTypeSpecifierGrammar(this),
    };
    this.declarators = createDeclaratorGrammar(this);
    this.initializers = createInitializerGrammar(this);
    this.declarations = createDeclarationGrammar(this);
    this.statements = createStatementGrammar(this);
  }
}

export function parsedProgram(context: ParserContext): ParsedProgram {
  return {
    functions: context.functions,
    aggregates: context.aggregates,
    enums: context.enums,
    globals: context.globals,
    staticAssertions: context.staticAssertions,
    translationUnit: context.translationUnit,
  };
}
