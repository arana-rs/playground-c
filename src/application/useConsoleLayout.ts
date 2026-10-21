import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  clampConsoleHeight,
  getConsoleHeightBounds,
  getEffectiveConsoleHeight,
  getInitialConsoleHeight,
  getPlaygroundRows,
  getVisibleViewportRect,
  hasKeyboardViewportRecovered,
  isKeyboardViewportShrunk,
} from '../consoleLayout.ts';

const CONSOLE_RESIZE_STEP = 16;

interface ConsoleResizeDrag {
  pointerId: number;
  startY: number;
  startHeight: number;
}

interface PendingConsoleHeight {
  drag: ConsoleResizeDrag;
  height: number;
}

function readVisibleViewportRect() {
  const visualViewport = window.visualViewport;
  return getVisibleViewportRect(
    window.innerWidth,
    window.innerHeight,
    visualViewport ? {
      width: visualViewport.width,
      height: visualViewport.height,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
      scale: visualViewport.scale,
    } : undefined,
  );
}

export function useConsoleLayout(
  editorRef: { current: HTMLTextAreaElement | null },
  workspacePersistenceLocked = false,
) {
  const [viewportRect, setViewportRect] = useState(() => readVisibleViewportRect());
  const [preferredConsoleHeight, setPreferredConsoleHeight] = useState(
    () => getInitialConsoleHeight(readVisibleViewportRect().height),
  );
  const [keyboardViewportActive, setKeyboardViewportActive] = useState(false);
  const [keyboardHeightManuallyAdjusted, setKeyboardHeightManuallyAdjusted] = useState(false);
  const [consoleVisible, setConsoleVisible] = useState(true);
  const [isResizingConsole, setIsResizingConsole] = useState(false);
  const consoleResizeDrag = useRef<ConsoleResizeDrag | null>(null);
  const pendingConsoleHeight = useRef<PendingConsoleHeight | null>(null);
  const consoleResizeFrame = useRef<number | null>(null);
  const viewportRectRef = useRef(viewportRect);
  const viewportBaseline = useRef({ width: viewportRect.width, height: viewportRect.height });
  const keyboardViewportActiveRef = useRef(false);
  const consoleResizerRef = useRef<HTMLDivElement>(null);
  const consolePanelRef = useRef<HTMLElement>(null);
  const consoleHeightBounds = getConsoleHeightBounds(viewportRect.height, keyboardViewportActive, consoleVisible);
  const consoleHeight = getEffectiveConsoleHeight(
    preferredConsoleHeight,
    viewportRect.height,
    keyboardViewportActive,
    keyboardHeightManuallyAdjusted,
    consoleVisible,
  );
  const playgroundRows = getPlaygroundRows(viewportRect.height, keyboardViewportActive, consoleVisible);

  const cancelPendingConsoleResize = useCallback(() => {
    if (consoleResizeFrame.current !== null) {
      window.cancelAnimationFrame(consoleResizeFrame.current);
    }
    consoleResizeFrame.current = null;
    pendingConsoleHeight.current = null;
  }, []);

  const measureVisibleViewport = useCallback(() => {
    const nextViewport = readVisibleViewportRect();
    const previousViewport = viewportRectRef.current;
    const dimensionsChanged = Math.abs(nextViewport.width - previousViewport.width) > 0.5
      || Math.abs(nextViewport.height - previousViewport.height) > 0.5;
    const rectChanged = dimensionsChanged
      || Math.abs(nextViewport.left - previousViewport.left) > 0.5
      || Math.abs(nextViewport.top - previousViewport.top) > 0.5
      || Math.abs(nextViewport.scale - previousViewport.scale) > 0.01;

    if (rectChanged) {
      viewportRectRef.current = nextViewport;
      setViewportRect(nextViewport);
    }
    if (dimensionsChanged) cancelPendingConsoleResize();

    const baseline = viewportBaseline.current;
    const sample = {
      width: nextViewport.width,
      height: nextViewport.height,
      referenceWidth: baseline.width,
      referenceHeight: baseline.height,
      scale: nextViewport.scale,
      stdinFocused: document.activeElement instanceof HTMLElement
        && document.activeElement.classList.contains('console-stdin'),
    };

    if (keyboardViewportActiveRef.current) {
      if (hasKeyboardViewportRecovered(sample)) {
        keyboardViewportActiveRef.current = false;
        setKeyboardViewportActive(false);
        setKeyboardHeightManuallyAdjusted(false);
        viewportBaseline.current = { width: nextViewport.width, height: nextViewport.height };
      }
    } else if (sample.stdinFocused) {
      if (isKeyboardViewportShrunk(sample)) {
        keyboardViewportActiveRef.current = true;
        setKeyboardViewportActive(true);
      } else if (hasKeyboardViewportRecovered(sample)) {
        viewportBaseline.current = { width: nextViewport.width, height: nextViewport.height };
      }
    } else {
      viewportBaseline.current = { width: nextViewport.width, height: nextViewport.height };
    }
  }, [cancelPendingConsoleResize]);

  useLayoutEffect(() => {
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', measureVisibleViewport);
    visualViewport?.addEventListener('resize', measureVisibleViewport);
    visualViewport?.addEventListener('scroll', measureVisibleViewport);
    measureVisibleViewport();
    return () => {
      window.removeEventListener('resize', measureVisibleViewport);
      visualViewport?.removeEventListener('resize', measureVisibleViewport);
      visualViewport?.removeEventListener('scroll', measureVisibleViewport);
    };
  }, [measureVisibleViewport]);

  useEffect(() => () => {
    // Removing the separator releases any pointer capture held by its DOM node.
    cancelPendingConsoleResize();
    consoleResizeDrag.current = null;
  }, [cancelPendingConsoleResize]);

  const toggleConsole = useCallback(() => {
    if (consoleVisible) {
      const resizer = consoleResizerRef.current;
      const panel = consolePanelRef.current;
      const activeElement = document.activeElement;
      if (resizer?.contains(activeElement) || panel?.contains(activeElement)) {
        const editor = editorRef.current;
        if (editor) {
          const selectionStart = editor.selectionStart;
          const selectionEnd = editor.selectionEnd;
          const selectionDirection = editor.selectionDirection;
          const scrollTop = editor.scrollTop;
          const scrollLeft = editor.scrollLeft;
          editor.focus({ preventScroll: true });
          editor.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
          editor.scrollTop = scrollTop;
          editor.scrollLeft = scrollLeft;
        }
      }

      cancelPendingConsoleResize();
      const drag = consoleResizeDrag.current;
      consoleResizeDrag.current = null;
      if (drag && resizer?.hasPointerCapture(drag.pointerId)) {
        resizer.releasePointerCapture(drag.pointerId);
      }
      setIsResizingConsole(false);
    }
    setConsoleVisible(visible => !visible);
  }, [cancelPendingConsoleResize, consoleVisible, editorRef]);

  function onConsoleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (consoleResizeDrag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    cancelPendingConsoleResize();
    consoleResizeDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: consoleHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingConsole(true);
  }

  function onConsoleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = consoleResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (keyboardViewportActive) setKeyboardHeightManuallyAdjusted(true);
    const nextHeight = drag.startHeight + drag.startY - event.clientY;
    pendingConsoleHeight.current = {
      drag,
      height: clampConsoleHeight(nextHeight, getConsoleHeightBounds(viewportRect.height, keyboardViewportActive, consoleVisible)),
    };
    if (consoleResizeFrame.current !== null) return;
    consoleResizeFrame.current = window.requestAnimationFrame(() => {
      consoleResizeFrame.current = null;
      const pending = pendingConsoleHeight.current;
      pendingConsoleHeight.current = null;
      if (!pending || consoleResizeDrag.current !== pending.drag) return;
      setPreferredConsoleHeight(pending.height);
    });
  }

  function finishConsoleResize(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const drag = consoleResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (commit) {
      const finalHeight = drag.startHeight + drag.startY - event.clientY;
      cancelPendingConsoleResize();
      setPreferredConsoleHeight(clampConsoleHeight(finalHeight, getConsoleHeightBounds(viewportRect.height, keyboardViewportActive, consoleVisible)));
    } else {
      cancelPendingConsoleResize();
    }
    consoleResizeDrag.current = null;
    setIsResizingConsole(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && keyboardViewportActive) setKeyboardHeightManuallyAdjusted(true);
  }

  function onConsoleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextHeight: number | undefined;
    const step = event.shiftKey ? CONSOLE_RESIZE_STEP * 3 : CONSOLE_RESIZE_STEP;
    if (event.key === 'ArrowUp') nextHeight = consoleHeight + step;
    else if (event.key === 'ArrowDown') nextHeight = consoleHeight - step;
    else if (event.key === 'Home') nextHeight = consoleHeightBounds.min;
    else if (event.key === 'End') nextHeight = consoleHeightBounds.max;
    if (nextHeight === undefined) return;
    event.preventDefault();
    if (keyboardViewportActive) setKeyboardHeightManuallyAdjusted(true);
    setPreferredConsoleHeight(clampConsoleHeight(nextHeight, consoleHeightBounds));
  }

  const playgroundStyle: CSSProperties = {
    top: viewportRect.top,
    left: viewportRect.left,
    width: viewportRect.width,
    height: viewportRect.height,
    gridTemplateRows: `${playgroundRows.header}px ${workspacePersistenceLocked ? 'max-content' : `${playgroundRows.tabs}px`} minmax(${playgroundRows.editorMinimum}px, 1fr) ${playgroundRows.separator}px ${consoleVisible ? consoleHeight : 0}px ${playgroundRows.footer}px`,
  };

  return {
    viewportRect,
    consoleVisible,
    setConsoleVisible,
    isResizingConsole,
    consoleResizerRef,
    consolePanelRef,
    consoleHeightBounds,
    consoleHeight,
    playgroundRows,
    playgroundStyle,
    measureVisibleViewport,
    toggleConsole,
    onConsoleResizePointerDown,
    onConsoleResizePointerMove,
    finishConsoleResize,
    onConsoleResizeKeyDown,
  };
}
