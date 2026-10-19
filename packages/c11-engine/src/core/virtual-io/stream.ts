import { VirtualIOError } from './errors.ts';
import type { VirtualIO, VirtualLocation } from '../virtual-io.ts';

export interface FileState { data: Uint8Array; openCount: number }
type StreamKind = 'stdin' | 'stdout' | 'stderr' | 'file';
export type VirtualStreamKind = StreamKind;
export type VirtualSeekOrigin = 0 | 1 | 2;
export type VirtualBufferMode = 0 | 1 | 2;
export type VirtualByteRead = { readonly kind: 'byte'; readonly value: number } | { readonly kind: 'eof' } | { readonly kind: 'pending' };

/** Byte-oriented C stream backed only by session-local virtual memory. */
export class VirtualStream {
  private cursor = 0;
  private pushedByte: number | undefined;
  private pushedConsumesPosition = false;
  private eofFlag = false;
  private errorFlag = false;
  private closed = false;
  private bufferingMode: VirtualBufferMode = 2;
  private bufferingCapacity = 0;
  private operationPerformed = false;
  private lastOperation: 'read' | 'write' | null = null;
  private readAfterWriteAllowed = false;
  private pendingOutputChunks: Uint8Array[] = [];
  private pendingOutputLength = 0;
  private pendingOutputStart: number | undefined;

  constructor(
    readonly kind: StreamKind,
    private readonly owner: VirtualIO,
    private readonly state: FileState,
    readonly canRead: boolean,
    readonly canWrite: boolean,
    private readonly append = false,
    initialAtEnd = false,
    private readonly onClose?: () => void,
  ) {
    if (initialAtEnd) this.cursor = state.data.length;
    owner.registerStream(this);
  }

  get eof(): boolean { this.operationPerformed = true; return this.eofFlag; }
  get error(): boolean { this.operationPerformed = true; return this.errorFlag; }
  get isClosed(): boolean { return this.closed; }
  get canSetBuffering(): boolean { return !this.closed && !this.operationPerformed; }
  get bufferMode(): VirtualBufferMode { return this.bufferingMode; }

  markOperation(): void { this.operationPerformed = true; }

  readByte(at: VirtualLocation): number {
    const result = this.readByteResult(at);
    if (result.kind === 'pending') throw new VirtualIOError('INPUT_PENDING', 'Reading stdin requires more input.');
    return result.kind === 'byte' ? result.value : -1;
  }

  /** Read without conflating temporary input exhaustion with EOF. */
  readByteResult(at: VirtualLocation): VirtualByteRead {
    if (!this.beginRead(at)) return { kind: 'eof' };
    if (this.pushedByte !== undefined) {
      const value = this.pushedByte;
      this.pushedByte = undefined;
      if (this.pushedConsumesPosition) this.cursor++;
      this.pushedConsumesPosition = false;
      this.eofFlag = false;
      return { kind: 'byte', value };
    }
    if (this.cursor >= this.state.data.length) {
      if (this.kind === 'stdin' && this.owner.stdinOpen) return { kind: 'pending' };
      this.eofFlag = true;
      this.readAfterWriteAllowed = false;
      void at;
      return { kind: 'eof' };
    }
    void at;
    this.eofFlag = false;
    this.readAfterWriteAllowed = false;
    return { kind: 'byte', value: this.state.data[this.cursor++] };
  }

  readBytes(length: number, at: VirtualLocation): Uint8Array {
    if (!this.beginRead(at)) return new Uint8Array();
    if (!Number.isSafeInteger(length) || length < 0) { this.errorFlag = true; return new Uint8Array(); }
    const result = new Uint8Array(Math.min(length, this.availableBytes()));
    let read = 0;
    if (this.pushedByte !== undefined && result.length) {
      result[read++] = this.pushedByte;
      this.pushedByte = undefined;
      if (this.pushedConsumesPosition) this.cursor++;
      this.pushedConsumesPosition = false;
      this.eofFlag = false;
    }
    const count = Math.min(result.length - read, this.state.data.length - this.cursor);
    if (count > 0) {
      result.set(this.state.data.subarray(this.cursor, this.cursor + count), read);
      this.cursor += count;
      read += count;
    }
    if (read < length && !(this.kind === 'stdin' && this.owner.stdinOpen)) this.eofFlag = true;
    else if (read > 0) this.eofFlag = false;
    if (this.eofFlag) this.readAfterWriteAllowed = false;
    void at;
    return read === result.length ? result : result.slice(0, read);
  }

