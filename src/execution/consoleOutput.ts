import type { Diagnostic, RunResult } from '@playground/c11-engine/browser';
import { formatDiagnosticLocation } from './diagnosticFormatting.ts';
import type { RunDiagnosticsReport } from './diagnostics.ts';

export type ConsoleSystemTone = 'system' | 'warning' | 'error';
export type ConsoleOutputTone = 'program' | ConsoleSystemTone;

export type ConsoleEntry =
  | { stream: 'stdout' | 'stderr' | 'stdin'; text: string }
  | { stream: 'system'; text: string; tone?: ConsoleSystemTone; role?: 'input' | 'protected' };

export interface ConsoleOutputSegment {
  tone: ConsoleOutputTone;
  text: string;
  role?: 'output' | 'input' | 'protected';
  stream?: ConsoleEntry['stream'];
}

export type RunnerState =
  | { status: 'idle'; transcript: readonly ConsoleEntry[] }
  | { status: 'running'; transcript: readonly ConsoleEntry[]; inputRequestId: number | null }
  | { status: 'cancelled'; transcript: readonly ConsoleEntry[] }
  | { status: 'finished'; result: RunResult; transcript: readonly ConsoleEntry[] }
  | { status: 'error'; file: string; reason: 'start' | 'run' | 'response' | 'send'; message: string; transcript: readonly ConsoleEntry[] }
  | { status: 'timeout'; file: string; timeoutMs: number; diagnosticsReport: RunDiagnosticsReport; transcript: readonly ConsoleEntry[] };

export type ConsoleStatusTone = 'ready' | 'running' | 'waiting' | 'finished' | 'stopped' | 'cancelled' | 'error';
export type ConsoleStatusKey = 'ready' | 'running' | 'waitingInput' | 'cancelled' | 'error' | 'timedOut' | 'stopped' | 'finished';

export interface ConsoleStatus {
  key: ConsoleStatusKey;
  tone: ConsoleStatusTone;
}

/** A display key and tone derived directly from the runner's current state. */
export function getConsoleStatus(state: RunnerState): ConsoleStatus {
  if (state.status === 'idle') return { key: 'ready', tone: 'ready' };
  if (state.status === 'running') {
    return state.inputRequestId == null
      ? { key: 'running', tone: 'running' }
      : { key: 'waitingInput', tone: 'waiting' };
  }
  if (state.status === 'cancelled') return { key: 'cancelled', tone: 'cancelled' };
  if (state.status === 'error') return { key: 'error', tone: 'error' };
  if (state.status === 'timeout') return { key: 'timedOut', tone: 'stopped' };

  switch (state.result.kind) {
    case 'cancelled': return { key: 'cancelled', tone: 'cancelled' };
    case 'limit': return { key: 'stopped', tone: 'stopped' };
    case 'prepare-error':
    case 'read-error':
    case 'runtime-error': return { key: 'error', tone: 'error' };
    case 'terminated': return { key: 'finished', tone: 'finished' };
  }
}

export function appendEntry(transcript: readonly ConsoleEntry[], entry: ConsoleEntry): readonly ConsoleEntry[] {
  const previous = transcript.at(-1);
  if (previous?.stream === entry.stream && entry.stream !== 'stdin' && entry.stream !== 'system') {
    return [...transcript.slice(0, -1), { stream: entry.stream, text: previous.text + entry.text }];
  }
  return [...transcript, entry];
}

function appendOutputSegment(
  segments: ConsoleOutputSegment[],
  text: string,
  tone: ConsoleOutputTone,
  role: ConsoleOutputSegment['role'] = 'output',
  stream?: ConsoleOutputSegment['stream'],
) {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.tone === tone && previous.role === role && previous.stream === stream) previous.text += text;
  else segments.push({ tone, text, role, stream });
}

