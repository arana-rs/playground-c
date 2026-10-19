import type { Binary80Value, BinaryFloatFormat } from './binary80.ts';

export type MathError = 'domain' | 'range';
export interface MathKernelResult {
  readonly value?: Binary80Value;
  readonly integerValue?: bigint;
  readonly output?: { readonly argumentIndex: number; readonly value: Binary80Value | bigint };
  readonly error?: MathError;
}

export interface MathKernelOptions {
  readonly format: BinaryFloatFormat;
  readonly integerArgument?: bigint;
}
