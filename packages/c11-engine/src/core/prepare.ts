import { DEFAULT_PREPARE_LIMITS, ENGINE_VERSION, TARGET_PROFILE } from './types.ts';
import type { Diagnostic, PrepareOptions, PrepareResult, SourceProject, SyntaxAnalysisResult } from './types.ts';
import { HEAP_ALLOCATOR_BUILTINS } from './allocator-builtins.ts';
import { EngineFailure, failure, freezeIR, freshMetrics, normalizedLimits, now, programs } from './internal.ts';
import type { ProgramIR } from './internal.ts';
import { linkTranslationUnits } from './linker.ts';
import { parse } from './parser.ts';
import { preprocessProject } from './preprocessor.ts';
import { normalizeVirtualPath } from './virtual-path.ts';

const MAX_SYNTAX_DIAGNOSTICS = 20;

function normalizeProject(project: SourceProject, fallback: string): SourceProject {
  const location = { file: fallback, line: 1, column: 1 };
  if (!project || typeof project !== 'object' || typeof project.entry !== 'string' || !project.entry || !Array.isArray(project.files)) {
    failure('INVALID_PROJECT', 'A virtual project with entry and a list of sources is required.', location);
  }
  const entry = normalizeVirtualPath(project.entry);
  if (!entry) failure('INVALID_PROJECT', `Input path «${project.entry}» is invalid.`, location);

  const files = new Map<string, string>();
  for (const file of project.files) {
    if (!file || typeof file.name !== 'string' || typeof file.source !== 'string') {
      failure('INVALID_PROJECT', 'Each virtual file must have a string name and source.', location);
    }
    const name = normalizeVirtualPath(file.name);
    if (!name) failure('INVALID_PROJECT', `Virtual path «${file.name}» is invalid.`, location);
    if (files.has(name)) failure('INVALID_PROJECT', `Virtual path «${name}» is duplicated.`, { file: name, line: 1, column: 1 });
    files.set(name, file.source);
  }
  if (!files.has(entry)) failure('INVALID_PROJECT', `Entry file «${entry}» does not exist in the virtual project.`, { file: entry, line: 1, column: 1 });

  const requestedUnits = project.translationUnits ?? [entry];
  if (!Array.isArray(requestedUnits) || requestedUnits.length === 0) {
    failure('INVALID_PROJECT', 'translationUnits must be a nonempty list of virtual paths.', { file: entry, line: 1, column: 1 });
  }
  const translationUnits: string[] = [];
  const seenUnits = new Set<string>();
  for (const candidate of requestedUnits) {
    if (typeof candidate !== 'string' || !candidate) failure('INVALID_PROJECT', 'Each translation unit must be a virtual path.', { file: entry, line: 1, column: 1 });
    const name = normalizeVirtualPath(candidate);
    if (!name) failure('INVALID_PROJECT', `Translation unit «${candidate}» has an invalid path.`, { file: entry, line: 1, column: 1 });
    if (seenUnits.has(name)) failure('INVALID_PROJECT', `Translation unit «${name}» is duplicated.`, { file: name, line: 1, column: 1 });
    if (!files.has(name)) failure('INVALID_PROJECT', `Translation unit «${name}» does not exist in the virtual project.`, { file: name, line: 1, column: 1 });
    seenUnits.add(name);
    translationUnits.push(name);
  }
  if (!seenUnits.has(entry)) failure('INVALID_PROJECT', 'The entry unit must appear in translationUnits.', { file: entry, line: 1, column: 1 });

  return { entry, files: [...files].map(([name, source]) => ({ name, source })), translationUnits };
}

function hasResolvedHeapAllocationCall(ir: ProgramIR): boolean {
  const pending: object[] = [];
  for (const fn of ir.functions) if (fn.body) pending.push(fn.body);
  for (const global of ir.globals) if (global.initializer) pending.push(global.initializer);
  const seen = new Set<object>();

  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const value = node as Record<string, unknown>;
    if (value.kind === 'call' && value.builtin === true && typeof value.functionIndex === 'number') {
      const target = ir.functions[value.functionIndex];
      if (target?.builtin && HEAP_ALLOCATOR_BUILTINS.includes(target.name as (typeof HEAP_ALLOCATOR_BUILTINS)[number])) return true;
    }
    if (Array.isArray(node)) {
      for (const child of node) if (child && typeof child === 'object') pending.push(child);
      continue;
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') pending.push(child);
  }
  return false;
}