  /** Read only bytes currently available, without treating open stdin as EOF. */
  readAvailableInto(target: Uint8Array, offset: number, length: number, at: VirtualLocation): number {
    this.operationPerformed = true;
    if (!(target instanceof Uint8Array) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset + length > target.length) {
      this.errorFlag = true;
      return 0;
    }
    if (!this.beginRead(at)) return 0;
    const count = Math.min(length, this.availableBytes());
    let read = 0;
    if (this.pushedByte !== undefined && count > 0) {
      target[offset + read++] = this.pushedByte;
      this.pushedByte = undefined;
      if (this.pushedConsumesPosition) this.cursor++;
      this.pushedConsumesPosition = false;
    }
    const fromState = Math.min(count - read, this.state.data.length - this.cursor);
    if (fromState > 0) {
      target.set(this.state.data.subarray(this.cursor, this.cursor + fromState), offset + read);
      this.cursor += fromState;
      read += fromState;
    }
    if (read > 0) {
      this.eofFlag = false;
      this.readAfterWriteAllowed = false;
    }
    if (read < length && !(this.kind === 'stdin' && this.owner.stdinOpen)) {
      this.eofFlag = true;
      this.readAfterWriteAllowed = false;
    }
    void at;
    return read;
  }

  ungetByte(byte: number, at: VirtualLocation): boolean {
    this.operationPerformed = true;
    if (!this.readyForRead()) return false;
    if (!Number.isInteger(byte) || byte < 0 || byte > 255 || this.pushedByte !== undefined) return false;
    if (this.canWrite && this.lastOperation === 'write' && !this.readAfterWriteAllowed) {
      this.errorFlag = true;
      return false;
    }
    this.pushedByte = byte;
    this.pushedConsumesPosition = this.cursor > 0;
    if (this.pushedConsumesPosition) this.cursor--;
    this.eofFlag = false;
    this.lastOperation = 'read';
    this.readAfterWriteAllowed = false;
    void at;
    return true;
  }

  writeBytes(bytes: Uint8Array, at: VirtualLocation): number {
    this.operationPerformed = true;
    if (!this.readyForWrite()) return 0;
    if (!(bytes instanceof Uint8Array)) { this.errorFlag = true; return 0; }
    if (this.canRead && this.lastOperation === 'read' && !this.eofFlag) {
      this.errorFlag = true;
      return 0;
    }
    if (this.append && this.bufferingMode === 2) {
      if (!this.flushPendingOutput(at)) return 0;
      this.cursor = this.state.data.length;
    } else if (this.append) {
      this.cursor = this.state.data.length + this.pendingOutputLength;
    }
    this.lastOperation = 'write';
    this.readAfterWriteAllowed = false;
    if (this.bufferingMode === 2) return this.writeImmediately(bytes, at);
    return this.writeBuffered(bytes, at);
  }

