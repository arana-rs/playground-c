import type { ExecuteIOOptions } from './types.ts';
import { normalizeVirtualPath, virtualBasename } from './virtual-path.ts';
import { VirtualIOError } from './virtual-io/errors.ts';
import { VirtualStream, type FileState } from './virtual-io/stream.ts';

export { VirtualIOError, VirtualStream };
export type { VirtualStreamKind, VirtualSeekOrigin, VirtualBufferMode, VirtualByteRead } from './virtual-io/stream.ts';

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

export const VIRTUAL_TMP_MAX = 10_000;

/** One fresh virtual stdin/stdout/stderr and file namespace per execute call. */
export class VirtualIO {
  readonly argv: readonly string[];
  stdin: VirtualStream;
  stdout: VirtualStream;
  stderr: VirtualStream;
  private readonly files = new Map<string, FileState>();
  private readonly streams = new Set<VirtualStream>();
  private readonly issuedTemporaryNames = new Set<string>();
  private readonly temporaryStreams = new Set<VirtualStream>();
  private temporaryNameSequence = 0;
  private readonly output = { stdout: new Uint8Array(), stderr: new Uint8Array() };
  private readonly stdinState: FileState;
  private stdinIsOpen: boolean;
  private usedBytes = 0;
  private currentLocation: VirtualLocation;

