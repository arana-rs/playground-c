import type { CType, CValue, Location } from './internal.ts';
import type { VirtualIO } from './virtual-io.ts';
import type { LibraryRuntimeContext } from './library.ts';
import { isValidVirtualOpenMode } from './virtual-io.ts';
import { normalizeVirtualPath } from './virtual-path.ts';
import { ERRNO, argCount, cString, decodeUtf8, returnInteger, returnPointer, writeBytes } from './library-common.ts';

const tmpnamBuffers = new WeakMap<VirtualIO, CValue>();

function fopenBuiltin(args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  argCount(args, 2, 2, 'fopen', context, at);
  const path = decodeUtf8(cString(args[0], at, context));
  const mode = decodeUtf8(cString(args[1], at, context));
  if (!isValidVirtualOpenMode(mode) || !normalizeVirtualPath(path)) {
    context.errno.set(ERRNO.EINVAL);
    return { type: resultType ?? args[0].type, value: null };
  }
  const file = context.openFile(path, mode, at);
  if (!file) context.errno.set(mode.endsWith('x') && context.io.hasFile(path) ? ERRNO.EEXIST : ERRNO.ENOENT);
  return file ? returnPointer(file, resultType) : { type: resultType ?? args[0].type, value: null };
}

function freopenBuiltin(args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  argCount(args, 3, 3, 'freopen', context, at);
  const path = args[0].value === null ? null : decodeUtf8(cString(args[0], at, context));
  const mode = decodeUtf8(cString(args[1], at, context));
  if (!isValidVirtualOpenMode(mode)) {
    context.errno.set(ERRNO.EINVAL);
    return { type: resultType ?? args[2].type, value: null };
  }
  const existed = path !== null && context.io.hasFile(path);
  const file = context.reopenFilePointer(args[2], path, mode, at);
  if (!file) context.errno.set(mode.endsWith('x') && existed ? ERRNO.EEXIST : path === null ? ERRNO.EINVAL : ERRNO.ENOENT);
  return file ? returnPointer(file, resultType) : { type: resultType ?? args[2].type, value: null };
}

function fileOperationBuiltin(name: 'remove' | 'rename', args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  if (name === 'remove') {
    argCount(args, 1, 1, name, context, at);
    const path = decodeUtf8(cString(args[0], at, context));
    const existed = context.io.hasFile(path);
    const success = context.io.removeFile(path, at);
    if (!success) context.errno.set(existed ? ERRNO.EBUSY : ERRNO.ENOENT);
    return returnInteger(success ? 0 : -1, resultType, context);
  }
  argCount(args, 2, 2, name, context, at);
  const oldPath = decodeUtf8(cString(args[0], at, context));
  const newPath = decodeUtf8(cString(args[1], at, context));
  const sourceExists = context.io.hasFile(oldPath), destinationExists = context.io.hasFile(newPath);
  const success = context.io.renameFile(oldPath, newPath);
  if (!success) context.errno.set(!sourceExists ? ERRNO.ENOENT : destinationExists ? ERRNO.EEXIST : ERRNO.EBUSY);
  return returnInteger(success ? 0 : -1, resultType, context);
}

function tmpnamBuiltin(args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext, at: Location): CValue {
  argCount(args, 1, 1, 'tmpnam', context, at);
  const name = context.io.nextTemporaryName();
  if (!name) return { type: resultType ?? args[0].type, value: null };
  const bytes = new TextEncoder().encode(`${name}\0`);
  if (args[0].value === null) {
    let buffer = tmpnamBuffers.get(context.io);
    if (!buffer) {
      buffer = context.makeString(bytes.subarray(0, -1), at);
      tmpnamBuffers.set(context.io, buffer);
    } else writeBytes(buffer, bytes, at, context);
    return returnPointer(buffer, resultType);
  }
  writeBytes(args[0], bytes, at, context);
  return returnPointer(args[0], resultType);
}
export function dispatchFileBuiltin(name: string, args: readonly CValue[], resultType: CType | undefined, context: LibraryRuntimeContext): CValue | undefined {
  const at = context.at;
  if (name === 'remove' || name === 'rename') return fileOperationBuiltin(name, args, resultType, context, at);
  if (name === 'tmpfile') {
    argCount(args, 0, 0, name, context, at);
    return returnPointer(context.makeFilePointer(context.io.openTemporaryFile(at), at), resultType);
  }
  if (name === 'tmpnam') return tmpnamBuiltin(args, resultType, context, at);
  if (name === 'fopen') return fopenBuiltin(args, resultType, context, at);
  if (name === 'freopen') return freopenBuiltin(args, resultType, context, at);
  return undefined;
}
