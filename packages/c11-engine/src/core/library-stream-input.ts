import type { CType, CValue, Location } from './internal.ts';
import type { VirtualStream } from './virtual-io.ts';
import type { LibraryRuntimeContext, ResumableLibraryBuiltin } from './library.ts';
import type { LibraryBuiltinRequest } from './library-requests.ts';
import {
  EOF_VALUE, ERRNO, STREAM_READ_CHUNK_BYTES, argCount, checkedSize,
  integerValue, invalid, returnInteger, returnPointer, writeBytes,
} from './library-common.ts';

function* readStreamByte(stream: VirtualStream, at: Location): Generator<LibraryBuiltinRequest, number, CValue | void> {
  while (true) {
    const result = stream.readByteResult(at);
    if (result.kind === 'pending') {
      yield { kind: 'input-needed' };
      continue;
    }
    return result.kind === 'byte' ? result.value : EOF_VALUE;
  }
}

export function* streamInputBuiltin(
  name: string,
  args: readonly CValue[],
  resultType: CType | undefined,
  context: LibraryRuntimeContext,
  at: Location,
): ResumableLibraryBuiltin {
  const requireStream = (file: CValue): VirtualStream => {
    const stream = context.streamFor(file, at);
    if (!stream) { context.errno.set(ERRNO.EBADF); invalid(context, `${name} requires a valid FILE stream.`, at); }
    return stream;
  };
  const eof = (): CValue => returnInteger(EOF_VALUE, resultType, context);
  if (name === 'getchar' || name === 'fgetc' || name === 'getc') {
    argCount(args, name === 'getchar' ? 0 : 1, name === 'getchar' ? 0 : 1, name, context, at);
    const stream = name === 'getchar' ? context.io.stdin : requireStream(args[0]);
    const byte = yield* readStreamByte(stream, at);
    return byte < 0 ? eof() : returnInteger(byte, resultType, context);
  }
  if (name === 'fgets') {
    argCount(args, 3, 3, name, context, at);
    const count = Number(integerValue(args[1], at, context));
    const stream = requireStream(args[2]);
    if (count <= 0) return { type: resultType ?? args[0].type, value: null };
    const bytes: number[] = [];
    while (bytes.length < count - 1) {
      context.chargeWork(1, at);
      const byte = yield* readStreamByte(stream, at);
      if (byte < 0) break;
      bytes.push(byte);
      if (byte === 10) break;
    }
    if (!bytes.length) return { type: resultType ?? args[0].type, value: null };
    const output = new Uint8Array(bytes.length + 1); output.set(bytes);
    writeBytes(args[0], output, at, context);
    return returnPointer(args[0], resultType);
  }
  if (name === 'fread') {
    argCount(args, 4, 4, name, context, at);
    const size = checkedSize(args[1], name, context, at), count = checkedSize(args[2], name, context, at);
    if (!size || !count) return returnInteger(0, resultType, context);
    if (count > Math.floor(Number.MAX_SAFE_INTEGER / size)) invalid(context, `${name} requested an unrepresentable size.`, at);
    const requested = size * count;
    const stream = requireStream(args[3]);
    const chunks: Uint8Array[] = [];
    let chunk: Uint8Array | undefined;
    let chunkLength = 0;
    let bytesRead = 0;
    while (bytesRead < requested) {
      if (!chunk) chunk = new Uint8Array(Math.min(STREAM_READ_CHUNK_BYTES, requested - bytesRead));
      const read = stream.readAvailableInto(chunk, chunkLength, chunk.length - chunkLength, at);
      if (read > 0) {
        chunkLength += read;
        bytesRead += read;
        if (chunkLength === chunk.length) {
          chunks.push(chunk);
          chunk = undefined;
          chunkLength = 0;
        }
        continue;
      }
      const next = stream.readByteResult(at);
      if (next.kind === 'pending') {
        yield { kind: 'input-needed' };
        continue;
      }
      if (next.kind === 'eof') break;
      chunk[chunkLength++] = next.value;
      bytesRead++;
      if (chunkLength === chunk.length) {
        chunks.push(chunk);
        chunk = undefined;
        chunkLength = 0;
      }
    }
    if (bytesRead) {
      context.preflightMemoryWrite(args[0], bytesRead, at);
      context.chargeWork(bytesRead, at);
      let offset = 0;
      for (const bytes of chunks) {
        context.writeBytes(context.offsetPointer(args[0], offset, at), bytes, at);
        offset += bytes.length;
      }
      if (chunkLength && chunk) context.writeBytes(context.offsetPointer(args[0], offset, at), chunk.subarray(0, chunkLength), at);
    }
    return returnInteger(Math.floor(bytesRead / size), resultType, context);
  }
  return context.fail('ENGINE_INTERNAL_ERROR', `Stream read «${name}» is not recognized.`, at);
}
