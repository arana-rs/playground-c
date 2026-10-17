import type { ExecuteIOOptions } from './types.ts';
import { normalizeVirtualPath, virtualBasename } from './virtual-path.ts';

export interface VirtualLocation { readonly file: string; readonly line: number; readonly column: number }

export interface VirtualIOConfig {
  readonly entry: string;
  readonly io?: ExecuteIOOptions;
  readonly maxBytes: number | null;
  /** Keep stdin open after its current buffer is consumed. */
  readonly interactiveStdin?: boolean;
  /** The engine supplies this callback so an I/O budget reports as an engine `limit` result. */
  readonly checkLimit: (actual: number, at: VirtualLocation) => void;
}

export class VirtualIOError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface FileState { data: Uint8Array }
type StreamKind = 'stdin' | 'stdout' | 'stderr' | 'file';
export type VirtualStreamKind = StreamKind;
export type VirtualSeekOrigin = 0 | 1 | 2;
export type VirtualByteRead = { readonly kind: 'byte'; readonly value: number } | { readonly kind: 'eof' } | { readonly kind: 'pending' };

/** Byte-oriented C stream backed only by session-local virtual memory. */
export class VirtualStream {
  private cursor = 0;
  private pushedByte: number | undefined;
  private pushedConsumesPosition = false;
  private eofFlag = false;
  private errorFlag = false;
  private closed = false;

  constructor(
    readonly kind: StreamKind,
    private readonly owner: VirtualIO,
    private readonly state: FileState,
    readonly canRead: boolean,
    readonly canWrite: boolean,
    private readonly append = false,
    initialAtEnd = false,
  ) {
    if (initialAtEnd) this.cursor = state.data.length;
  }

  get eof(): boolean { return this.eofFlag; }
  get error(): boolean { return this.errorFlag; }
  get isClosed(): boolean { return this.closed; }

  readByte(at: VirtualLocation): number {
    const result = this.readByteResult(at);
    if (result.kind === 'pending') throw new VirtualIOError('INPUT_PENDING', 'La lectura de stdin requiere más entrada.');
    return result.kind === 'byte' ? result.value : -1;
  }

