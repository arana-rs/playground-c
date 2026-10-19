import type { CType, CValue, Location } from './internal.ts';
import { dispatchStdlibConversionBuiltin } from './stdlib-conversions.ts';
import { dispatchStdlibBuiltin } from './stdlib-library.ts';
import { dispatchTimeBuiltin } from './time-library.ts';
import type { StdlibTimeRuntimeContext } from './stdlib-time-context.ts';
import type { VirtualIO, VirtualStream } from './virtual-io.ts';
import type { LibraryBuiltinGenerator } from './library-requests.ts';
import { dispatchFileBuiltin } from './library-files.ts';
import { dispatchFormatBuiltin } from './library-format.ts';
import { dispatchMemoryBuiltin } from './library-memory.ts';
import { dispatchStreamBuiltin } from './library-streams.ts';
import { argCount, cString, decodeUtf8, integerValue, returnPointer } from './library-common.ts';

export type ResumableLibraryBuiltin = LibraryBuiltinGenerator;
export type LibraryBuiltinResult = CValue | ResumableLibraryBuiltin;

/** Runtime services supplied by execute.ts; no host I/O or DOM APIs cross this boundary. */
export interface LibraryRuntimeContext {
  readonly at: Location;
  readonly io: VirtualIO;
  readBytes(pointer: CValue, count: number, at: Location): Uint8Array;
  writeBytes(pointer: CValue, bytes: Uint8Array, at: Location): void;
  readCString(pointer: CValue, at: Location, maxBytes?: number): Uint8Array;
  copyBytes(destination: CValue, source: CValue, count: number, at: Location): void;
  writeScalar(pointer: CValue, value: CValue, at: Location): void;
  formatPointer(value: CValue, at: Location): string;
  /** Converts only pointer spellings the selected VM profile can round-trip safely. */
  parsePointer?(text: string, at: Location): CValue;
  openFile(path: string, mode: string, at: Location): CValue | null;
  streamFor(file: CValue, at: Location): VirtualStream | null;
  standardFile(kind: 'stdin' | 'stdout' | 'stderr', at: Location): CValue;
  makeFilePointer(stream: VirtualStream, at: Location): CValue;
  closeFilePointer(file: CValue, at: Location): number;
  /** Fetch and consume a live va_list for a standard v* routine. */
  consumeVaList(list: CValue, at: Location): readonly CValue[];
  /** Reopen a stream in place, preserving the FILE* value and standard-stream binding. */
  reopenFilePointer(file: CValue, path: string | null, mode: string, at: Location): CValue | null;
  errno: { get(): number; set(value: number): void };
  makeErrnoPointer(): CValue;
  makeInt(value: bigint | number, type?: CType): CValue;
  chargeWork(count: number, at: Location): void;
  /** Checks a planned temporary/formatted output before allocating it. */
  preflightOutputBytes(count: number, at: Location): void;
  /** Checks the destination object before a library routine materializes a write. */
  preflightMemoryWrite(pointer: CValue, count: number, at: Location): void;
  offsetPointer(pointer: CValue, byteOffset: number, at: Location): CValue;
  makeString(bytes: Uint8Array, at: Location): CValue;
  fail(code: string, message: string, at: Location): never;
}

/**
 * Handle a P4 library routine. Returning undefined lets execute.ts continue to
 * the existing VM intrinsic dispatcher (malloc/free and numeric builtins).
 */
export function dispatchLibraryBuiltin(
  name: string,
  args: readonly CValue[],
  resultType: CType | undefined,
  context: StdlibTimeRuntimeContext,
): LibraryBuiltinResult | undefined {
  const at = context.at;
  const conversion = dispatchStdlibConversionBuiltin(name, args, resultType, context);
  if (conversion !== undefined) return conversion;
  const stdlib = dispatchStdlibBuiltin(name, args, resultType, context);
  if (stdlib !== undefined) return stdlib;
  const time = dispatchTimeBuiltin(name, args, resultType, context);
  if (time !== undefined) return time;
  if (name === '__c11_nan' || name === '__c11_inf') {
    argCount(args, 0, 0, name, context, at);
    return { type: resultType ?? 'float', value: name === '__c11_nan' ? NaN : Infinity };
  }
  if (name === '__c11_stdin' || name === '__c11_stdout' || name === '__c11_stderr') {
    argCount(args, 0, 0, name, context, at);
    const kind = name === '__c11_stdin' ? 'stdin' : name === '__c11_stdout' ? 'stdout' : 'stderr';
    return returnPointer(context.standardFile(kind, at), resultType);
  }
  if (name === '__c11_errno_location') {
    argCount(args, 0, 0, name, context, at);
    return returnPointer(context.makeErrnoPointer(), resultType);
  }
  if (name === '__c11_assert_fail') {
    argCount(args, 3, 3, name, context, at);
    const expression = decodeUtf8(cString(args[0], at, context));
    const file = decodeUtf8(cString(args[1], at, context));
    const line = integerValue(args[2], at, context);
    return context.fail('ASSERTION_FAILED', `assert(${expression}) failed at ${file}:${line}.`, at);
  }
  const memory = dispatchMemoryBuiltin(name, args, resultType, context);
  if (memory !== undefined) return memory;
  const file = dispatchFileBuiltin(name, args, resultType, context);
  if (file !== undefined) return file;
  const formatted = dispatchFormatBuiltin(name, args, resultType, context);
  if (formatted !== undefined) return formatted;
  return dispatchStreamBuiltin(name, args, resultType, context);
}
