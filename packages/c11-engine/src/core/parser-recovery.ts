import { EngineFailure } from './internal.ts';
import type { ParserCheckpoint, ParserContext, ParserRecoveryActions } from './parser-context-types.ts';

export function createParserRecoveryActions(context: ParserContext): ParserRecoveryActions {
  const captureParserCheckpoint = (): ParserCheckpoint => {
    const checkpoint: ParserCheckpoint = {
      typedefScopes: context.typedefScopes.slice(),
      tagScopes: context.tagScopes.slice(),
      enumTagScopes: context.enumTagScopes.slice(),
      ordinaryScopes: context.ordinaryScopes.slice(),
      ordinaryTypeScopes: context.ordinaryTypeScopes.slice(),
      mapMutations: [],
      aggregateSnapshots: new Map(),
      globalSnapshots: new Map(),
      aggregatesLength: context.aggregates.length,
      enumsLength: context.enums.length,
      staticAssertionsLength: context.staticAssertions.length,
      functionsLength: context.functions.length,
      globalsLength: context.globals.length,
      lastSpecifierDefinesTag: context.lastSpecifierDefinesTag,
      lastSpecifierConst: context.lastSpecifierConst,
      lastSpecifierVolatile: context.lastSpecifierVolatile,
      lastSpecifierRestrict: context.lastSpecifierRestrict,
      lastSpecifierQualifiers: { ...context.lastSpecifierQualifiers },
      nextAggregateId: context.nextAggregateId,
      nextEnumId: context.nextEnumId,
      expressionDuration: context.expressionDuration,
    };
    context.parserCheckpoints.push(checkpoint);
    return checkpoint;
  };

  const finishParserCheckpoint = (checkpoint: ParserCheckpoint): void => {
    const index = context.parserCheckpoints.lastIndexOf(checkpoint);
    if (index === context.parserCheckpoints.length - 1) context.parserCheckpoints.pop();
    else if (index >= 0) context.parserCheckpoints.splice(index, 1);
  };

  const restoreParserCheckpoint = (checkpoint: ParserCheckpoint): void => {
    finishParserCheckpoint(checkpoint);
    for (let index = checkpoint.mapMutations.length - 1; index >= 0; index--) {
      const mutation = checkpoint.mapMutations[index];
      if (mutation.existed) mutation.map.set(mutation.key, mutation.value);
      else mutation.map.delete(mutation.key);
    }
    for (const [value, state] of checkpoint.aggregateSnapshots) {
      Object.assign(value, state);
      value.members = state.members.map((member) => ({
        ...member,
        ...(member.bitField ? { bitField: { ...member.bitField } } : {}),
      }));
    }
    for (const [value, state] of checkpoint.globalSnapshots) Object.assign(value, state);
    context.aggregates.length = checkpoint.aggregatesLength;
    context.enums.length = checkpoint.enumsLength;
    context.staticAssertions.length = checkpoint.staticAssertionsLength;
    context.functions.length = checkpoint.functionsLength;
    context.globals.length = checkpoint.globalsLength;
    context.typedefScopes.splice(0, context.typedefScopes.length, ...checkpoint.typedefScopes);
    context.tagScopes.splice(0, context.tagScopes.length, ...checkpoint.tagScopes);
    context.enumTagScopes.splice(0, context.enumTagScopes.length, ...checkpoint.enumTagScopes);
    context.ordinaryScopes.splice(0, context.ordinaryScopes.length, ...checkpoint.ordinaryScopes);
    context.ordinaryTypeScopes.splice(0, context.ordinaryTypeScopes.length, ...checkpoint.ordinaryTypeScopes);
    context.lastSpecifierDefinesTag = checkpoint.lastSpecifierDefinesTag;
    context.lastSpecifierConst = checkpoint.lastSpecifierConst;
    context.lastSpecifierVolatile = checkpoint.lastSpecifierVolatile;
    context.lastSpecifierRestrict = checkpoint.lastSpecifierRestrict;
    context.lastSpecifierQualifiers = { ...checkpoint.lastSpecifierQualifiers };
    context.nextAggregateId = checkpoint.nextAggregateId;
    context.nextEnumId = checkpoint.nextEnumId;
    context.expressionDuration = checkpoint.expressionDuration;
  };

  const synchronize = (start: number, boundary: 'statement' | 'external'): number => {
    const eof = context.tokens.length - 1;
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    const startLine = context.tokens[start]?.line;
    for (let index = start; index < eof; index++) {
      const text = context.tokens[index].text;
      const atBoundary = parentheses === 0 && brackets === 0 && braces === 0 && index > start && context.tokens[index].line > (startLine ?? context.tokens[index].line) &&
        (context.isDeclarationStart(context.tokens[index]) || (boundary === 'external'
          ? text === '_Static_assert'
          : ['{', 'if', 'switch', 'while', 'do', 'for', 'return', 'break', 'continue', 'goto', 'case', 'default', '_Static_assert'].includes(text)));
      if (atBoundary) return index;
      if (text === '(') parentheses++;
      else if (text === ')' && parentheses) parentheses--;
      else if (text === '[') brackets++;
      else if (text === ']' && brackets) brackets--;
      else if (text === '{') braces++;
      else if (text === '}') {
        if (!braces) return boundary === 'statement' ? index : index + 1;
        braces--;
      } else if (text === ';' && !parentheses && !brackets && !braces) {
        return index + 1;
      }
    }
    return eof;
  };

  const recordRecovery = (error: unknown, checkpoint: ParserCheckpoint, start: number, boundary: 'statement' | 'external'): boolean => {
    const recovery = context.recovery;
    if (!recovery || !(error instanceof EngineFailure) || error.resource !== undefined || error.diagnostic.code === 'ENGINE_INTERNAL_ERROR') return false;
    restoreParserCheckpoint(checkpoint);
    if (recovery.diagnostics.length >= recovery.maxDiagnostics) {
      recovery.truncated.value = true;
      context.cursor = context.tokens.length - 1;
      return true;
    }
    recovery.diagnostics.push({
      ...error.diagnostic,
      ...(error.location.endLine !== undefined && error.location.endColumn !== undefined
        ? { endLine: error.location.endLine, endColumn: error.location.endColumn }
        : {}),
    });
    let next = synchronize(start, boundary);
    const startText = context.tokens[start]?.text;
    if (boundary === 'statement' && (startText === 'if' && context.tokens[next]?.text === 'else' || startText === 'do' && context.tokens[next]?.text === 'while')) {
      next = synchronize(next, 'statement');
    }
    context.cursor = next > start ? next : Math.min(start + 1, context.tokens.length - 1);
    return true;
  };

  return { captureParserCheckpoint, finishParserCheckpoint, restoreParserCheckpoint, recordRecovery };
}
