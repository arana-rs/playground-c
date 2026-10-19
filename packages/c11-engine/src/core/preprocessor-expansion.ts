import { EngineFailure, enforceLimit } from './internal.ts';
import type { Location } from './internal.ts';
import { MAX_INTERNAL_DEPTH } from './preprocessor-constants.ts';
import { evaluatePreprocessorExpression } from './preprocessor-expression.ts';
import { preprocessError } from './preprocessor-errors.ts';
import {
  cloneAt, decodeCQuotedString, mergedHideSet, parseMacroArguments, pastedToken, quoteC,
  rejectVaArgsOutsideVariadicReplacement, sameMacro, stringifyArgument, stringifyPragmaText,
  syntheticToken,
} from './preprocessor-macros.ts';
import type { Macro, PPContext, PPToken } from './preprocessor-types.ts';

export class MacroExpander {
  readonly context: PPContext;

  constructor(context: PPContext) { this.context = context; }

  countExpansionWork(amount: number, at: Location): void {
    this.context.metrics.preprocessSteps += amount;
    enforceLimit('maxPreprocessSteps', this.context.metrics.preprocessSteps, this.context.limits.maxPreprocessSteps, at);
  }

  checkDepth(depth: number, at: Location): void {
    if (depth > MAX_INTERNAL_DEPTH) throw new EngineFailure('LIMIT_EXCEEDED', `Preprocessor internal depth limit exceeded (${MAX_INTERNAL_DEPTH}).`, at, 'maxDepth', MAX_INTERNAL_DEPTH);
    enforceLimit('maxDepth', depth, this.context.limits.maxDepth, at);
  }