function appendOutputSection(
  segments: ConsoleOutputSegment[],
  next: { tone: ConsoleOutputTone; text: string; role?: ConsoleOutputSegment['role']; stream?: ConsoleOutputSegment['stream'] },
) {
  if (!next.text) return;
  const previous = segments.at(-1);
  const separator = previous && !previous.text.endsWith('\n') ? '\n' : '';
  appendOutputSegment(segments, `${separator}${next.text}`, next.tone, next.role, next.stream);
}

function formatTranscriptSegments(transcript: readonly ConsoleEntry[]): ConsoleOutputSegment[] {
  const segments: ConsoleOutputSegment[] = [];
  for (const entry of transcript) {
    if (entry.stream === 'stderr') {
      appendOutputSegment(segments, entry.text, 'program', 'output', 'stderr');
    } else {
      const tone = entry.stream === 'system' ? entry.tone ?? 'system' : 'program';
      const role = entry.stream === 'system' ? entry.role ?? 'protected' : entry.stream === 'stdin' ? 'input' : 'output';
      appendOutputSegment(segments, entry.text, tone, role, entry.stream);
    }
  }
  return segments;
}

export function addSystemEntry(
  transcript: readonly ConsoleEntry[],
  message: string,
  tone: ConsoleSystemTone = 'system',
): readonly ConsoleEntry[] {
  const current = transcript.at(-1)?.text ?? '';
  const separator = transcript.length > 0 && current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  return appendEntry(transcript, { stream: 'system', text: `${separator}${message}`, tone });
}

export function errorText(file: string, reason: 'start' | 'run' | 'response' | 'send', message: string): string {
  const quotedFile = `"${file}"`;
  if (reason === 'start') return `Could not start the execution engine for ${quotedFile}: ${message}`;
  if (reason === 'response') return `The engine finished, but its response for ${quotedFile} could not be read: ${message}`;
  if (reason === 'send') return `Could not send ${quotedFile} to the execution engine: ${message}`;
  return `The execution engine failed while processing ${quotedFile}: ${message}`;
}

export function formatDuration(milliseconds: number) {
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds) ? `${formatCount(seconds)} s` : `${formatCount(milliseconds)} ms`;
}

function formatDiagnostic(item: Diagnostic) {
  return `${formatDiagnosticLocation(item)}: ${item.message}`;
}

function appendConsoleSection(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  return `${current}${current.endsWith('\n') ? '' : '\n'}${next}`;
}

function formatOutputSegments(result: RunResult): ConsoleOutputSegment[] {
  const segments: ConsoleOutputSegment[] = [];
  if ('stdout' in result) appendOutputSegment(segments, new TextDecoder().decode(result.stdout), 'program', 'output', 'stdout');
  if ('stderr' in result) {
    const stderr = new TextDecoder().decode(result.stderr);
    appendOutputSegment(segments, stderr, 'program', 'output', 'stderr');
  }
  return segments;
}

type LimitRunResult = Extract<RunResult, { kind: 'limit' }>;
type LimitResource = LimitRunResult['resource'];

const limitDescriptions: Record<LimitResource, { label: string; unit: string; reason: string }> = {
  maxSourceChars: {
    label: 'source code size',
    unit: 'characters',
    reason: 'This limit bounds reading and preparation of large files.',
  },
  maxTokens: {
    label: 'analyzed code size',
    unit: 'tokens',
    reason: 'This limit bounds analysis of large programs.',
  },
  maxPreprocessSteps: {
    label: 'preprocessor work',
    unit: 'steps',
    reason: 'A large macro or include expansion can reach this limit.',
  },
  maxDepth: {
    label: 'nesting depth',
    unit: 'levels',
    reason: 'Check for deeply nested expressions, blocks, or calls; this limit alone does not identify the cause.',
  },
  maxInstructions: {
    label: 'execution steps',
    unit: 'steps',
    reason: 'Check for long loops or recursion; a valid calculation can also exceed this budget.',
  },
  maxMemoryBytes: {
    label: 'program memory',
    unit: 'bytes',
    reason: 'This budget protects the playground from large data or objects.',
  },
  maxIOBytes: {
    label: 'input and output data',
    unit: 'bytes',
    reason: 'This budget covers data that the program can read and write.',
  },
};

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function limitUsage(result: LimitRunResult): number | undefined {
  switch (result.resource) {
    case 'maxSourceChars': return result.metrics.sourceChars;
    case 'maxTokens': return result.metrics.tokenCount;
    case 'maxPreprocessSteps': return result.metrics.preprocessSteps;
    case 'maxInstructions': return result.metrics.instructionCount;
    default: return undefined;
  }
}