  /** Read without conflating temporary input exhaustion with EOF. */
  readByteResult(at: VirtualLocation): VirtualByteRead {
    if (!this.readyForRead()) return { kind: 'eof' };
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
      void at;
      return { kind: 'eof' };
    }
    void at;
    return { kind: 'byte', value: this.state.data[this.cursor++] };
  }

  readBytes(length: number, at: VirtualLocation): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) { this.errorFlag = true; return new Uint8Array(); }
    if (!this.readyForRead()) return new Uint8Array();
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
    if (read < length) this.eofFlag = true;
    void at;
    return read === result.length ? result : result.slice(0, read);
  }

  /** Read only bytes currently available, without treating open stdin as EOF. */
  readAvailableInto(target: Uint8Array, offset: number, length: number, at: VirtualLocation): number {
    if (!(target instanceof Uint8Array) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset + length > target.length) {
      this.errorFlag = true;
      return 0;
    }
    if (!this.readyForRead()) return 0;
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
    if (read > 0) this.eofFlag = false;
    if (read < length && !(this.kind === 'stdin' && this.owner.stdinOpen)) this.eofFlag = true;
    void at;
    return read;
  }

  ungetByte(byte: number, at: VirtualLocation): boolean {
    if (!this.readyForRead() || !Number.isInteger(byte) || byte < 0 || byte > 255 || this.pushedByte !== undefined) {
      this.errorFlag = true;
      return false;
    }
    this.pushedByte = byte;
    this.pushedConsumesPosition = this.cursor > 0;
    if (this.pushedConsumesPosition) this.cursor--;
    this.eofFlag = false;
    void at;
    return true;
  }

  writeBytes(bytes: Uint8Array, at: VirtualLocation): number {
    if (!this.readyForWrite()) return 0;
    if (!(bytes instanceof Uint8Array)) { this.errorFlag = true; return 0; }
    if (this.kind === 'stdout' || this.kind === 'stderr') {
      this.owner.appendOutput(this.kind, bytes, at);
      this.cursor = 0;
      return bytes.length;
    }
    if (this.append) this.cursor = this.state.data.length;
    const requestedEnd = this.cursor + bytes.length;
    if (!Number.isSafeInteger(requestedEnd)) { this.errorFlag = true; return 0; }
    const allowedEnd = this.owner.allowedFileEnd(this.state.data.length, at);
    const allowedCount = Math.min(bytes.length, Math.max(0, allowedEnd - this.cursor));
    const end = this.cursor + allowedCount;
    const nextLength = Math.max(this.state.data.length, end);
    this.owner.resizeFile(this.state, nextLength, at);
    if (end > this.state.data.length) {
      const next = new Uint8Array(nextLength);
      next.set(this.state.data);
      this.state.data = next;
    }
    this.state.data.set(bytes.subarray(0, allowedCount), this.cursor);
    this.cursor = end;
    if (allowedCount < bytes.length) this.owner.raiseIOByteLimit(Math.max(0, requestedEnd - nextLength), at);
    return allowedCount;
  }

  preflightWriteBytes(count: number, at: VirtualLocation): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'El tamaño de escritura no es representable.');
    const start = this.append ? this.state.data.length : this.cursor;
    const growth = this.kind === 'stdout' || this.kind === 'stderr'
      ? count : Math.max(0, start + count - this.state.data.length);
    this.owner.preflightAdditionalIOBytes(growth, at);
  }

  seek(offset: number | bigint, origin: VirtualSeekOrigin, at: VirtualLocation): boolean {
    if (this.closed || this.kind === 'stdin' || this.kind === 'stdout' || this.kind === 'stderr') { this.errorFlag = true; return false; }
    const numericOffset = typeof offset === 'bigint'
      ? (offset >= BigInt(Number.MIN_SAFE_INTEGER) && offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : NaN)
      : offset;
    if (!Number.isSafeInteger(numericOffset)) { this.errorFlag = true; return false; }
    const base = origin === 0 ? 0 : origin === 1 ? this.cursor : origin === 2 ? this.state.data.length : NaN;
    const next = base + numericOffset;
    if (!Number.isSafeInteger(next) || next < 0) { this.errorFlag = true; return false; }
    this.cursor = next;
    this.pushedByte = undefined;
    this.pushedConsumesPosition = false;
    this.eofFlag = false;
    void at;
    return true;
  }

  tell(): number { return this.closed ? -1 : this.cursor; }

  clearError(): void { this.eofFlag = false; this.errorFlag = false; }

  markError(): void { this.errorFlag = true; }

  close(): boolean {
    if (this.closed) { this.errorFlag = true; return false; }
    this.closed = true;
    this.pushedByte = undefined;
    this.pushedConsumesPosition = false;
    return true;
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
}

/** One fresh virtual stdin/stdout/stderr and file namespace per execute call. */
export class VirtualIO {
  readonly argv: readonly string[];
  readonly stdin: VirtualStream;
  readonly stdout: VirtualStream;
  readonly stderr: VirtualStream;
  private readonly files = new Map<string, FileState>();
  private readonly output = { stdout: new Uint8Array(), stderr: new Uint8Array() };
  private readonly stdinState: FileState;
  private stdinIsOpen: boolean;
  private usedBytes = 0;
  private currentLocation: VirtualLocation;