  expand(tokens: readonly PPToken[], depth = 0): PPToken[] {
    const output: PPToken[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      this.countExpansionWork(1, token.at);
      if (token.kind !== 'identifier' || token.hideSet?.has(token.text)) { output.push(token); index++; continue; }
      const macro = this.context.macros.get(token.text);
      if (!macro) { output.push(token); index++; continue; }
      this.checkDepth(depth + 1, token.at);
      if (macro.name === '__LINE__') {
        output.push(syntheticToken('number', String(token.at.line), token.at, token.leadingSpace, token.hideSet));
        index++;
        continue;
      }
      if (macro.name === '__FILE__') {
        output.push(syntheticToken('string', quoteC(token.at.file), token.at, token.leadingSpace, token.hideSet));
        index++;
        continue;
      }
      if (macro.parameters === undefined) {
        const hideSet = mergedHideSet(token.hideSet, new Set([macro.name]));
        const replacement = macro.replacement.map((part, partIndex) => cloneAt(part, token.at, { hideSet, leadingSpace: partIndex === 0 ? token.leadingSpace : part.leadingSpace }));
        this.countExpansionWork(replacement.length + 1, token.at);
        output.push(...this.expand([...replacement, ...tokens.slice(index + 1)], depth + 1));
        return output;
      }
      if (tokens[index + 1]?.text !== '(') { output.push(token); index++; continue; }
      const invocation = parseMacroArguments(tokens, index + 1, token.at, macro.parameters);
      const fixedCount = macro.parameters.length;
      const rawArguments = invocation.arguments;
      if ((!macro.variadic && rawArguments.length !== fixedCount) || (macro.variadic && rawArguments.length < fixedCount)) {
        preprocessError(`Macro «${macro.name}» received ${rawArguments.length} arguments; expected ${macro.variadic ? `at least ${fixedCount}` : fixedCount}.`, token.at);
      }
      const argumentMap = new Map<string, PPToken[]>();
      for (let argument = 0; argument < fixedCount; argument++) argumentMap.set(macro.parameters[argument], rawArguments[argument] ?? []);
      if (macro.variadic) {
        const variadic: PPToken[] = [];
        for (let argument = fixedCount; argument < rawArguments.length; argument++) {
          if (argument > fixedCount) variadic.push(invocation.separators[argument - 1] ?? syntheticToken('symbol', ',', token.at));
          variadic.push(...rawArguments[argument]);
        }
        argumentMap.set('__VA_ARGS__', variadic);
      }
      const expandedArguments = new Map<string, PPToken[]>();
      for (const [name, argument] of argumentMap) {
        const usedWithoutStringizeOrPaste = macro.replacement.some((part, partIndex) => part.kind === 'identifier' && part.text === name
          && macro.replacement[partIndex - 1]?.text !== '#' && macro.replacement[partIndex - 1]?.text !== '##' && macro.replacement[partIndex + 1]?.text !== '##');
        if (usedWithoutStringizeOrPaste) expandedArguments.set(name, this.expand(argument, depth + 1));
      }
      const hideSet = mergedHideSet(token.hideSet, new Set([macro.name]));
      const replacementItems: (PPToken[] | 'paste')[] = [];
      for (let partIndex = 0; partIndex < macro.replacement.length; partIndex++) {
        const part = macro.replacement[partIndex];
        if (part.text === '#' && macro.replacement[partIndex + 1]?.kind === 'identifier') {
          const parameter = macro.replacement[partIndex + 1].text;
          const raw = argumentMap.get(parameter);
          if (raw) {
            replacementItems.push([stringifyArgument(raw, token.at, partIndex === 0 ? token.leadingSpace : part.leadingSpace, hideSet)]);
            partIndex++;
            continue;
          }
        }
        if (part.text === '##') { replacementItems.push('paste'); continue; }
        if (part.kind === 'identifier' && argumentMap.has(part.text)) {
          const adjacentPaste = macro.replacement[partIndex - 1]?.text === '##' || macro.replacement[partIndex + 1]?.text === '##';
          const selected = adjacentPaste ? argumentMap.get(part.text)! : expandedArguments.get(part.text)!;
          replacementItems.push(selected.map((value, selectedIndex) => cloneAt(value, token.at, { hideSet: mergedHideSet(value.hideSet, hideSet), leadingSpace: partIndex === 0 && selectedIndex === 0 ? token.leadingSpace : value.leadingSpace })));
        } else replacementItems.push([cloneAt(part, token.at, { hideSet, leadingSpace: partIndex === 0 ? token.leadingSpace : part.leadingSpace })]);
      }
      for (let itemIndex = 0; itemIndex < replacementItems.length;) {
        if (replacementItems[itemIndex] !== 'paste') { itemIndex++; continue; }
        if (itemIndex === 0 || itemIndex === replacementItems.length - 1) preprocessError(`Macro «${macro.name}» has ## at an edge of its replacement list.`, token.at);
        const left = replacementItems[itemIndex - 1] as PPToken[];
        const right = replacementItems[itemIndex + 1] as PPToken[];
        let combined: PPToken[];
        if (!left.length) combined = right;
        else if (!right.length) combined = left;
        else combined = [...left.slice(0, -1), pastedToken(left.at(-1)!, right[0], token.at, hideSet), ...right.slice(1)];
        replacementItems.splice(itemIndex - 1, 3, combined);
        itemIndex = Math.max(0, itemIndex - 1);
      }
      const replacement = replacementItems.flatMap((item) => item === 'paste' ? [] : item);
      this.countExpansionWork(replacement.length + rawArguments.reduce((total, argument) => total + argument.length, 0) + 1, token.at);
      output.push(...this.expand([...replacement, ...tokens.slice(invocation.end + 1)], depth + 1));
      return output;
    }
    return output;
  }

