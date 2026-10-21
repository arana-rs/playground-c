import { useCallback, useEffect, useRef, useState } from 'react';
import { MemoryViewerController } from './MemoryViewerController.ts';
import type { MemoryViewerState } from './MemoryViewerController.ts';
import { RUN_CONFIGURATION } from '../execution/configuration.ts';
import type { RunConfiguration } from '../execution/configuration.ts';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';

export type { DebugAggregateSnapshot, DebugArraySnapshot, DebugScalarSnapshot, DebugStaticObjectSnapshot } from '@playground/c11-engine/core';
export type { DebugHeapObjectSnapshot } from '@playground/c11-engine/core';
export type { DebugPointerSnapshot } from '@playground/c11-engine/core';
export type {
  MemoryViewerActiveScope,
  MemoryViewerLifecycleBatch,
  MemoryViewerState,
  MemoryViewerStatus,
  MemoryViewerTranscriptEntry,
} from './MemoryViewerController.ts';

export interface MemoryViewerActions {
  readonly togglePlay: () => void;
  readonly previous: () => void;
  readonly next: () => void;
  readonly sendStdinLine: (line: string) => boolean;
  readonly sendStdinEOF: () => boolean;
  readonly setConsoleEnabled: (enabled: boolean) => void;
  readonly stop: () => void;
}

export type MemoryViewerHookValue = MemoryViewerState & MemoryViewerActions;

/** Starts one frozen-source debug session on mount and owns its Worker/timers until unmount. */
export function useMemoryViewer(
  document: WorkspaceSourceSnapshot,
  configuration: RunConfiguration = RUN_CONFIGURATION,
  enableConsole = true,
  playbackIntervalMs = configuration.memoryViewer.playIntervalMs,
): MemoryViewerHookValue {
  const frozenDocument = useRef(document);
  const controllerRef = useRef<MemoryViewerController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new MemoryViewerController(frozenDocument.current, { configuration, enableConsole, playbackIntervalMs });
  }
  const controller = controllerRef.current;
  const [state, setState] = useState<MemoryViewerState>(controller.state);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    controller.start(frozenDocument.current);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  const togglePlay = useCallback(() => controller.togglePlay(), [controller]);
  const previous = useCallback(() => controller.previous(), [controller]);
  const next = useCallback(() => controller.next(), [controller]);
  const sendStdinLine = useCallback((line: string) => controller.sendStdinLine(line), [controller]);
  const sendStdinEOF = useCallback(() => controller.sendStdinEOF(), [controller]);
  const setConsoleEnabled = useCallback(
    (enabled: boolean) => controller.setConsoleEnabled(enabled),
    [controller],
  );
  const stop = useCallback(() => controller.stop(), [controller]);

  useEffect(() => {
    controller.setPlaybackIntervalMs(playbackIntervalMs);
  }, [controller, playbackIntervalMs]);

  return { ...state, togglePlay, previous, next, sendStdinLine, sendStdinEOF, setConsoleEnabled, stop };
}
