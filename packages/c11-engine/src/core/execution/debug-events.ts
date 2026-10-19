import type { DebugEvent } from '../types.ts';
import type { Location } from '../internal.ts';

export type PendingDebugEvent = DebugEvent extends infer Event
  ? Event extends DebugEvent ? Omit<Event, 'sequence'> : never
  : never;

export class DebugEventCollector {
  private readonly pending: DebugEvent[] = [];
  private nextSequence = 1;
  private reserved = 0;
  private used = 0;

  constructor(private readonly maxEvents: number) {}

  reserve(location: Location): void {
    if (this.used + 1 > this.maxEvents) throw new DebugEventLimit(location, this.maxEvents);
    this.used++;
    this.reserved++;
  }

  reserveMany(count: number, location: Location): void {
    let completed = 0;
    try {
      for (; completed < count; completed++) this.reserve(location);
    } catch (error) {
      this.cancelMany(completed);
      throw error;
    }
  }

  cancel(): void { this.cancelMany(1); }

  cancelMany(count: number): void {
    this.reserved -= count;
    this.used -= count;
  }

  commit(event: PendingDebugEvent): void {
    this.reserved--;
    this.pending.push(Object.freeze({
      ...event,
      sequence: this.nextSequence++,
      location: Object.freeze({ ...event.location }),
    }) as DebugEvent);
  }

  record(event: PendingDebugEvent): void {
    this.reserve(event.location);
    this.commit(event);
  }

  drain(): readonly DebugEvent[] {
    const events = this.pending.splice(0);
    return Object.freeze(events);
  }
}

export class DebugEventLimit extends Error {
  constructor(readonly location: Location, readonly limit: number) {
    super(`maxDebugEvents limit exceeded: ${limit}.`);
  }
}
