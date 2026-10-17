import { pointerTo } from './type-system.ts';
import type { CType } from './internal.ts';

/** C signatures for heap allocation builtins backed by the virtual memory model. */
const voidPointer: CType = Object.freeze(pointerTo('void'));

export const HEAP_ALLOCATOR_SIGNATURES = Object.freeze({
  malloc: Object.freeze({
    prototype: 'void *malloc(size_t);',
    returnType: voidPointer,
    parameters: Object.freeze(['unsigned long'] as const),
  }),
  realloc: Object.freeze({
    prototype: 'void *realloc(void *, size_t);',
    returnType: voidPointer,
    parameters: Object.freeze([voidPointer, 'unsigned long'] as const),
  }),
});

export type HeapAllocatorBuiltin = keyof typeof HEAP_ALLOCATOR_SIGNATURES;

export const HEAP_ALLOCATOR_BUILTINS = Object.freeze(
  Object.keys(HEAP_ALLOCATOR_SIGNATURES) as HeapAllocatorBuiltin[],
);
