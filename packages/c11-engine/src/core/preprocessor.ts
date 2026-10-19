import { getStandardHeader } from './headers.ts';
import { enforceLimit } from './internal.ts';
import type { Location, SourceSpan, Token } from './internal.ts';
import { lexPreprocessingToken } from './lexer.ts';
import type { EngineMetrics, PrepareLimits, SourceProject } from './types.ts';
import { MacroExpander } from './preprocessor-expansion.ts';
import { decodeCQuotedString, predefinedMacros, rejectVaArgsOutsideVariadicReplacement, tokenText } from './preprocessor-macros.ts';
import { preprocessError } from './preprocessor-errors.ts';
import { joinVirtualPath, normalizeVirtualPath, parentDirectory } from './preprocessor-source.ts';
import { tokenizeSource } from './preprocessor-tokenize.ts';
import type { Conditional, PPContext, PPToken, PreprocessedUnit } from './preprocessor-types.ts';

export type { PreprocessedUnit } from './preprocessor-types.ts';

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class TranslationPreprocessor {
  readonly context: PPContext;
  readonly expander: MacroExpander;

  constructor(context: PPContext) {
    this.context = context;
    this.expander = new MacroExpander(context);
  }

  private includeFile(requested: string, angled: boolean, includingFile: string, at: Location): { name: string; source: string } {
    const candidates: string[] = [];
    if (!angled) candidates.push(joinVirtualPath(parentDirectory(includingFile), requested, at));
    candidates.push(joinVirtualPath('', requested, at));
    for (const candidate of candidates) {
      const source = this.context.files.get(candidate);
      if (source !== undefined) return { name: candidate, source };
    }
    const standard = getStandardHeader(requested);
    if (standard !== undefined) return { name: requested, source: standard };
    preprocessError(`Virtual header «${requested}» was not found.`, at, 'INCLUDE_NOT_FOUND');
  }

  private parseInclude(tokens: readonly PPToken[], includingFile: string, at: Location, depth: number): PPToken[] {
    const expanded = this.expander.expand(tokens);
    if (!expanded.length) preprocessError('#include requires a header name.', at);
    let requested: string;
    let angled = false;
    const first = expanded[0];
    if (first.kind === 'header') { requested = first.text.slice(1, -1); angled = true; if (expanded.length !== 1) preprocessError('Extra tokens after the header name.', expanded[1].at); }
    else if (first.kind === 'string') { requested = decodeCQuotedString(first); if (expanded.length !== 1) preprocessError('Extra tokens after the header name.', expanded[1].at); }
    else if (first.text === '<') {
      const close = expanded.findIndex((token, index) => index > 0 && token.text === '>');
      if (close < 0) preprocessError('The angled header is missing «>».', first.at);
      requested = expanded.slice(1, close).map((token) => token.text).join('');
      angled = true;
      if (expanded.length !== close + 1) preprocessError('Extra tokens after the header name.', expanded[close + 1].at);
    } else preprocessError('#include requires a string or a header enclosed by «<» and «>».', first.at);
    if (!requested || requested.includes('\0')) preprocessError('The header name is empty or contains NUL.', first.at);
    this.expander.countExpansionWork(1, at);
    const target = this.includeFile(requested, angled, includingFile, at);
    return this.processFile(target.name, target.source, depth + 1, at).tokens;
  }

  private handleDirective(directive: string, rest: readonly PPToken[], file: string, at: Location, depth: number, conditionalStack: Conditional[], activeBefore: boolean): { output: PPToken[]; lineOverride?: { line: number; file: string; nextPhysicalLine: number } } {
    const output: PPToken[] = [];
    if (!directive) return { output };
    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
      this.expander.checkDepth(conditionalStack.length + 1, at);
      const parentActive = activeBefore;
      let condition = false;
      if (parentActive) {
        if (directive === 'if') condition = this.expander.evaluateIf(rest, at);
        else {
          rejectVaArgsOutsideVariadicReplacement(rest);
          if (!rest[0] || rest[0].kind !== 'identifier' || rest.length !== 1) preprocessError(`#${directive} requires a single macro name.`, at);
          condition = this.context.macros.has(rest[0].text);
          if (directive === 'ifndef') condition = !condition;
        }
      }
      conditionalStack.push({ parentActive, active: parentActive && condition, branchTaken: parentActive && condition, sawElse: false, at });
      return { output };
    }
    if (directive === 'elif') {
      const frame = conditionalStack.at(-1);
      if (!frame) preprocessError('#elif has no matching #if.', at);
      if (frame.sawElse) preprocessError('#elif after #else.', at);
      const condition = frame.parentActive && !frame.branchTaken ? this.expander.evaluateIf(rest, at) : false;
      frame.active = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken ||= condition;
      return { output };
    }
    if (directive === 'else') {
      const frame = conditionalStack.at(-1);
      if (!frame) preprocessError('#else has no matching #if.', at);
      if (frame.sawElse) preprocessError('More than one #else for the same condition.', at);
      if (rest.length) preprocessError('Extra tokens after #else.', rest[0].at);
      frame.sawElse = true;
      frame.active = frame.parentActive && !frame.branchTaken;
      frame.branchTaken = true;
      return { output };
    }
    if (directive === 'endif') {
      if (!conditionalStack.length) preprocessError('#endif has no matching #if.', at);
      if (rest.length) preprocessError('Extra tokens after #endif.', rest[0].at);
      conditionalStack.pop();
      return { output };
    }
    if (!activeBefore) return { output };
    if (directive === 'define') { this.expander.defineMacro(rest, at); return { output }; }
    rejectVaArgsOutsideVariadicReplacement(rest);
    if (directive === 'undef') {
      if (rest.length !== 1 || rest[0].kind !== 'identifier') preprocessError('#undef requires a single macro name.', at);
      this.context.macros.delete(rest[0].text);
      return { output };
    }
    if (directive === 'include') return { output: this.parseInclude(rest, file, at, depth) };
    if (directive === 'error') {
      const expanded = this.expander.expand(rest);
      preprocessError(tokenText(expanded) || '#error', at, 'PREPROCESSOR_ERROR');
    }
    if (directive === 'line') {
      const expanded = this.expander.expand(rest);
      const number = expanded[0];
      if (!number || number.kind !== 'number' || !/^[0-9]+$/.test(number.text) || expanded.length > 2) preprocessError('#line requires a positive decimal number and an optional file name.', number?.at ?? at);
      const requested = BigInt(number.text);
      if (requested < 1n || requested > 2147483647n) preprocessError('#line must be between 1 and 2147483647.', number.at);
      let logicalFile = at.file;
      if (expanded[1]) {
        if (expanded[1].kind !== 'string' || expanded.length !== 2) preprocessError('#line allows an optional quoted file name.', expanded[1].at);
        logicalFile = decodeCQuotedString(expanded[1]);
      }
      const physicalEnd = Math.max(...rest.map((token) => token.physicalLine));
      return { output, lineOverride: { line: Number(requested), file: logicalFile, nextPhysicalLine: physicalEnd + 1 } };
    }
    if (directive === 'pragma') { this.expander.parsePragma(tokenText(rest), at, file); return { output }; }
    preprocessError(`Unimplemented preprocessor directive: #${directive}.`, at, 'UNSUPPORTED_FEATURE');
  }

  private active(conditionalStack: readonly Conditional[]): boolean {
    return conditionalStack.length === 0 || conditionalStack.at(-1)!.active;
  }

  private processFile(file: string, source: string, depth: number, includeAt: Location): { tokens: PPToken[]; eof: Location } {
    this.expander.checkDepth(depth, includeAt);
    this.expander.countExpansionWork(1, includeAt);
    if (this.context.onceFiles.has(file)) return { tokens: [], eof: { file, line: 1, column: 1 } };
    const scanned = tokenizeSource(file, source, this.context.captureSourceSpans);
    let logicalFile = file;
    let logicalOffset = 0;
    const output: PPToken[] = [];
    let pending: PPToken[] = [];
    const conditionalStack: Conditional[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      rejectVaArgsOutsideVariadicReplacement(pending);
      const expanded = this.expander.expand(pending);
      output.push(...this.expander.applyPragmaOperator(expanded, file));
      pending = [];
    };
    for (const line of scanned.lines) {
      const tokens = line.tokens.map((token) => {
        const safeSourceMapping = logicalFile === file && logicalOffset === 0;
        return {
          ...token,
          at: { file: logicalFile, line: token.physicalLine + logicalOffset, column: token.physicalColumn },
          ...(this.context.captureSourceSpans && safeSourceMapping && token.physicalEndLine !== undefined && token.physicalEndColumn !== undefined ? {
            endAt: { file: logicalFile, line: token.physicalEndLine + logicalOffset, column: token.physicalEndColumn },
          } : {}),
        };
      });
      this.expander.countExpansionWork(Math.max(1, tokens.length), tokens[0]?.at ?? includeAt);
      const isDirective = tokens[0]?.text === '#';
      if (!isDirective) {
        if (this.active(conditionalStack)) pending.push(...tokens);
        continue;
      }
      flush();
      const head = tokens[1];
      if (head && head.kind !== 'identifier') {
        if (this.active(conditionalStack)) preprocessError('Expected a directive name after «#».', head.at);
        continue;
      }
      const directive = head?.kind === 'identifier' ? head.text : '';
      const rest = head ? tokens.slice(2) : [];
      const at = tokens[0].at;
      const handled = this.handleDirective(directive, rest, file, at, depth, conditionalStack, this.active(conditionalStack));
      output.push(...handled.output);
      if (handled.lineOverride) {
        logicalOffset = handled.lineOverride.line - handled.lineOverride.nextPhysicalLine;
        logicalFile = handled.lineOverride.file;
      }
    }
    flush();
    if (conditionalStack.length) preprocessError('Missing #endif for the condition started here.', conditionalStack.at(-1)!.at);
    const eof: Location = {
      file: logicalFile,
      line: scanned.eof.physicalLine + logicalOffset,
      column: scanned.eof.physicalColumn,
      ...(this.context.captureSourceSpans && logicalFile === file && logicalOffset === 0 ? { sourceSpan: {
        physicalFile: file,
        startOffset: source.length,
        endOffset: source.length,
        logicalLineOffset: logicalOffset,
      } } : {}),
    };
    return { tokens: output, eof };
  }

  run(name: string, source: string): { tokens: PPToken[]; eof: Location } {
    return this.processFile(name, source, 0, { file: name, line: 1, column: 1 });
  }}

