import type { CType, CValue, Location } from './internal.ts';
import { STDIO_CONSTANTS } from './stdio-metadata.ts';
import type { VirtualBufferMode, VirtualStream } from './virtual-io.ts';
import type { LibraryRuntimeContext, LibraryBuiltinResult } from './library.ts';
import { streamInputBuiltin } from './library-stream-input.ts';
import {
  EOF_VALUE, ERRNO, argCount, checkedSize, cString, decodeUtf8, eofMinusOne,
  errorMessage, integerValue, invalid, pointerValue, returnInteger, returnVoid,
} from './library-common.ts';

function streamBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  const requireStream = (file: CValue): VirtualStream => {
    const stream = context.streamFor(file, at);
    if (!stream) { context.errno.set(ERRNO.EBADF); invalid(context, `${name} requires a valid FILE stream.`, at); }
    return stream;
  };
  const eof = (): CValue => returnInteger(EOF_VALUE, resultType, context);
  const configureBuffering = (stream: VirtualStream, bufferValue: CValue, modeValue: bigint, sizeValue: bigint): boolean => {
    if (modeValue < 0n || modeValue > 2n) {
      context.errno.set(ERRNO.EINVAL);
      return false;
    }
    const mode = Number(modeValue) as VirtualBufferMode;
    let capacity = 0;
    if (mode !== 2) {
      if (sizeValue <= 0n || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) {
        context.errno.set(ERRNO.EINVAL);
        return false;
      }
      const buffer = pointerValue(bufferValue, at, context, true);
      if (buffer.value !== null) {
        try {
          context.preflightMemoryWrite(buffer, Number(sizeValue), at);
        } catch {
          context.errno.set(ERRNO.EINVAL);
          return false;
        }
      }
      capacity = Number(sizeValue);
    }
    if (!stream.setBuffering(mode, capacity, at)) {
      context.errno.set(ERRNO.EINVAL);
      return false;
    }
    return true;
  };
  if (name === 'fclose') {
    argCount(args, 1, 1, name, context, at);
    const result = context.closeFilePointer(args[0], at);
    if (result === -1) context.errno.set(ERRNO.EBADF);
    else if (result < -1) { context.errno.set(ERRNO.EIO); return eofMinusOne(resultType, context); }
    return returnInteger(result, resultType, context);
  }
  if (name === 'fflush') {
    argCount(args, 0, 1, name, context, at);
    if (!args.length || args[0].value === null) {
      const flushed = context.io.flushAllOutputStreams(at);
      if (!flushed) { context.errno.set(ERRNO.EIO); return eofMinusOne(resultType, context); }
      return returnInteger(0, resultType, context);
    }
    const stream = context.streamFor(args[0], at);
    if (!stream || stream.isClosed) { context.errno.set(ERRNO.EBADF); return eofMinusOne(resultType, context); }
    if (!stream.flush(at)) { context.errno.set(ERRNO.EIO); return eofMinusOne(resultType, context); }
    return returnInteger(0, resultType, context);
  }
  if (name === 'fputc' || name === 'putc' || name === 'putchar') {
    argCount(args, name === 'putchar' ? 1 : 2, name === 'putchar' ? 1 : 2, name, context, at);
    const value = Number(BigInt.asUintN(8, integerValue(args[0], at, context)));
    const stream = name === 'putchar' ? context.io.stdout : requireStream(args[1]);
    const written = stream.writeBytes(new Uint8Array([value]), at);
    return written === 1 ? returnInteger(value, resultType, context) : eof();
  }
  if (name === 'fputs' || name === 'puts') {
    argCount(args, 1 + (name === 'fputs' ? 1 : 0), 1 + (name === 'fputs' ? 1 : 0), name, context, at);
    const bytes = cString(args[0], at, context);
    const stream = name === 'puts' ? context.io.stdout : requireStream(args[1]);
    const needsNewline = name === 'puts';
    const output = needsNewline ? new Uint8Array(bytes.length + 1) : bytes;
    if (needsNewline) { output.set(bytes); output[bytes.length] = 10; }
    context.preflightOutputBytes(output.length, at);
    const written = stream.writeBytes(output, at);
    if (written !== output.length) { context.errno.set(ERRNO.EIO); return eofMinusOne(resultType, context); }
    return returnInteger(name === 'puts' ? bytes.length + 1 : 0, resultType, context);
  }
  if (name === 'fwrite') {
    argCount(args, 4, 4, name, context, at);
    const size = checkedSize(args[1], name, context, at), count = checkedSize(args[2], name, context, at);
    if (!size || !count) return returnInteger(0, resultType, context);
    if (count > Math.floor(Number.MAX_SAFE_INTEGER / size)) invalid(context, `${name} requested an unrepresentable size.`, at);
    const requested = size * count;
    const stream = requireStream(args[3]);
    context.preflightOutputBytes(requested, at);
    context.chargeWork(requested, at);
    const bytes = context.readBytes(args[0], requested, at);
    const written = stream.writeBytes(bytes, at);
    return returnInteger(Math.floor(written / size), resultType, context);
  }
  if (name === 'fseek') {
    argCount(args, 3, 3, name, context, at);
    const stream = requireStream(args[0]);
    stream.markOperation();
    const offset = integerValue(args[1], at, context);
    const originValue = Number(integerValue(args[2], at, context));
    if (originValue < 0 || originValue > 2 || !stream.seek(offset, originValue as 0 | 1 | 2, at)) {
      context.errno.set(ERRNO.EINVAL); return eofMinusOne(resultType, context);
    }
    return returnInteger(0, resultType, context);
  }
  if (name === 'ftell') {
    argCount(args, 1, 1, name, context, at);
    const stream = requireStream(args[0]);
    const position = stream.tell();
    if (position < 0) { context.errno.set(ERRNO.EIO); return returnInteger(-1, resultType, context); }
    return returnInteger(position, resultType, context);
  }
  if (name === 'rewind') {
    argCount(args, 1, 1, name, context, at);
    const stream = requireStream(args[0]);
    if (!stream.seek(0, 0, at)) context.errno.set(ERRNO.EIO);
    else stream.clearError();
    return returnVoid();
  }
  if (name === 'fgetpos') {
    argCount(args, 2, 2, name, context, at);
    const stream = context.streamFor(args[0], at);
    if (!stream) { context.errno.set(ERRNO.EBADF); return returnInteger(1, resultType, context); }
    const position = stream.tell();
    if (position < 0) { context.errno.set(ERRNO.EIO); return returnInteger(1, resultType, context); }
    context.writeScalar(args[1], context.makeInt(position, 'long'), at);
    return returnInteger(0, resultType, context);
  }
  if (name === 'fsetpos') {
    argCount(args, 2, 2, name, context, at);
    const stream = context.streamFor(args[0], at);
    if (!stream) { context.errno.set(ERRNO.EBADF); return returnInteger(1, resultType, context); }
    stream.markOperation();
    const bytes = context.readBytes(args[1], 8, at);
    let encoded = 0n;
    for (let index = bytes.length - 1; index >= 0; index--) encoded = encoded << 8n | BigInt(bytes[index]);
    const position = BigInt.asIntN(64, encoded);
    if (position < 0n || !stream.seek(position, 0, at)) {
      context.errno.set(ERRNO.EINVAL);
      return returnInteger(1, resultType, context);
    }
    return returnInteger(0, resultType, context);
  }
  if (name === 'setbuf') {
    argCount(args, 2, 2, name, context, at);
    const stream = requireStream(args[0]);
    const buffer = pointerValue(args[1], at, context, true);
    const mode = buffer.value === null ? 2n : 0n;
    const size = buffer.value === null ? 0n : BigInt(STDIO_CONSTANTS.BUFSIZ);
    configureBuffering(stream, buffer, mode, size);
    return returnVoid();
  }
  if (name === 'setvbuf') {
    argCount(args, 4, 4, name, context, at);
    const stream = requireStream(args[0]);
    const mode = integerValue(args[2], at, context);
    const size = integerValue(args[3], at, context);
    return returnInteger(configureBuffering(stream, args[1], mode, size) ? 0 : 1, resultType, context);
  }
  if (name === 'ungetc') {
    argCount(args, 2, 2, name, context, at);
    const byte = Number(integerValue(args[0], at, context));
    const stream = requireStream(args[1]);
    if (byte === EOF_VALUE) { stream.markOperation(); return eof(); }
    return stream.ungetByte(Number(BigInt.asUintN(8, BigInt(byte))), at) ? returnInteger(Number(BigInt.asUintN(8, BigInt(byte))), resultType, context) : eof();
  }
  if (name === 'feof' || name === 'ferror') {
    argCount(args, 1, 1, name, context, at);
    const stream = requireStream(args[0]);
    return returnInteger(name === 'feof' ? stream.eof ? 1 : 0 : stream.error ? 1 : 0, resultType, context);
  }
  if (name === 'clearerr') {
    argCount(args, 1, 1, name, context, at);
    requireStream(args[0]).clearError();
    return returnVoid();
  }
  if (name === 'perror') {
    argCount(args, 1, 1, name, context, at);
    const prefix = args[0].value === null ? new Uint8Array() : cString(args[0], at, context);
    const code = context.errno.get();
    const message = errorMessage(code);
    const text = new TextEncoder().encode(`${args[0].value === null ? '' : `${decodeUtf8(prefix)}: `}${message}\n`);
    context.preflightOutputBytes(text.length, at);
    context.io.stderr.writeBytes(text, at);
    return returnVoid();
  }
  return undefined as never;
}
export function dispatchStreamBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext): LibraryBuiltinResult | undefined {
  if (['fgetc', 'getc', 'getchar', 'fgets', 'fread'].includes(name)) {
    return streamInputBuiltin(name, args, resultType, context, context.at);
  }
  if (['fclose', 'fflush', 'fputc', 'putc', 'putchar', 'fputs', 'puts', 'fwrite', 'fseek', 'ftell', 'fgetpos', 'fsetpos', 'rewind', 'ungetc', 'feof', 'ferror', 'clearerr', 'perror', 'setbuf', 'setvbuf'].includes(name)) {
    return streamBuiltin(name, args, resultType, context, context.at);
  }
  return undefined;
}
