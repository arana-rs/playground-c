import type { MemoryViewerTranscriptEntry } from './memoryViewerControllerTypes.ts';

export interface MemoryViewerConsoleCheckpoint {
  /** Number of transcript runs at this point. */
  readonly segmentCount: number;
  /** Length of the last run, which may later grow by coalescing adjacent output chunks. */
  readonly tailLength: number;
}

const EMPTY_CONSOLE_CHECKPOINT: MemoryViewerConsoleCheckpoint = Object.freeze({ segmentCount: 0, tailLength: 0 });

/** Keeps decoded console runs and lightweight checkpoints for history navigation. */
export class MemoryViewerConsole {
  private enabled: boolean;
  private generation = 0;
  private readonly outputDecoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private transcript: MemoryViewerTranscriptEntry[] = [];
  private transcriptRevision = 0;
  private historicalTranscriptCache: {
    readonly checkpoint: MemoryViewerConsoleCheckpoint;
    readonly transcript: readonly MemoryViewerTranscriptEntry[];
  } | null = null;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean { return this.enabled; }
  get consoleGeneration(): number { return this.generation; }
  get entries(): readonly MemoryViewerTranscriptEntry[] { return this.transcript; }
  get revision(): number { return this.transcriptRevision; }

  setEnabled(enabled: boolean): boolean {
    if (this.enabled === enabled) return false;
    this.enabled = enabled;
    this.generation += 1;
    if (!enabled) this.clear();
    return true;
  }

  reset(): void {
    this.transcript = [];
    this.transcriptRevision += 1;
    this.historicalTranscriptCache = null;
    this.resetDecoders();
  }

  append(entry: MemoryViewerTranscriptEntry): void {
    if (!this.enabled || !entry.text) return;
    const previous = this.transcript[this.transcript.length - 1];
    if (previous && previous.stream === entry.stream && previous.tone === entry.tone
      && (entry.stream === 'stdout' || entry.stream === 'stderr')) {
      this.transcript[this.transcript.length - 1] = Object.freeze({ ...previous, text: previous.text + entry.text });
    } else {
      this.transcript.push(Object.freeze({ ...entry }));
    }
    this.transcriptRevision += 1;
  }

  acceptOutput(stream: 'stdout' | 'stderr', chunk: Uint8Array): void {
    if (!this.enabled) return;
    const text = this.outputDecoders[stream].decode(chunk, { stream: true });
    if (text) this.append({ stream, text });
  }

  flushOutputDecoders(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = this.enabled ? this.outputDecoders[stream].decode() : '';
      if (tail) this.append({ stream, text: tail });
      this.outputDecoders[stream] = new TextDecoder();
    }
  }

  captureCheckpoint(): MemoryViewerConsoleCheckpoint {
    if (!this.enabled) return EMPTY_CONSOLE_CHECKPOINT;
    return {
      segmentCount: this.transcript.length,
      tailLength: this.transcript.at(-1)?.text.length ?? 0,
    };
  }

  materialize(checkpoint: MemoryViewerConsoleCheckpoint): readonly MemoryViewerTranscriptEntry[] {
    if (this.historicalTranscriptCache?.checkpoint === checkpoint) return this.historicalTranscriptCache.transcript;
    const transcript = this.transcript.slice(0, checkpoint.segmentCount);
    const last = transcript.length - 1;
    const entry = transcript[last];
    if (entry && entry.text.length > checkpoint.tailLength) {
      transcript[last] = Object.freeze({ ...entry, text: entry.text.slice(0, checkpoint.tailLength) });
    }
    const snapshot = Object.freeze(transcript);
    this.historicalTranscriptCache = { checkpoint, transcript: snapshot };
    return snapshot;
  }

  private clear(): void {
    this.transcript = [];
    this.transcriptRevision += 1;
    this.historicalTranscriptCache = null;
    this.resetDecoders();
  }

  private resetDecoders(): void {
    this.outputDecoders.stdout = new TextDecoder();
    this.outputDecoders.stderr = new TextDecoder();
  }
}