export interface PreprocessOptions { readonly captureSourceSpans?: boolean }

export function preprocessProject(
  project: SourceProject,
  limits: PrepareLimits,
  metrics: EngineMetrics,
  options?: PreprocessOptions,
): readonly PreprocessedUnit[] {
  const fallback = typeof project?.entry === 'string' && project.entry ? project.entry : 'main.c';
  const location: Location = { file: fallback, line: 1, column: 1 };
  if (!project || typeof project !== 'object' || typeof project.entry !== 'string' || !project.entry || !Array.isArray(project.files)) {
    preprocessError('A project with entry and a list of sources is required.', location, 'INVALID_PROJECT');
  }
  const files = new Map<string, string>();
  let sourceChars = 0;
  for (const file of project.files) {
    if (!file || typeof file.name !== 'string' || !file.name || typeof file.source !== 'string') preprocessError('Each source must have name and a string source.', location, 'INVALID_PROJECT');
    const name = normalizeVirtualPath(file.name, location);
    if (files.has(name)) preprocessError(`Duplicate source name: «${name}».`, { file: name, line: 1, column: 1 }, 'INVALID_PROJECT');
    files.set(name, file.source);
    sourceChars += file.source.length;
  }
  const entry = normalizeVirtualPath(project.entry, location);
  if (!files.has(entry)) preprocessError(`Entry file «${entry}» is not among the sources.`, location, 'INVALID_PROJECT');
  metrics.sourceChars = sourceChars;
  enforceLimit('maxSourceChars', sourceChars, limits.maxSourceChars, { file: entry, line: 1, column: 1 });
  const requestedUnits = (project as SourceProject & { translationUnits?: readonly string[] }).translationUnits;
  if (requestedUnits !== undefined && (!Array.isArray(requestedUnits) || requestedUnits.length === 0)) preprocessError('translationUnits must be a nonempty list of source names.', location, 'INVALID_PROJECT');
  const unitNames = requestedUnits ?? [entry];
  const date = new Date();
  const dateText = `${monthNames[date.getMonth()]} ${date.getDate() < 10 ? ` ${date.getDate()}` : date.getDate()} ${date.getFullYear()}`;
  const timeText = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  const units: PreprocessedUnit[] = [];
  for (const requestedName of unitNames) {
    const name = normalizeVirtualPath(requestedName, location);
    const source = files.get(name);
    if (source === undefined) preprocessError(`Translation unit «${name}» is not among the source files.`, location, 'INVALID_PROJECT');
    const start: Location = { file: name, line: 1, column: 1 };
    const context: PPContext = {
      macros: predefinedMacros(start, dateText, timeText), files, onceFiles: new Set(), limits, metrics,
      captureSourceSpans: options?.captureSourceSpans ?? false,
      dateText, timeText,
    };
    const preprocessor = new TranslationPreprocessor(context);
    const result = preprocessor.run(name, source);
    const tokens: Token[] = [];
    for (const token of result.tokens) {
      if (token.kind === 'header') preprocessError('A header name appeared outside an #include directive.', token.at);
      const needsRelatedProvenance = ['(', '[', '{', ')', ']', '}', ';'].includes(token.text);
      const physicalFile = token.physicalFile;
      const safeSourceMapping = options?.captureSourceSpans && token.expansionSite === undefined && token.physicalFile !== undefined &&
        token.at.file === token.physicalFile && token.at.line - token.physicalLine === 0;
      const sourceSpan: SourceSpan | undefined = safeSourceMapping && needsRelatedProvenance && physicalFile !== undefined && token.physicalOffset !== undefined && token.physicalEndOffset !== undefined
        ? {
          physicalFile,
          startOffset: token.physicalOffset,
          endOffset: token.physicalEndOffset,
          logicalLineOffset: token.at.line - token.physicalLine,
        }
        : undefined;
      const parsed = lexPreprocessingToken(
        token.kind,
        token.text,
        token.at,
        safeSourceMapping ? token.endAt : undefined,
        sourceSpan,
      );
      metrics.tokenCount++;
      enforceLimit('maxTokens', metrics.tokenCount, limits.maxTokens, token.at);
      tokens.push(parsed);
    }
    tokens.push({ kind: 'eof', text: '', ...result.eof });
    units.push({ name, tokens });
  }
  return units;
}


