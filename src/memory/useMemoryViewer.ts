import { useCallback, useEffect, useRef, useState } from 'react';
import { MemoryViewerController } from './MemoryViewerController.ts';
import type { MemoryViewerState } from './MemoryViewerController.ts';

export type { DebugAggregateSnapshot, DebugArraySnapshot, DebugScalarSnapshot, DebugStaticObjectSnapshot } from '@playground/c11-engine/core';
export type { DebugHeapObjectSnapshot } from '@playground/c11-engine/core';
export type { DebugPointerSnapshot } from '@playground/c11-engine/core';
export type {
  MemoryViewerActiveScope,
  MemoryViewerLifecycleBatch,
  MemoryViewerState,
  MemoryViewerStatus,
} from './MemoryViewerController.ts';

export interface MemoryViewerActions {
  readonly togglePlay: () => void;
  readonly previous: () => void;
  readonly next: () => void;
}

export type MemoryViewerHookValue = MemoryViewerState & MemoryViewerActions;

/** Starts one frozen-source debug session on mount and owns its Worker/timers until unmount. */
export function useMemoryViewer(source: string): MemoryViewerHookValue {
  const frozenSource = useRef(source);
  const controllerRef = useRef<MemoryViewerController | null>(null);
  if (!controllerRef.current) controllerRef.current = new MemoryViewerController(frozenSource.current);
  const controller = controllerRef.current;
  const [state, setState] = useState<MemoryViewerState>(controller.state);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    controller.start(frozenSource.current);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  const togglePlay = useCallback(() => controller.togglePlay(), [controller]);
  const previous = useCallback(() => controller.previous(), [controller]);
  const next = useCallback(() => controller.next(), [controller]);

  return { ...state, togglePlay, previous, next };
}
