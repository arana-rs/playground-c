export interface MemoryViewerTimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimeoutScheduler: MemoryViewerTimeoutScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Owns at most one temporary exit cleanup timer and makes replacement/cancellation explicit. */
export class MemoryViewerExitCleanupTimer {
  private handle: unknown = null;
  private readonly scheduler: MemoryViewerTimeoutScheduler;

  constructor(scheduler: MemoryViewerTimeoutScheduler = defaultTimeoutScheduler) {
    this.scheduler = scheduler;
  }

  schedule(callback: () => void, delayMs: number): void {
    this.clear();
    let scheduledHandle: unknown = null;
    scheduledHandle = this.scheduler.setTimeout(() => {
      if (this.handle !== scheduledHandle) return;
      this.handle = null;
      callback();
    }, Math.max(0, delayMs));
    this.handle = scheduledHandle;
  }

  clear(): void {
    if (this.handle === null) return;
    this.scheduler.clearTimeout(this.handle);
    this.handle = null;
  }
}

export function readMemoryViewerExitDuration(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): number {
  const rawDuration = style.getPropertyValue('--memory-viewer-exit-duration').trim();
  const duration = Number.parseFloat(rawDuration);
  if (!Number.isFinite(duration) || duration < 0) return 220;
  return rawDuration.endsWith('ms') ? duration : duration * 1000;
}
