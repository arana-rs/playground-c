import type { Location } from './internal.ts';

export function comesBefore(left: Location, right: Location): boolean {
  return left.file !== right.file || left.line < right.line || left.line === right.line && left.column <= right.column;
}