  private stringifyCondition(tokens: readonly PPToken[]): PPToken[] {
    const protectedTokens: PPToken[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== 'identifier' || token.text !== 'defined') { protectedTokens.push(token); continue; }
      let name: PPToken | undefined;
      let end = index;
      if (tokens[index + 1]?.text === '(') {
        name = tokens[index + 2];
        if (!name || name.kind !== 'identifier' || tokens[index + 3]?.text !== ')') preprocessError('The defined operator requires an identifier, optionally enclosed in parentheses.', token.at);
        end = index + 3;
      } else {
        name = tokens[index + 1];
        if (!name || name.kind !== 'identifier') preprocessError('The defined operator requires an identifier.', token.at);
        end = index + 1;
      }
      protectedTokens.push(syntheticToken('number', this.context.macros.has(name.text) ? '1' : '0', token.at, token.leadingSpace));
      index = end;
    }
    const expanded = this.expand(protectedTokens);
    return expanded.map((token) => token.kind === 'identifier' ? cloneAt(token, token.at, { kind: 'number', text: '0', spelling: '0' }) : token);
  }

  evaluateIf(tokens: readonly PPToken[], at: Location): boolean {
    if (!tokens.length) preprocessError('The #if directive requires an expression.', at);
    rejectVaArgsOutsideVariadicReplacement(tokens);
    const expanded = this.stringifyCondition(tokens);
    return evaluatePreprocessorExpression(expanded, this.context.limits);
  }

  parsePragma(text: string, at: Location, currentFile: string): void {
    const words = stringifyPragmaText(text);
    if (words.length === 1 && words[0] === 'once') { this.context.onceFiles.add(currentFile); return; }
    if (words.length === 3 && words[0] === 'STDC' && ['FP_CONTRACT', 'FENV_ACCESS', 'CX_LIMITED_RANGE'].includes(words[1]) && ['ON', 'OFF', 'DEFAULT'].includes(words[2])) return;
    if (words[0] !== 'STDC') return;
    preprocessError(`Pragma no implementado: «${text.trim()}».`, at, 'UNSUPPORTED_FEATURE');
  }

  applyPragmaOperator(tokens: readonly PPToken[], currentFile: string): PPToken[] {
    const result: PPToken[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== 'identifier' || token.text !== '_Pragma') { result.push(token); continue; }
      if (tokens[index + 1]?.text !== '(' || tokens[index + 2]?.kind !== 'string' || tokens[index + 3]?.text !== ')') preprocessError('_Pragma requires a string in parentheses.', token.at);
      this.parsePragma(decodeCQuotedString(tokens[index + 2]), token.at, currentFile);
      index += 3;
    }
    return result;
  }

  defineMacro(tokens: readonly PPToken[], at: Location): void {
    const nameToken = tokens[0];
    if (!nameToken || nameToken.kind !== 'identifier') preprocessError('#define requires a macro name.', at);
    if (nameToken.text === '__VA_ARGS__') rejectVaArgsOutsideVariadicReplacement([nameToken]);
    const name = nameToken.text;
    let cursor = 1;
    let parameters: string[] | undefined;
    let variadic = false;
    if (tokens[cursor]?.text === '(' && !tokens[cursor].leadingSpace) {
      parameters = [];
      cursor++;
      if (tokens[cursor]?.text !== ')') {
        while (cursor < tokens.length) {
          if (tokens[cursor].text === '...') { variadic = true; cursor++; if (tokens[cursor]?.text !== ')') preprocessError('... must be the last parameter of a variadic macro.', tokens[cursor]?.at ?? at); break; }
          const parameter = tokens[cursor];
          if (parameter.kind !== 'identifier') preprocessError('Expected a macro parameter name.', parameter.at);
          if (parameter.text === '__VA_ARGS__') rejectVaArgsOutsideVariadicReplacement([parameter]);
          if (parameters.includes(parameter.text)) preprocessError(`Duplicate macro parameter: «${parameter.text}».`, parameter.at);
          parameters.push(parameter.text);
          cursor++;
          if (tokens[cursor]?.text === ')') break;
          if (tokens[cursor]?.text === '...') { variadic = true; cursor++; if (tokens[cursor]?.text !== ')') preprocessError('... must be the last parameter of a variadic macro.', tokens[cursor]?.at ?? at); break; }
          if (tokens[cursor]?.text !== ',') preprocessError('Expected «,» or «)» in the macro parameter list.', tokens[cursor]?.at ?? at);
          cursor++;
        }
      }
      if (tokens[cursor]?.text !== ')') preprocessError('Macro parameter list is missing «)».', tokens[cursor]?.at ?? at);
      cursor++;
    }
    const replacement = tokens.slice(cursor);
    if (parameters === undefined || !variadic) rejectVaArgsOutsideVariadicReplacement(replacement);
    for (let index = 0; index < replacement.length; index++) {
      if (replacement[index].text === '##' && (index === 0 || index === replacement.length - 1)) preprocessError('## cannot appear at the start or end of a macro replacement list.', replacement[index].at);
      if (replacement[index].text === '#' && parameters !== undefined) {
        const next = replacement[index + 1];
        if (!next || next.kind !== 'identifier' || !(parameters.includes(next.text) || (variadic && next.text === '__VA_ARGS__'))) preprocessError('# must precede a macro parameter.', replacement[index].at);
      }
    }
    const macro: Macro = { name, ...(parameters === undefined ? {} : { parameters }), variadic, replacement, at: nameToken.at };
    const previous = this.context.macros.get(name);
    if (previous && !sameMacro(previous, macro)) preprocessError(`Incompatible redefinition of macro «${name}».`, nameToken.at);
    this.context.macros.set(name, macro);
  }

}
