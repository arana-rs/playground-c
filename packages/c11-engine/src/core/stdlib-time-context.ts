import type { LibraryRuntimeContext } from './library.ts';
import type { CValue, CType, ObjectPointerValue } from './internal.ts';

export interface VirtualCalendarTime {
  readonly seconds: bigint;
  readonly nanoseconds: bigint;
}

/** Default epoch for deterministic core-only sessions: 2024-01-01T00:00:00Z. */
export const DEFAULT_CALENDAR_TIME: VirtualCalendarTime = Object.freeze({ seconds: 1_704_067_200n, nanoseconds: 0n });
export const NANOSECONDS_PER_SECOND = 1_000_000_000n;

const MILLISECONDS_PER_SECOND = 1_000n;

export function calendarTimeFromEpochMilliseconds(milliseconds: bigint): VirtualCalendarTime {
  let seconds = milliseconds / MILLISECONDS_PER_SECOND;
  let remainder = milliseconds % MILLISECONDS_PER_SECOND;
  if (remainder < 0n) {
    seconds -= 1n;
    remainder += MILLISECONDS_PER_SECOND;
  }
  return { seconds, nanoseconds: remainder * (NANOSECONDS_PER_SECOND / MILLISECONDS_PER_SECOND) };
}

/** Mutable state shared by every builtin call in one VM execution. */
export interface StdlibSessionState {
  randState: number;
  tmBuffer?: CValue;
  textBuffer?: CValue;
  textBufferCapacity: number;
  readonly environmentBuffers: Map<string, CValue>;
}

/** Runtime-only services used by the new standard-library modules. */
export interface StdlibTimeRuntimeContext extends LibraryRuntimeContext {
  readonly stdlibState: StdlibSessionState;
  readonly environment?: Readonly<Record<string, string>>;
  readonly currentCalendarTime?: () => VirtualCalendarTime;
  readonly clockTicks?: () => bigint;
  readonly allocateStaticObject?: (type: CType, at: LibraryRuntimeContext['at']) => CValue;
  readonly allocateHeap?: (size: number, at: LibraryRuntimeContext['at']) => ObjectPointerValue | null;
  readonly allocateHeapAligned?: (size: number, alignment: number, at: LibraryRuntimeContext['at']) => ObjectPointerValue | null;
  readonly zeroHeap?: (pointer: ObjectPointerValue, size: number, at: LibraryRuntimeContext['at']) => void;
  /** Swaps complete object representations while retaining pointer provenance/type metadata. */
  readonly swapObjectBytes?: (left: ObjectPointerValue, right: ObjectPointerValue, size: number, at: LibraryRuntimeContext['at']) => void;
}

export function virtualCalendarTime(context: StdlibTimeRuntimeContext): VirtualCalendarTime {
  return context.currentCalendarTime?.() ?? DEFAULT_CALENDAR_TIME;
}

export function virtualClockTicks(context: StdlibTimeRuntimeContext): bigint {
  return context.clockTicks?.() ?? 0n;
}
