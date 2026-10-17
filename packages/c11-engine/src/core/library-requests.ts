import type { CValue } from './internal.ts';

/** Requests yielded by a library builtin to the VM scheduler. */
export type LibraryBuiltinRequest =
  | { readonly kind: 'input-needed' }
  | { readonly kind: 'call-user'; readonly callee: CValue; readonly args: readonly CValue[] }
  | {
      readonly kind: 'register-termination-handler';
      readonly mode: 'normal' | 'quick';
      readonly callee: CValue;
    }
  | {
      readonly kind: 'terminate';
      readonly mode: 'normal' | 'quick' | 'immediate' | 'abort';
      readonly status: bigint;
    };

/** A builtin may suspend for input or a C callback and then resume with a value. */
export type LibraryBuiltinGenerator = Generator<LibraryBuiltinRequest, CValue, CValue | void>;