export function prepare(project: SourceProject, options?: PrepareOptions): PrepareResult {
  const started = now();
  const metrics = freshMetrics();
  const rawEntry = project && typeof project.entry === 'string' ? project.entry : 'main.c';
  const location = { file: rawEntry, line: 1, column: 1 };
  try {
    if (!project || typeof project !== 'object' || typeof project.entry !== 'string' || !project.entry || !Array.isArray(project.files)) {
      failure('INVALID_PROJECT', 'A virtual project with entry and a list of sources is required.', location);
    }
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
      failure('INVALID_OPTIONS', 'Preparation options must be an object.', location);
    }
    const limits = normalizedLimits(DEFAULT_PREPARE_LIMITS, options?.limits, location);
    const normalizedProject = normalizeProject(project, rawEntry);
    const entry = normalizedProject.entry;
    const translationUnits = normalizedProject.translationUnits!;
    const units = preprocessProject(normalizedProject, limits, metrics);
    const parsedUnits = units.map((unit) => parse(unit.tokens, limits, unit.name));
    const linked = linkTranslationUnits(parsedUnits, entry);
    const ir = { ...linked, sourceChars: metrics.sourceChars, tokenCount: metrics.tokenCount };
    const hasHeapAllocationCalls = hasResolvedHeapAllocationCall(ir);
    freezeIR(ir);
    const program = Object.freeze({
      version: ENGINE_VERSION,
      target: TARGET_PROFILE.id,
      entry,
      translationUnits: Object.freeze(translationUnits.slice()),
      hasHeapAllocationCalls,
    });
    programs.set(program, ir);
    return { kind: 'prepared', program, metrics };
  } catch (error) {
    if (error instanceof EngineFailure) {
      if (error.resource !== undefined && error.limit !== undefined) {
        return { kind: 'limit', stage: 'prepare', resource: error.resource, limit: error.limit, diagnostics: [error.diagnostic], metrics };
      }
      return { kind: 'prepare-error', diagnostics: [error.diagnostic], metrics };
    }
    return { kind: 'prepare-error', diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'Preparation encountered an internal engine error.', ...location }], metrics };
  } finally { metrics.prepareMs = now() - started; }
}

/** Preprocess and parse a virtual project without linking or executing it. */
export function analyzeSyntax(project: SourceProject, options?: PrepareOptions): SyntaxAnalysisResult {
  const started = now();
  const metrics = freshMetrics();
  const rawEntry = project && typeof project.entry === 'string' ? project.entry : 'main.c';
  const location = { file: rawEntry, line: 1, column: 1 };
  const diagnostics: Diagnostic[] = [];
  const recoveryState = { value: false };
  try {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
      failure('INVALID_OPTIONS', 'Preparation options must be an object.', location);
    }
    const limits = normalizedLimits(DEFAULT_PREPARE_LIMITS, options?.limits, location);
    const normalizedProject = normalizeProject(project, rawEntry);
    const units = preprocessProject(normalizedProject, limits, metrics, { captureSourceSpans: true });
    for (const unit of units) {
      parse(unit.tokens, limits, unit.name, { diagnostics, maxDiagnostics: MAX_SYNTAX_DIAGNOSTICS, truncated: recoveryState });
    }
    return diagnostics.length
      ? { kind: 'error', diagnostics, truncated: recoveryState.value, metrics }
      : { kind: 'ok', diagnostics: [], metrics };
  } catch (error) {
    if (error instanceof EngineFailure) {
      if (error.resource !== undefined && error.limit !== undefined &&
          ['maxSourceChars', 'maxTokens', 'maxPreprocessSteps', 'maxDepth'].includes(error.resource)) {
        return { kind: 'limit', stage: 'syntax', resource: error.resource as keyof typeof DEFAULT_PREPARE_LIMITS, limit: error.limit, diagnostics: [error.diagnostic], metrics };
      }
      return { kind: 'error', diagnostics: [error.diagnostic], truncated: false, metrics };
    }
    return { kind: 'error', diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'Syntax analysis encountered an internal engine error.', ...location }], truncated: false, metrics };
  } finally { metrics.prepareMs = now() - started; }
}
