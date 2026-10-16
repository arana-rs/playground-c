import { useCallback, useLayoutEffect, useRef } from 'react';
import { StackScrollFollowAnchor } from './stackScrollGeometry.ts';

interface StackFollowCompletion {
  readonly element: HTMLElement;
  readonly margin: number;
  onSettled?: (fullyVisible: boolean) => void;
}

interface StackHorizontalScrollController {
  ensureVisible: (element: HTMLElement, margin: number, onSettled?: (fullyVisible: boolean) => void) => void;
  cancelPendingFollow: () => void;
}

export function useStackHorizontalScroll(expanded: boolean) {
  const stackSectionRef = useRef<HTMLElement>(null);
  const stackScrollRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<StackHorizontalScrollController | null>(null);

  useLayoutEffect(() => {
    const stackSectionRefValue = stackSectionRef.current;
    const scrollAreaRefValue = stackScrollRef.current;
    if (!stackSectionRefValue || !scrollAreaRefValue || !expanded) return;
    const stackSection: HTMLElement = stackSectionRefValue;
    const activeScrollArea: HTMLDivElement = scrollAreaRefValue;

    let animationFrame: number | null = null;
    let lastFrameTime: number | null = null;
    let targetScrollLeft = activeScrollArea.scrollLeft;
    let manualPointerActive = false;
    let suppressFollowUntil = 0;
    let activeFollow: StackScrollFollowAnchor<HTMLElement> | null = null;
    let deferredFollow: StackFollowCompletion | null = null;
    let deferredFollowTimer: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let followGeneration = 0;

    function getMaxScrollLeft() {
      return Math.max(0, activeScrollArea.scrollWidth - activeScrollArea.clientWidth);
    }

    function clampScrollLeft(value: number, maxScrollLeft = getMaxScrollLeft()) {
      return Math.max(0, Math.min(maxScrollLeft, value));
    }

    function writeScrollLeft(value: number) {
      activeScrollArea.scrollLeft = value;
      const actualScrollLeft = activeScrollArea.scrollLeft;
      if (Math.abs(actualScrollLeft - value) > 0.5) targetScrollLeft = actualScrollLeft;
      return actualScrollLeft;
    }

    function isFullyVisible(element: HTMLElement, margin: number) {
      if (!element.isConnected || activeScrollArea.hidden) return false;
      const scrollRect = activeScrollArea.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const scrollportLeft = scrollRect.left + activeScrollArea.clientLeft;
      const visibleLeft = scrollportLeft + margin;
      const visibleRight = scrollportLeft + activeScrollArea.clientWidth - margin;
      return elementRect.left >= visibleLeft - 0.5 && elementRect.right <= visibleRight + 0.5;
    }

    function getFollowTarget(follow: StackScrollFollowAnchor<HTMLElement>) {
      const scrollRect = activeScrollArea.getBoundingClientRect();
      const elementRect = follow.element.getBoundingClientRect();
      const visibleLeft = scrollRect.left + activeScrollArea.clientLeft;
      return follow.plan({
        currentScrollLeft: activeScrollArea.scrollLeft,
        maxScrollLeft: getMaxScrollLeft(),
        visibleLeft,
        visibleRight: visibleLeft + activeScrollArea.clientWidth,
        elementLeft: elementRect.left,
        elementRight: elementRect.right,
      });
    }

    function observeFollowLayout(element: HTMLElement | null) {
      const generation = ++followGeneration;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(entries => {
          if (generation !== followGeneration) return;
          const follow = activeFollow;
          if (!follow) return;
          const hasCurrentGeometry = entries.some(({ target }) => target === activeScrollArea
            || target === follow.element
            || target.contains(follow.element)
            || follow.element.contains(target));
          if (hasCurrentGeometry) handleObservedLayout();
        });
        resizeObserver.observe(activeScrollArea);
        let node: Element | null = element;
        while (node && node !== activeScrollArea) {
          resizeObserver.observe(node);
          node = node.parentElement;
        }
      }

      if (element && typeof MutationObserver !== 'undefined') {
        mutationObserver = new MutationObserver(records => {
          if (generation !== followGeneration) return;
          const follow = activeFollow;
          if (!follow) return;
          const hasCurrentMutation = records.some(record => record.target === activeScrollArea
            || record.target.contains(follow.element)
            || follow.element.contains(record.target)
            || [...record.addedNodes, ...record.removedNodes].some(node => node === follow.element
              || node.contains(follow.element)));
          if (hasCurrentMutation) handleObservedLayout();
        });
        mutationObserver.observe(activeScrollArea, { childList: true, subtree: true });
      }
    }

    function handleObservedLayout() {
      if (activeFollow && !manualPointerActive) {
        activeFollow.invalidateGeometry();
        scheduleAnimation();
      }
    }

    function settleFollow(fullyVisible = false) {
      const follow = activeFollow;
      if (!follow) return;

      if (fullyVisible && isFullyVisible(follow.element, follow.margin)) {
        follow.confirmVisible(true);
        return;
      }

      activeFollow = null;
      observeFollowLayout(null);
      follow.cancel();
    }

    function settleOrContinueWhenUnfittable() {
      const follow = activeFollow;
      if (!follow || follow.canFit) return;
      if (Math.abs(targetScrollLeft - activeScrollArea.scrollLeft) >= 0.5) return;
      follow.invalidateGeometry();
      const latestTarget = getFollowTarget(follow);
      if (!latestTarget) return;
      if (latestTarget.alreadyVisible) {
        settleFollow(true);
        return;
      }
      if (follow.canFit) {
        targetScrollLeft = latestTarget.scrollLeft;
        if (Math.abs(targetScrollLeft - activeScrollArea.scrollLeft) >= 0.5) scheduleAnimation();
        return;
      }
      settleFollow(false);
    }

    function suspendFollowForManualInput() {
      suppressFollowUntil = Math.max(suppressFollowUntil, window.performance.now() + 700);
    }

    function stopAnimation() {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      lastFrameTime = null;
      targetScrollLeft = clampScrollLeft(activeScrollArea.scrollLeft);
    }

    function cancelPendingFollow() {
      stopAnimation();
      activeFollow?.cancel(false);
      activeFollow = null;
      observeFollowLayout(null);
      if (deferredFollowTimer !== null) window.clearTimeout(deferredFollowTimer);
      deferredFollowTimer = null;
      deferredFollow = null;
    }

    function cancelDeferredFollow() {
      if (deferredFollowTimer !== null) window.clearTimeout(deferredFollowTimer);
      deferredFollowTimer = null;
      const follow = deferredFollow;
      deferredFollow = null;
      follow?.onSettled?.(false);
    }

    function runDeferredFollow() {
      deferredFollowTimer = null;
      const follow = deferredFollow;
      if (!follow || manualPointerActive) return;

      const remainingDelay = suppressFollowUntil - window.performance.now();
      if (remainingDelay > 0) {
        deferredFollowTimer = window.setTimeout(runDeferredFollow, remainingDelay);
        return;
      }

      deferredFollow = null;
      ensureVisible(follow.element, follow.margin, follow.onSettled);
    }

    function scheduleDeferredFollow() {
      if (!deferredFollow || manualPointerActive || deferredFollowTimer !== null) return;
      const delay = Math.max(0, suppressFollowUntil - window.performance.now());
      deferredFollowTimer = window.setTimeout(runDeferredFollow, delay);
    }

    function deferFollow(follow: StackFollowCompletion) {
      if (deferredFollow && deferredFollow !== follow) {
        deferredFollow.onSettled?.(false);
      }
      deferredFollow = follow;
      scheduleDeferredFollow();
    }

    function animateScroll(timestamp: number) {
      animationFrame = null;
      if (activeScrollArea.hidden || !activeScrollArea.isConnected) {
        lastFrameTime = null;
        settleFollow(false);
        return;
      }

      const follow = activeFollow;
      if (follow) {
        if (!follow.element.isConnected) {
          lastFrameTime = null;
          settleFollow(false);
          return;
        }
        if (isFullyVisible(follow.element, follow.margin)) {
          lastFrameTime = null;
          settleFollow(true);
          return;
        }

        // Re-read the target and viewport on every frame. A viewport or content reflow can
        // invalidate the absolute target captured when the follow began.
        const followTarget = getFollowTarget(follow);
        targetScrollLeft = followTarget?.scrollLeft ?? follow.scrollLeftTarget;
        if (Math.abs(targetScrollLeft - activeScrollArea.scrollLeft) < 0.5) {
          lastFrameTime = null;
          if (!follow.canFit) settleFollow(false);
          return;
        }
      }

      const maxScrollLeft = getMaxScrollLeft();
      targetScrollLeft = clampScrollLeft(targetScrollLeft, maxScrollLeft);
      const currentScrollLeft = activeScrollArea.scrollLeft;

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        writeScrollLeft(targetScrollLeft);
        lastFrameTime = null;
        if (activeFollow && isFullyVisible(activeFollow.element, activeFollow.margin)) settleFollow(true);
        else if (activeFollow && !activeFollow.canFit) settleFollow(false);
        return;
      }

      const elapsed = lastFrameTime === null ? 16 : Math.max(1, Math.min(timestamp - lastFrameTime, 32));
      lastFrameTime = timestamp;
      const progress = 1 - Math.exp(-elapsed / 55);
      const nextScrollLeft = currentScrollLeft + (targetScrollLeft - currentScrollLeft) * progress;

      if (Math.abs(targetScrollLeft - nextScrollLeft) < 0.5) {
        writeScrollLeft(targetScrollLeft);
        lastFrameTime = null;
        if (activeFollow && isFullyVisible(activeFollow.element, activeFollow.margin)) settleFollow(true);
        else settleOrContinueWhenUnfittable();
        return;
      }

      const actualScrollLeft = writeScrollLeft(nextScrollLeft);
      if (Math.abs(targetScrollLeft - actualScrollLeft) < 0.5) {
        if (targetScrollLeft !== actualScrollLeft) writeScrollLeft(targetScrollLeft);
        lastFrameTime = null;
        if (activeFollow && isFullyVisible(activeFollow.element, activeFollow.margin)) settleFollow(true);
        else settleOrContinueWhenUnfittable();
        return;
      }

      if (activeFollow && isFullyVisible(activeFollow.element, activeFollow.margin)) {
        lastFrameTime = null;
        settleFollow(true);
        return;
      }
      settleOrContinueWhenUnfittable();

      animationFrame = window.requestAnimationFrame(animateScroll);
    }

    function scheduleAnimation() {
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(animateScroll);
    }

    function ensureVisible(
      element: HTMLElement,
      margin: number,
      onSettled?: (fullyVisible: boolean) => void,
    ) {
      if (!element.isConnected || activeScrollArea.hidden) {
        stopAnimation();
        settleFollow(false);
        onSettled?.(false);
        return;
      }
      if (manualPointerActive || window.performance.now() < suppressFollowUntil) {
        settleFollow(false);
        deferFollow({ element, margin, onSettled });
        return;
      }

      // A later focus replaces an earlier one. This bounds follow work to the active target.
      settleFollow(false);
      stopAnimation();
      const follow = new StackScrollFollowAnchor(element, margin, onSettled);
      activeFollow = follow;
      observeFollowLayout(element);
      const nextTarget = getFollowTarget(follow);
      targetScrollLeft = nextTarget?.scrollLeft ?? follow.scrollLeftTarget;

      if (nextTarget?.alreadyVisible) {
        lastFrameTime = null;
        settleFollow(true);
        return;
      }

      if (Math.abs(targetScrollLeft - activeScrollArea.scrollLeft) < 0.5) {
        // Keep the follow armed. Resize/mutation/viewport events retry it when geometry changes.
        lastFrameTime = null;
        if (!follow.canFit) settleFollow(false);
        return;
      }

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        writeScrollLeft(targetScrollLeft);
        lastFrameTime = null;
        if (isFullyVisible(element, margin)) settleFollow(true);
        else if (!follow.canFit) settleFollow(false);
        return;
      }

      scheduleAnimation();
    }

    function handleStackWheel(event: WheelEvent) {
      if (!event.cancelable || event.ctrlKey || event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) {
        stopAnimation();
        settleFollow(false);
        cancelDeferredFollow();
        if (event.deltaX !== 0 || event.deltaY !== 0) suspendFollowForManualInput();
        return;
      }

      if (activeScrollArea.hidden) return;

      const maxScrollLeft = getMaxScrollLeft();
      if (maxScrollLeft <= 0) {
        stopAnimation();
        settleFollow(false);
        cancelDeferredFollow();
        suspendFollowForManualInput();
        return;
      }

      let horizontalDelta = event.deltaY;
      if (event.deltaMode === 1) {
        const lineHeight = Number.parseFloat(window.getComputedStyle(activeScrollArea).lineHeight);
        horizontalDelta *= Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 14;
      } else if (event.deltaMode === 2) {
        horizontalDelta *= activeScrollArea.clientWidth;
      }

      const baseTarget = animationFrame === null
        ? activeScrollArea.scrollLeft
        : clampScrollLeft(targetScrollLeft, maxScrollLeft);
      const nextTarget = clampScrollLeft(baseTarget + horizontalDelta, maxScrollLeft);
      if (nextTarget === baseTarget) {
        stopAnimation();
        settleFollow(false);
        cancelDeferredFollow();
        suspendFollowForManualInput();
        return;
      }

      // Manual wheel input takes control of the same animation target.
      suspendFollowForManualInput();
      settleFollow(false);
      cancelDeferredFollow();
      targetScrollLeft = nextTarget;
      // At an edge, let the wheel event bubble so the surrounding page can scroll.
      event.preventDefault();

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
        lastFrameTime = null;
        writeScrollLeft(targetScrollLeft);
        return;
      }

      scheduleAnimation();
    }

    function handleStackScroll() {
      if (animationFrame === null) targetScrollLeft = clampScrollLeft(activeScrollArea.scrollLeft);
    }

    function handleStackPointerDown() {
      cancelDeferredFollow();
      manualPointerActive = true;
      suppressFollowUntil = Number.POSITIVE_INFINITY;
      stopAnimation();
      settleFollow(false);
    }

    function finishManualPointer() {
      if (!manualPointerActive) return;
      manualPointerActive = false;
      suppressFollowUntil = window.performance.now() + 700;
      scheduleDeferredFollow();
    }

    function handleStackPointerUp() {
      if (!manualPointerActive) return;
      finishManualPointer();
    }

    function handleStackTouchEnd() {
      finishManualPointer();
    }

    const controller: StackHorizontalScrollController = { ensureVisible, cancelPendingFollow };
    controllerRef.current = controller;
    observeFollowLayout(null);
    stackSection.addEventListener('wheel', handleStackWheel, { passive: false });
    activeScrollArea.addEventListener('scroll', handleStackScroll);
    activeScrollArea.addEventListener('pointerdown', handleStackPointerDown);
    window.addEventListener('pointerup', handleStackPointerUp);
    window.addEventListener('pointercancel', handleStackPointerUp);
    activeScrollArea.addEventListener('lostpointercapture', handleStackPointerUp);
    activeScrollArea.addEventListener('touchend', handleStackTouchEnd);
    activeScrollArea.addEventListener('touchcancel', handleStackTouchEnd);
    stackSection.addEventListener('transitionend', handleObservedLayout);
    stackSection.addEventListener('animationend', handleObservedLayout);
    window.addEventListener('resize', handleObservedLayout);
    window.visualViewport?.addEventListener('resize', handleObservedLayout);

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      lastFrameTime = null;
      activeFollow?.cancel(false);
      activeFollow = null;
      if (deferredFollowTimer !== null) window.clearTimeout(deferredFollowTimer);
      deferredFollowTimer = null;
      deferredFollow = null;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      if (controllerRef.current === controller) controllerRef.current = null;
      stackSection.removeEventListener('wheel', handleStackWheel);
      activeScrollArea.removeEventListener('scroll', handleStackScroll);
      activeScrollArea.removeEventListener('pointerdown', handleStackPointerDown);
      window.removeEventListener('pointerup', handleStackPointerUp);
      window.removeEventListener('pointercancel', handleStackPointerUp);
      activeScrollArea.removeEventListener('lostpointercapture', handleStackPointerUp);
      activeScrollArea.removeEventListener('touchend', handleStackTouchEnd);
      activeScrollArea.removeEventListener('touchcancel', handleStackTouchEnd);
      stackSection.removeEventListener('transitionend', handleObservedLayout);
      stackSection.removeEventListener('animationend', handleObservedLayout);
      window.removeEventListener('resize', handleObservedLayout);
      window.visualViewport?.removeEventListener('resize', handleObservedLayout);
    };
  }, [expanded]);

  const ensureVisible = useCallback((
    element: HTMLElement,
    margin = 12,
    onSettled?: (fullyVisible: boolean) => void,
  ) => {
    const controller = controllerRef.current;
    if (controller) controller.ensureVisible(element, margin, onSettled);
    else onSettled?.(false);
  }, []);

  const cancelPendingFollow = useCallback(() => {
    controllerRef.current?.cancelPendingFollow();
  }, []);

  return { stackSectionRef, stackScrollRef, ensureVisible, cancelPendingFollow };
}
