export class VirtualIOError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
