import { DEFAULT_PREPARE_LIMITS, ENGINE_VERSION, TARGET_PROFILE } from './types.ts';
import type { PrepareOptions, PrepareResult, SourceProject } from './types.ts';
import { HEAP_ALLOCATOR_BUILTINS } from './allocator-builtins.ts';
import { EngineFailure, failure, freezeIR, freshMetrics, normalizedLimits, now, programs } from './internal.ts';
import type { ProgramIR } from './internal.ts';
import { linkTranslationUnits } from './linker.ts';
import { parse } from './parser.ts';
import { preprocessProject } from './preprocessor.ts';
import { normalizeVirtualPath } from './virtual-path.ts';

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
      failure('INVALID_PROJECT', 'Se requiere un proyecto virtual con entry y una lista de fuentes.', location);
    }
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
      failure('INVALID_OPTIONS', 'Las opciones de preparación deben ser un objeto.', location);
    }
    const limits = normalizedLimits(DEFAULT_PREPARE_LIMITS, options?.limits, location);
    const entry = normalizeVirtualPath(project.entry);
    if (!entry) failure('INVALID_PROJECT', `La ruta de entrada «${project.entry}» no es válida.`, location);

    const files = new Map<string, string>();
    for (const file of project.files) {
      if (!file || typeof file.name !== 'string' || typeof file.source !== 'string') {
        failure('INVALID_PROJECT', 'Cada archivo virtual debe tener name y source de tipo string.', location);
      }
      const name = normalizeVirtualPath(file.name);
      if (!name) failure('INVALID_PROJECT', `La ruta virtual «${file.name}» no es válida.`, location);
      if (files.has(name)) failure('INVALID_PROJECT', `La ruta virtual «${name}» está duplicada.`, { file: name, line: 1, column: 1 });
      files.set(name, file.source);
    }
    if (!files.has(entry)) failure('INVALID_PROJECT', `El archivo de entrada «${entry}» no existe en el proyecto virtual.`, { file: entry, line: 1, column: 1 });

    const requestedUnits = project.translationUnits ?? [entry];
    if (!Array.isArray(requestedUnits) || requestedUnits.length === 0) {
      failure('INVALID_PROJECT', 'translationUnits debe ser una lista no vacía de rutas virtuales.', { file: entry, line: 1, column: 1 });
    }
    const translationUnits: string[] = [];
    const seenUnits = new Set<string>();
    for (const candidate of requestedUnits) {
      if (typeof candidate !== 'string' || !candidate) failure('INVALID_PROJECT', 'Cada unidad de traducción debe ser una ruta virtual.', { file: entry, line: 1, column: 1 });
      const name = normalizeVirtualPath(candidate);
      if (!name) failure('INVALID_PROJECT', `La unidad de traducción «${candidate}» no tiene una ruta válida.`, { file: entry, line: 1, column: 1 });
      if (seenUnits.has(name)) failure('INVALID_PROJECT', `La unidad de traducción «${name}» está repetida.`, { file: name, line: 1, column: 1 });
      if (!files.has(name)) failure('INVALID_PROJECT', `La unidad de traducción «${name}» no existe en el proyecto virtual.`, { file: name, line: 1, column: 1 });
      seenUnits.add(name);
      translationUnits.push(name);
    }
    if (!seenUnits.has(entry)) failure('INVALID_PROJECT', 'La unidad de entrada debe aparecer en translationUnits.', { file: entry, line: 1, column: 1 });

    const normalizedProject: SourceProject = {
      entry,
      files: [...files].map(([name, source]) => ({ name, source })),
      translationUnits,
    };
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
    return { kind: 'prepare-error', diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'La preparación encontró un error interno del motor.', ...location }], metrics };
  } finally { metrics.prepareMs = now() - started; }
}