  constructor(private readonly config: VirtualIOConfig) {
    this.currentLocation = { file: config.entry, line: 1, column: 1 };
    const options = config.io ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'io must be an object.');
    }
    const normalizedEntry = normalizeVirtualPath(config.entry) ?? virtualBasename(config.entry);
    const defaultArgv = [virtualBasename(normalizedEntry)];
    const suppliedArgv = options.argv;
    if (suppliedArgv !== undefined && !Array.isArray(suppliedArgv)) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'argv must be a vector of C strings without NUL bytes.');
    }
    const argv = suppliedArgv === undefined ? defaultArgv : [...suppliedArgv];
    if (argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'argv must be a vector of C strings without NUL bytes.');
    }
    this.argv = Object.freeze(argv.slice());

    const stdin = this.seed(options.stdin === undefined ? '' : options.stdin);
    const stdinState: FileState = { data: new Uint8Array(), openCount: 1 };
    this.stdinState = stdinState;
    this.stdinIsOpen = config.interactiveStdin ?? false;
    this.stdin = new VirtualStream('stdin', this, stdinState, true, false);
    this.stdout = new VirtualStream('stdout', this, { data: new Uint8Array(), openCount: 1 }, false, true);
    this.stderr = new VirtualStream('stderr', this, { data: new Uint8Array(), openCount: 1 }, false, true);
    this.resizeFile(stdinState, stdin.length, this.currentLocation);
    stdinState.data = stdin;

    const seededFiles = options.files === undefined ? [] : options.files;
    if (!Array.isArray(seededFiles)) throw new VirtualIOError('INVALID_IO_OPTIONS', 'io.files must be a list of virtual files.');
    for (const file of seededFiles) {
      if (!file || typeof file.name !== 'string' || !(typeof file.data === 'string' || file.data instanceof Uint8Array)) {
        throw new VirtualIOError('INVALID_IO_OPTIONS', 'Each virtual file requires name and text or byte data.');
      }
      const name = normalizeVirtualPath(file.name);
      if (!name) throw new VirtualIOError('INVALID_IO_PATH', `Virtual path «${file.name}» is invalid.`);
      if (this.files.has(name)) throw new VirtualIOError('INVALID_IO_PATH', `Virtual path «${name}» is duplicated.`);
      const data = this.seed(file.data);
      this.resizeFile({ data: new Uint8Array(), openCount: 0 }, data.length, this.currentLocation);
      this.files.set(name, { data, openCount: 0 });
    }
  }

  setLocation(at: VirtualLocation): void { this.currentLocation = at; }

  get stdinOpen(): boolean { return this.stdinIsOpen; }

  registerStream(stream: VirtualStream): void { this.streams.add(stream); }

  unregisterStream(stream: VirtualStream): void { this.streams.delete(stream); }

  flushLineBufferedOutputStreams(at: VirtualLocation): boolean {
    let succeeded = true;
    for (const stream of this.streams) {
      if (!stream.isClosed && stream.canWrite && stream.bufferMode === 1 && !stream.flush(at, false)) succeeded = false;
    }
    return succeeded;
  }

  flushAllOutputStreams(at: VirtualLocation): boolean {
    let succeeded = true;
    for (const stream of this.streams) {
      if (!stream.isClosed && stream.canWrite && !stream.flush(at)) succeeded = false;
    }
    return succeeded;
  }

  reservePendingOutputBytes(count: number, at: VirtualLocation = this.currentLocation): void {
    this.preflightAdditionalIOBytes(count, at);
    this.adjustBytes(count, at);
  }

  releasePendingOutputBytes(count: number): void {
    this.adjustBytes(-count, this.currentLocation);
  }

  appendStdin(bytes: Uint8Array, at: VirtualLocation = this.currentLocation): void {
    if (!this.stdinIsOpen) throw new VirtualIOError('STDIN_CLOSED', 'Cannot append input after EOF.');
    if (!(bytes instanceof Uint8Array)) throw new VirtualIOError('INVALID_IO_OPTIONS', 'Interactive input must be a Uint8Array.');
    if (!bytes.length) return;
    const previous = this.stdinState.data;
    const nextLength = previous.length + bytes.length;
    if (!Number.isSafeInteger(nextLength)) throw new VirtualIOError('INVALID_IO_SIZE', 'stdin exceeds the representable range.');
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
    if (state && parsed.exclusive) return null;
    if (!state && parsed.create) {
      state = { data: new Uint8Array(), openCount: 0 };
      this.files.set(name, state);
    }
    if (!state) return null;
    if (parsed.truncate) {
      this.resizeFile(state, 0, at);
      state.data = new Uint8Array();
    }
    state.openCount++;
    return new VirtualStream(
      'file', this, state, parsed.read, parsed.write, parsed.append, parsed.append && !parsed.read,
      () => { state.openCount = Math.max(0, state.openCount - 1); },
    );
  }

  /** Create an anonymous, update-mode file that disappears when its stream closes. */
  openTemporaryFile(at: VirtualLocation = this.currentLocation): VirtualStream {
    const state: FileState = { data: new Uint8Array(), openCount: 1 };
    let stream: VirtualStream;
    stream = new VirtualStream('file', this, state, true, true, false, false, () => {
      this.temporaryStreams.delete(stream);
      state.openCount = 0;
      this.resizeFile(state, 0, at);
      state.data = new Uint8Array();
    });
    this.temporaryStreams.add(stream);
    return stream;
  }

  /** Release anonymous temporary files at VM session termination. */
  closeTemporaryFiles(): void {
    for (const stream of [...this.temporaryStreams]) stream.close(this.currentLocation);
  }

  /** Generate a new name in the virtual namespace without creating the file. */
  nextTemporaryName(): string | undefined {
    while (this.temporaryNameSequence < VIRTUAL_TMP_MAX) {
      const candidate = `c11tmp${(this.temporaryNameSequence++).toString(36).padStart(4, '0')}`;
      if (!this.files.has(candidate) && !this.issuedTemporaryNames.has(candidate)) {
        this.issuedTemporaryNames.add(candidate);
        return candidate;
      }
    }
    return undefined;
  }

  hasFile(path: string): boolean {
    const name = normalizeVirtualPath(path);
    return name !== undefined && this.files.has(name);
  }

  /** The profile chooses failure if a file is open when remove is requested. */
  removeFile(path: string, at: VirtualLocation = this.currentLocation): boolean {
    const name = normalizeVirtualPath(path);
    if (!name) return false;
    const state = this.files.get(name);
    if (!state || state.openCount > 0) return false;
    this.files.delete(name);
    this.resizeFile(state, 0, at);
    return true;
  }

  /** The profile fails when the source is open or the destination already exists. */
  renameFile(oldPath: string, newPath: string): boolean {
    const oldName = normalizeVirtualPath(oldPath), newName = normalizeVirtualPath(newPath);
    if (!oldName || !newName) return false;
    const state = this.files.get(oldName);
    if (!state) return false;
    if (oldName === newName) return true;
    if (state.openCount > 0 || this.files.has(newName)) return false;
    this.files.delete(oldName);
    this.files.set(newName, state);
    return true;
  }

  /** Rebind a standard stream after freopen while preserving its FILE identity. */
  replaceStandardStream(kind: 'stdin' | 'stdout' | 'stderr', stream: VirtualStream): void {
    this[kind] = stream;
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
    if (!Number.isSafeInteger(count) || count < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'Temporary I/O size is not representable.');
    if (this.maxIOBytes !== null && count > this.maxIOBytes) this.config.checkLimit(count, at);
  }

  /** Check a planned allocation before a formatter or library function creates it. */
  preflightAdditionalIOBytes(count: number, at: VirtualLocation = this.currentLocation): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'The planned I/O size is not representable.');
    if (this.config.maxBytes !== null) {
      const next = this.usedBytes + count;
      if (!Number.isSafeInteger(next)) throw new VirtualIOError('INVALID_IO_SIZE', 'Virtual I/O exceeds the representable range.');
      if (next > this.config.maxBytes) this.config.checkLimit(next, at);
    }
  }

  allowedFileEnd(currentLength: number, at: VirtualLocation = this.currentLocation): number {
    if (this.maxIOBytes === null) return Number.MAX_SAFE_INTEGER;
    const end = currentLength + Math.max(0, this.maxIOBytes - this.usedBytes);
    if (!Number.isSafeInteger(end)) throw new VirtualIOError('INVALID_IO_SIZE', 'The end of the virtual file exceeds the representable range.');
    void at;
    return end;
  }

  raiseIOByteLimit(additionalBytes: number, at: VirtualLocation = this.currentLocation): never {
    const actual = this.usedBytes + Math.max(1, additionalBytes);
    this.config.checkLimit(actual, at);
    throw new VirtualIOError('IO_LIMIT', 'Virtual I/O limit exceeded.');
  }

  resizeFile(state: FileState, nextLength: number, at: VirtualLocation = this.currentLocation): void {
    if (!Number.isSafeInteger(nextLength) || nextLength < 0) throw new VirtualIOError('INVALID_IO_SIZE', 'The virtual file size is not representable.');
    this.adjustBytes(nextLength - state.data.length, at);
  }

  private adjustBytes(delta: number, at: VirtualLocation): void {
    if (delta > 0) {
      const next = this.usedBytes + delta;
      if (!Number.isSafeInteger(next)) throw new VirtualIOError('INVALID_IO_SIZE', 'Virtual I/O exceeds the representable range.');
      if (this.config.maxBytes !== null && next > this.config.maxBytes) this.config.checkLimit(next, at);
      this.usedBytes = next;
    } else this.usedBytes = Math.max(0, this.usedBytes + delta);
  }

  private seed(data: unknown): Uint8Array {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      throw new VirtualIOError('INVALID_IO_OPTIONS', 'stdin and virtual files require text or Uint8Array data.');
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

function parseMode(mode: string): { read: boolean; write: boolean; append: boolean; create: boolean; truncate: boolean; exclusive: boolean } | undefined {
  if (typeof mode !== 'string') return undefined;
  const match = /^(r|w|a)((?:b\+?|\+b?)?x?)$/.exec(mode);
  if (!match) return undefined;
  const lead = match[1];
  const suffix = match[2];
  const exclusive = suffix.endsWith('x');
  if (exclusive && lead !== 'w') return undefined;
  const flags = exclusive ? suffix.slice(0, -1) : suffix;
  const plus = flags.includes('+');
  return {
    read: lead === 'r' || plus,
    write: lead !== 'r' || plus,
    append: lead === 'a',
    create: lead !== 'r',
    truncate: lead === 'w',
    exclusive,
  };
}

export function isValidVirtualOpenMode(mode: string): boolean { return parseMode(mode) !== undefined; }