  constructor(private readonly config: VirtualIOConfig) {
    this.currentLocation = { file: config.entry, line: 1, column: 1 };
    const options = config.io ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'io debe ser un objeto.');
    }
    const normalizedEntry = normalizeVirtualPath(config.entry) ?? virtualBasename(config.entry);
    const defaultArgv = [virtualBasename(normalizedEntry)];
    const suppliedArgv = options.argv;
    if (suppliedArgv !== undefined && !Array.isArray(suppliedArgv)) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'argv debe ser un vector de strings C sin bytes NUL.');
    }
    const argv = suppliedArgv === undefined ? defaultArgv : [...suppliedArgv];
    if (argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'argv debe ser un vector de strings C sin bytes NUL.');
    }
    this.argv = Object.freeze(argv.slice());

    const stdin = this.seed(options.stdin === undefined ? '' : options.stdin);
    const stdinState: FileState = { data: new Uint8Array() };
    this.stdinState = stdinState;
    this.stdinIsOpen = config.interactiveStdin ?? false;
    this.stdin = new VirtualStream('stdin', this, stdinState, true, false);
    this.stdout = new VirtualStream('stdout', this, { data: new Uint8Array() }, false, true);
    this.stderr = new VirtualStream('stderr', this, { data: new Uint8Array() }, false, true);
    this.resizeFile(stdinState, stdin.length, this.currentLocation);
    stdinState.data = stdin;

    const seededFiles = options.files === undefined ? [] : options.files;
    if (!Array.isArray(seededFiles)) throw new VirtualIOError('INVALID_IO_OPTIONS', 'io.files debe ser una lista de archivos virtuales.');
    for (const file of seededFiles) {
      if (!file || typeof file.name !== 'string' || !(typeof file.data === 'string' || file.data instanceof Uint8Array)) {
        throw new VirtualIOError('INVALID_IO_OPTIONS', 'Cada archivo virtual requiere name y data de texto o bytes.');
      }
      const name = normalizeVirtualPath(file.name);
      if (!name) throw new VirtualIOError('INVALID_IO_PATH', `La ruta virtual «${file.name}» no es válida.`);
      if (this.files.has(name)) throw new VirtualIOError('INVALID_IO_PATH', `La ruta virtual «${name}» está duplicada.`);
      const data = this.seed(file.data);
      this.resizeFile({ data: new Uint8Array() }, data.length, this.currentLocation);
      this.files.set(name, { data });
    }
  }

  setLocation(at: VirtualLocation): void { this.currentLocation = at; }

  get stdinOpen(): boolean { return this.stdinIsOpen; }

  appendStdin(bytes: Uint8Array, at: VirtualLocation = this.currentLocation): void {
    if (!this.stdinIsOpen) throw new VirtualIOError('STDIN_CLOSED', 'No se puede añadir entrada después de EOF.');
    if (!(bytes instanceof Uint8Array)) throw new VirtualIOError('INVALID_IO_OPTIONS', 'La entrada interactiva debe ser Uint8Array.');
    if (!bytes.length) return;
    const previous = this.stdinState.data;
    const nextLength = previous.length + bytes.length;
    if (!Number.isSafeInteger(nextLength)) throw new VirtualIOError('INVALID_IO_SIZE', 'stdin excedió el rango representable.');
    this.resizeFile(this.stdinState, nextLength, at);
    const next = new Uint8Array(nextLength);
    next.set(previous);
    next.set(bytes, previous.length);
    this.stdinState.data = next;
  }

  endStdin(): void { this.stdinIsOpen = false; }

  open(path: string, mode: string, at: VirtualLocation = this.currentLocation): VirtualStream | null {
    this.currentLocation = at;
    const name = normalizeVirtualPath(path);
    const parsed = parseMode(mode);
    if (!name || !parsed) return null;
    let state = this.files.get(name);
    if (!state && parsed.create) {
      state = { data: new Uint8Array() };
      this.files.set(name, state);
    }
    if (!state) return null;
    if (parsed.truncate) {
      this.resizeFile(state, 0, at);
      state.data = new Uint8Array();
    }
    return new VirtualStream('file', this, state, parsed.read, parsed.write, parsed.append, parsed.append && !parsed.read);
  }

  appendOutput(kind: 'stdout' | 'stderr', bytes: Uint8Array, at: VirtualLocation = this.currentLocation): void {
    const old = this.output[kind];
    const allowed = this.maxIOBytes === null ? bytes.length : Math.min(bytes.length, Math.max(0, this.maxIOBytes - this.usedBytes));
    const nextLength = old.length + allowed;
    this.adjustBytes(allowed, at);
    const next = new Uint8Array(nextLength);
    next.set(old);
    next.set(bytes.subarray(0, allowed), old.length);
    this.output[kind] = next;
    if (allowed < bytes.length) this.raiseIOByteLimit(bytes.length - allowed, at);
  }

  snapshot(): { stdout: Uint8Array; stderr: Uint8Array } {
    return { stdout: this.output.stdout.slice(), stderr: this.output.stderr.slice() };
  }

  get allocatedIOBytes(): number { return this.usedBytes; }
  get maxIOBytes(): number | null { return this.config.maxBytes; }

  /** Bound a temporary result before materializing it; actual stream/file writes charge separately. */
  preflightBufferBytes(count: number, at: VirtualLocation = this.currentLocation): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'El tamaño temporal de E/S no es representable.');
    if (this.maxIOBytes !== null && count > this.maxIOBytes) this.config.checkLimit(count, at);
  }

  /** Check a planned allocation before a formatter or library function creates it. */
  preflightAdditionalIOBytes(count: number, at: VirtualLocation = this.currentLocation): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'El tamaño de E/S planeado no es representable.');
    if (this.config.maxBytes !== null) {
      const next = this.usedBytes + count;
      if (!Number.isSafeInteger(next)) throw new VirtualIOError('INVALID_IO_SIZE', 'La E/S virtual excedió el rango representable.');
      if (next > this.config.maxBytes) this.config.checkLimit(next, at);
    }
  }

  allowedFileEnd(currentLength: number, at: VirtualLocation = this.currentLocation): number {
    if (this.maxIOBytes === null) return Number.MAX_SAFE_INTEGER;
    const end = currentLength + Math.max(0, this.maxIOBytes - this.usedBytes);
    if (!Number.isSafeInteger(end)) throw new VirtualIOError('INVALID_IO_SIZE', 'El final del archivo virtual excedió el rango representable.');
    void at;
    return end;
  }

  raiseIOByteLimit(additionalBytes: number, at: VirtualLocation = this.currentLocation): never {
    const actual = this.usedBytes + Math.max(1, additionalBytes);
    this.config.checkLimit(actual, at);
    throw new VirtualIOError('IO_LIMIT', 'Se superó el límite de E/S virtual.');
  }

  resizeFile(state: FileState, nextLength: number, at: VirtualLocation = this.currentLocation): void {
    if (!Number.isSafeInteger(nextLength) || nextLength < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'El tamaño de un archivo virtual no es representable.');
    this.adjustBytes(nextLength - state.data.length, at);
  }

  private adjustBytes(delta: number, at: VirtualLocation): void {
    if (delta > 0) {
      const next = this.usedBytes + delta;
      if (!Number.isSafeInteger(next)) throw new VirtualIOError('INVALID_IO_SIZE', 'La E/S virtual excedió el rango representable.');
      if (this.config.maxBytes !== null && next > this.config.maxBytes) this.config.checkLimit(next, at);
      this.usedBytes = next;
    } else this.usedBytes = Math.max(0, this.usedBytes + delta);
  }

  private seed(data: unknown): Uint8Array {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'stdin y los archivos virtuales requieren texto o Uint8Array.');
    }
    const byteLength = typeof data === 'string' ? utf8ByteLength(data) : data.byteLength;
    // Check the budget before TextEncoder or slice allocates a second copy.
    this.preflightAdditionalIOBytes(byteLength, this.currentLocation);
    return typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
  }
}

function utf8ByteLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const first = text.charCodeAt(index);
    if (first <= 0x7f) length++;
    else if (first <= 0x7ff) length += 2;
    else if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
      const second = text.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) { length += 4; index++; }
      else length += 3; // TextEncoder replaces an unpaired surrogate with U+FFFD.
    } else length += 3;
  }
  return length;
}

function parseMode(mode: string): { read: boolean; write: boolean; append: boolean; create: boolean; truncate: boolean } | undefined {
  if (typeof mode !== 'string') return undefined;
  const match = /^(r|w|a)(b\+?|\+b?)?$/.exec(mode);
  if (!match) return undefined;
  const lead = match[1];
  const plus = match[2]?.includes('+') ?? false;
  return {
    read: lead === 'r' || plus,
    write: lead !== 'r' || plus,
    append: lead === 'a',
    create: lead !== 'r',
    truncate: lead === 'w',
  };
}

export function isValidVirtualOpenMode(mode: string): boolean { return parseMode(mode) !== undefined; }
