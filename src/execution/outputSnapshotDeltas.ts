export interface OutputSnapshotDelta {
  readonly sequence: number;
  readonly stream: 'stdout' | 'stderr';
  readonly chunk: Uint8Array;
}

/** Turn cumulative VM output snapshots into one ordered stream of new bytes. */
export class OutputSnapshotDeltas {
  private readonly offsets: Record<OutputSnapshotDelta['stream'], number> = { stdout: 0, stderr: 0 };
  private nextSequence = 0;

  fromSnapshot(stream: OutputSnapshotDelta['stream'], snapshot: Uint8Array): OutputSnapshotDelta | null {
    const offset = this.offsets[stream];
    if (snapshot.length < offset) throw new Error(`The ${stream} snapshot shrank during execution.`);
    if (snapshot.length === offset) return null;

    const chunk = snapshot.slice(offset);
    this.offsets[stream] = snapshot.length;
    return { sequence: ++this.nextSequence, stream, chunk };
  }

  /** Advance a disabled stream without slicing or publishing its newly produced bytes. */
  discardSnapshot(stream: OutputSnapshotDelta['stream'], snapshot: Uint8Array): void {
    const offset = this.offsets[stream];
    if (snapshot.length < offset) throw new Error(`The ${stream} snapshot shrank during execution.`);
    this.offsets[stream] = snapshot.length;
  }
}
