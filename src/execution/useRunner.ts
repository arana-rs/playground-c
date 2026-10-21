import { useCallback, useEffect, useRef, useState } from 'react';
import { RUN_CONFIGURATION } from './configuration.ts';
import type { RunConfiguration } from './configuration.ts';
import { RunnerController } from './runnerController.ts';
import type { RunnerState } from './consoleOutput.ts';
import type { ExecutionDocumentSnapshot } from './documentSnapshot.ts';

export { RUN_CONFIGURATION } from './configuration.ts';
export type { RunConfiguration } from './configuration.ts';
export type { RunDiagnosticsReport } from './diagnostics.ts';
export type { ExecutionDocumentSnapshot } from './documentSnapshot.ts';
export { RunnerController } from './runnerController.ts';
export { formatConsole, formatConsoleSegments, getConsoleStatus } from './consoleOutput.ts';
export type {
  ConsoleEntry,
  ConsoleDiagnosticLocation,
  ConsoleOutputSegment,
  ConsoleOutputTone,
  ConsoleStatus,
  ConsoleStatusKey,
  ConsoleStatusTone,
  ConsoleSystemTone,
  RunnerState,
} from './consoleOutput.ts';

export function useRunner(configuration: RunConfiguration = RUN_CONFIGURATION) {
  const controller = useRef<RunnerController | null>(null);
  if (!controller.current) controller.current = new RunnerController(configuration);
  const runner = controller.current;
  const [state, setState] = useState<RunnerState>(runner.state);

  useEffect(() => {
    setState(runner.state);
    return runner.subscribe(setState);
  }, [runner]);
  useEffect(() => () => runner.dispose(), [runner]);

  const run = useCallback((document: ExecutionDocumentSnapshot, configuration?: RunConfiguration) => runner.run(document, configuration), [runner]);
  const stop = useCallback(() => runner.stop(), [runner]);
  const sendStdinLine = useCallback((line: string) => runner.sendStdinLine(line), [runner]);
  const sendStdinEOF = useCallback(() => runner.sendStdinEOF(), [runner]);

  return { state, run, stop, sendStdinLine, sendStdinEOF, isRunning: state.status === 'running' };
}