  preflightWriteBytes(count: number, at: VirtualLocation): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'The write size is not representable.');
    if (this.bufferingMode !== 2) {
      this.owner.preflightAdditionalIOBytes(count, at);
      return;
    }
    const start = this.append ? this.state.data.length : this.cursor;
    const growth = this.kind === 'stdout' || this.kind === 'stderr'
      ? count : Math.max(0, start + count - this.state.data.length);
    this.owner.preflightAdditionalIOBytes(growth, at);
  }

  seek(offset: number | bigint, origin: VirtualSeekOrigin, at: VirtualLocation): boolean {
    this.operationPerformed = true;
    if (this.closed || this.kind === 'stdin' || this.kind === 'stdout' || this.kind === 'stderr') { this.errorFlag = true; return false; }
    const numericOffset = typeof offset === 'bigint'
      ? (offset >= BigInt(Number.MIN_SAFE_INTEGER) && offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : NaN)
      : offset;
    if (!Number.isSafeInteger(numericOffset) || origin !== 0 && origin !== 1 && origin !== 2) { this.errorFlag = true; return false; }
    if (!this.flushPendingOutput(at)) return false;
    const base = origin === 0 ? 0 : origin === 1 ? this.cursor : this.state.data.length;
    const next = base + numericOffset;
    if (!Number.isSafeInteger(next) || next < 0) { this.errorFlag = true; return false; }
    this.cursor = next;
    this.pushedByte = undefined;
    this.pushedConsumesPosition = false;
    this.eofFlag = false;
    this.lastOperation = null;
    this.readAfterWriteAllowed = false;
    void at;
    return true;
  }

  tell(): number {
    this.operationPerformed = true;
    return this.closed ? -1 : this.cursor;
  }

  clearError(): void { this.operationPerformed = true; this.eofFlag = false; this.errorFlag = false; }

  markError(): void { this.operationPerformed = true; this.errorFlag = true; }

  setBuffering(mode: VirtualBufferMode, capacity: number, at: VirtualLocation): boolean {
    if (!this.canSetBuffering || ![0, 1, 2].includes(mode)) return false;
    if (mode !== 2 && (!Number.isSafeInteger(capacity) || capacity <= 0)) return false;
    this.bufferingMode = mode;
    this.bufferingCapacity = mode === 2 ? 0 : capacity;
    this.operationPerformed = true;
    void at;
    return true;
  }

  flush(at: VirtualLocation, explicit = true): boolean {
    this.operationPerformed = true;
    if (this.closed) { this.errorFlag = true; return false; }
    if (!this.canWrite) return true;
    if (!this.flushPendingOutput(at)) return false;
    if (explicit && this.canRead && this.lastOperation === 'write') this.readAfterWriteAllowed = true;
    return true;
  }

  close(at: VirtualLocation): boolean {
    this.operationPerformed = true;
    if (this.closed) { this.errorFlag = true; return false; }
    const flushed = this.flushPendingOutput(at);
    this.closed = true;
    this.pushedByte = undefined;
    this.pushedConsumesPosition = false;
    this.owner.unregisterStream(this);
    this.onClose?.();
    return flushed;
  }

  private availableBytes(): number {
    return (this.pushedByte === undefined ? 0 : 1) + Math.max(0, this.state.data.length - this.cursor);
  }

  private readyForRead(): boolean {
    if (!this.canRead || this.closed) { this.errorFlag = true; return false; }
    return true;
  }

  private readyForWrite(): boolean {
    if (!this.canWrite || this.closed) { this.errorFlag = true; return false; }
    return true;
  }

  private beginRead(at: VirtualLocation): boolean {
    this.operationPerformed = true;
    if (!this.readyForRead()) return false;
    if (this.canWrite && this.lastOperation === 'write' && !this.readAfterWriteAllowed) {
      this.errorFlag = true;
      return false;
    }
    if (this.kind === 'stdin' && !this.owner.flushLineBufferedOutputStreams(at)) {
      this.errorFlag = true;
      return false;
    }
    this.lastOperation = 'read';
    this.readAfterWriteAllowed = false;
    return true;
  }

  private writeImmediately(bytes: Uint8Array, at: VirtualLocation): number {
    if (this.kind === 'stdout' || this.kind === 'stderr') {
      this.owner.appendOutput(this.kind, bytes, at);
      this.cursor = 0;
      return bytes.length;
    }
    return this.writeFileBytes(bytes, this.append ? this.state.data.length : this.cursor, at);
  }

  private writeBuffered(bytes: Uint8Array, at: VirtualLocation): number {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.pendingOutputLength) {
        this.pendingOutputStart = this.append ? this.state.data.length : this.cursor;
      }
      const available = this.bufferingCapacity - this.pendingOutputLength;
      const nextNewline = this.bufferingMode === 1 ? bytes.indexOf(10, offset) : -1;
      const throughNewline = nextNewline < offset ? bytes.length - offset : nextNewline - offset + 1;
      const length = Math.min(available, bytes.length - offset, throughNewline);
      if (length <= 0) {
        this.errorFlag = true;
        return 0;
      }
      const chunk = bytes.slice(offset, offset + length);
      this.owner.reservePendingOutputBytes(length, at);
      this.pendingOutputChunks.push(chunk);
      this.pendingOutputLength += length;
      offset += length;
      if (this.kind === 'file') {
        this.cursor = this.append
          ? this.state.data.length + this.pendingOutputLength
          : (this.pendingOutputStart ?? this.cursor) + this.pendingOutputLength;
      }
      const newlineIncluded = nextNewline >= offset - length && nextNewline < offset;
      if (this.pendingOutputLength === this.bufferingCapacity || newlineIncluded) {
        if (!this.flushPendingOutput(at)) return 0;
      }
    }
    return bytes.length;
  }

  private flushPendingOutput(at: VirtualLocation): boolean {
    if (!this.pendingOutputLength) return true;
    const bytes = new Uint8Array(this.pendingOutputLength);
    let offset = 0;
    for (const chunk of this.pendingOutputChunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const start = this.pendingOutputStart ?? this.cursor - bytes.length;
    this.pendingOutputChunks = [];
    this.pendingOutputLength = 0;
    this.pendingOutputStart = undefined;
    this.owner.releasePendingOutputBytes(bytes.length);
    if (this.kind === 'stdout' || this.kind === 'stderr') {
      this.owner.appendOutput(this.kind, bytes, at);
      return true;
    }
    const written = this.writeFileBytes(bytes, this.append ? this.state.data.length : start, at);
    return written === bytes.length;
  }

  private writeFileBytes(bytes: Uint8Array, start: number, at: VirtualLocation): number {
    const requestedEnd = start + bytes.length;
    if (!Number.isSafeInteger(requestedEnd)) { this.errorFlag = true; return 0; }
    const allowedEnd = this.owner.allowedFileEnd(this.state.data.length, at);
    const allowedCount = Math.min(bytes.length, Math.max(0, allowedEnd - start));
    const end = start + allowedCount;
    const nextLength = Math.max(this.state.data.length, end);
    this.owner.resizeFile(this.state, nextLength, at);
    if (end > this.state.data.length) {
      const next = new Uint8Array(nextLength);
      next.set(this.state.data);
      this.state.data = next;
    }
    this.state.data.set(bytes.subarray(0, allowedCount), start);
    this.cursor = end;
    if (allowedCount < bytes.length) this.owner.raiseIOByteLimit(Math.max(0, requestedEnd - nextLength), at);
    return allowedCount;
  }
}
