import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PrepareOptions } from '@playground/c11-engine/core';
import { SyntaxAnalysisController } from './syntaxAnalysisController.ts';
import type { SyntaxAnalysisState, SyntaxAnalysisWorker } from './syntaxAnalysisController.ts';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';

function createSyntaxAnalysisWorker(): SyntaxAnalysisWorker {
  return new Worker(new URL('./syntax.worker.ts', import.meta.url), { type: 'module' }) as unknown as SyntaxAnalysisWorker;
}

export function useSyntaxAnalysis({
  snapshot,
  enabled,
  composing,
  options,
  timeoutMs,
}: {
  snapshot: WorkspaceSourceSnapshot;
  enabled: boolean;
  composing: boolean;
  options: PrepareOptions;
  timeoutMs: number;
}, externalControllerRef?: { current: SyntaxAnalysisController | null }): SyntaxAnalysisState {
  const [state, setState] = useState<SyntaxAnalysisState>({ status: 'off' });
  const ownedControllerRef = useRef<SyntaxAnalysisController | null>(null);
  const controllerRef = externalControllerRef ?? ownedControllerRef;
  if (!controllerRef.current) {
    controllerRef.current = new SyntaxAnalysisController({
      workerFactory: createSyntaxAnalysisWorker,
      onStateChange: setState,
      timeoutMs,
    });
  }
  const controller = controllerRef.current;

  useLayoutEffect(() => {
    controller.setSnapshot(snapshot);
    controller.setOptions(options);
    controller.setTimeoutMs(timeoutMs);
    controller.setComposing(composing);
    controller.setEnabled(enabled);
  }, [controller, snapshot, enabled, composing, options, timeoutMs]);

  useEffect(() => () => controller.dispose(), [controller]);

  return state;
}
