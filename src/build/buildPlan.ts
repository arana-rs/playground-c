import type { Diagnostic } from '@playground/c11-engine/core';
import { parseMakefile } from './makefile.ts';

export const MAKEFILE_NAME = 'Makefile';
const NO_DIAGNOSTICS: readonly [] = Object.freeze([]);

export interface BuildPlan {
  readonly target: string | null;
  readonly entry: string;
  readonly translationUnits: readonly string[];
}

export interface BuildSourceFile {
  readonly name: string;
  readonly source: string;
}

export interface BuildPlanProject {
  readonly entry: string;
  readonly files: readonly BuildSourceFile[];
  readonly translationUnits: readonly string[];
}

export type BuildPlanResolution =
  | {
    readonly status: 'ready';
    readonly plan: BuildPlan;
    readonly diagnostics: readonly [];
  }
  | {
    readonly status: 'invalid';
    readonly plan: null;
    readonly diagnostics: readonly Diagnostic[];
  }
  | {
    readonly status: 'syntax-only';
    readonly plan: BuildPlan;
    readonly diagnostics: readonly Diagnostic[];
  }
  | {
    readonly status: 'unavailable';
    readonly plan: null;
    readonly diagnostics: readonly Diagnostic[];
  };

function makefileDiagnostics(
  diagnostics: readonly { file: string; line: number; column: number; message: string }[],
): readonly Diagnostic[] {
  return Object.freeze(diagnostics.map(diagnostic => Object.freeze({
    code: 'MAKEFILE_ERROR',
    message: diagnostic.message,
    file: diagnostic.file,
    line: diagnostic.line,
    column: diagnostic.column,
  })));
}

function unavailableDiagnostic(fileName: string): Diagnostic {
  return Object.freeze({
    code: 'BUILD_PLAN_UNAVAILABLE',
    message: 'Run requires an active .c translation unit or a valid Makefile.',
    file: fileName,
    line: 1,
    column: 1,
  });
}

/** Resolve the workspace's one immutable build plan from captured names and source text. */
export function resolveBuildPlan(
  files: readonly BuildSourceFile[],
  activeFileName: string,
): BuildPlanResolution {
  const makefile = files.find(file => file.name === MAKEFILE_NAME);
  if (makefile) {
    const result = parseMakefile(makefile.source, files.map(file => file.name));
    if (!result.plan) {
      const diagnostics = result.diagnostics.length > 0
        ? makefileDiagnostics(result.diagnostics)
        : makefileDiagnostics([{
          file: MAKEFILE_NAME,
          line: 1,
          column: 1,
          message: 'Makefile does not define a valid build plan.',
        }]);
      return Object.freeze({
        status: 'invalid',
        plan: null,
        diagnostics,
      });
    }

    const plan = Object.freeze({
      target: result.plan.target,
      entry: result.plan.entry,
      translationUnits: Object.freeze([...result.plan.translationUnits]),
    });
    return Object.freeze({ status: 'ready', plan, diagnostics: NO_DIAGNOSTICS });
  }

  if (activeFileName.endsWith('.c')) {
    const plan = Object.freeze({
      target: null,
      entry: activeFileName,
      translationUnits: Object.freeze([activeFileName]),
    });
    return Object.freeze({ status: 'ready', plan, diagnostics: NO_DIAGNOSTICS });
  }

  if (activeFileName.endsWith('.h')) {
    const plan = Object.freeze({
      target: null,
      entry: activeFileName,
      translationUnits: Object.freeze([activeFileName]),
    });
    return Object.freeze({
      status: 'syntax-only',
      plan,
      diagnostics: Object.freeze([unavailableDiagnostic(activeFileName)]),
    });
  }

  return Object.freeze({
    status: 'unavailable',
    plan: null,
    diagnostics: Object.freeze([unavailableDiagnostic(activeFileName)]),
  });
}

/** Run and debug can only prepare a C program selected by a valid build plan. */
export function isRunnableBuildPlan(resolution: BuildPlanResolution): boolean {
  return resolution.status === 'ready' || resolution.status === 'invalid';
}

/** Create the engine-facing source project without including UI-only file IDs. */
export function createBuildPlanProject(
  files: readonly BuildSourceFile[],
  resolution: BuildPlanResolution,
): BuildPlanProject | null {
  if (!resolution.plan) return null;
  return Object.freeze({
    entry: resolution.plan.entry,
    files: Object.freeze(files.map(file => Object.freeze({ name: file.name, source: file.source }))),
    translationUnits: resolution.plan.translationUnits,
  });
}

/** Resolve the captured source used when a debug location has no file yet. */
export function getBuildPlanEntryFile(
  files: readonly BuildSourceFile[],
  resolution: BuildPlanResolution,
): BuildSourceFile | undefined {
  if (!resolution.plan) return undefined;
  return files.find(file => file.name === resolution.plan.entry);
}