function formatLimit(result: LimitRunResult) {
  const description = limitDescriptions[result.resource];
  const stage = result.stage === 'prepare' ? 'Preparation stopped' : 'Execution stopped';
  const usage = limitUsage(result);
  const counts = usage === undefined || usage <= result.limit
    ? `${formatCount(result.limit)} ${description.unit} allowed`
    : `${formatCount(result.limit)} ${description.unit} allowed; ${formatCount(usage)} were counted`;
  const locations = result.diagnostics.map(item => formatDiagnosticLocation(item)).join('\n');
  return appendConsoleSection(
    `${stage}: the ${description.label} limit was reached (${counts}). ${description.reason}`,
    locations,
  );
}

interface ConsoleSystemMessage {
  tone: ConsoleSystemTone;
  text: string;
}

export function formatResultSummary(result: RunResult): ConsoleSystemMessage {
  if (result.kind === 'terminated') {
    return { tone: 'system', text: `exit code: ${result.exitCode}` };
  }
  if (result.kind === 'cancelled') {
    return { tone: 'warning', text: `Execution was cancelled during the ${result.stage} stage.` };
  }
  if (result.kind === 'limit') {
    return { tone: 'warning', text: formatLimit(result) };
  }
  if (result.kind === 'runtime-error') {
    return {
      tone: 'error',
      text: appendConsoleSection('Runtime error:', result.diagnostics.map(formatDiagnostic).join('\n')),
    };
  }
  if (result.kind === 'prepare-error') {
    return {
      tone: 'error',
      text: appendConsoleSection('Could not prepare the program:', result.diagnostics.map(formatDiagnostic).join('\n')),
    };
  }
  return {
    tone: 'error',
    text: appendConsoleSection('Could not read the file for execution:', result.diagnostics.map(formatDiagnostic).join('\n')),
  };
}

export function formatConsoleSegments(state: RunnerState): readonly ConsoleOutputSegment[] {
  if (state.status === 'idle') return [];
  const transcript = 'transcript' in state ? state.transcript : undefined;
  if (transcript?.length) return formatTranscriptSegments(transcript);
  if (state.status === 'running') return [];
  if (state.status === 'cancelled') return [{ tone: 'warning', text: 'Execution cancelled by the user.', role: 'protected', stream: 'system' }];
  if (state.status === 'error') {
    return [{ tone: 'error', text: errorText(state.file, state.reason, state.message), role: 'protected', stream: 'system' }];
  }
  if (state.status === 'timeout') {
    return [{
      tone: 'warning',
      role: 'protected',
      stream: 'system',
      text: `The ${formatDuration(state.timeoutMs)} time limit expired while starting, reading, preparing, or running "${state.file}"; execution stopped. Check for slow code such as loops or recursion. A valid program may also need more time.`,
    }];
  }
  const segments = formatOutputSegments(state.result);
  const summary = formatResultSummary(state.result);
  appendOutputSection(segments, { ...summary, role: 'protected', stream: 'system' });
  return segments;
}

export function formatConsole(state: RunnerState): string {
  let text = '';
  for (const segment of formatConsoleSegments(state)) {
    if (segment.role === 'output' && segment.stream === 'stderr' && segment.text) {
      const separator = text && !text.endsWith('\n') ? '\n' : '';
      text += `${separator}stderr:\n${segment.text}`;
    } else {
      text += segment.text;
    }
  }
  return text;
}
