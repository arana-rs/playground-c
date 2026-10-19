import { failure } from './internal.ts';
import type { Location } from './internal.ts';

export function preprocessError(message: string, at: Location, code = 'PREPROCESSOR_ERROR'): never {
  return failure(code, message, at);
}
