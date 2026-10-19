import { failure } from '../internal.ts';
import type { CValue } from '../internal.ts';
import { arrayOf, pointerTo, pointerType, pointedToType, unqualifiedType } from '../type-system.ts';
import type { VirtualMemory } from '../memory.ts';
import type { VirtualIO } from '../virtual-io.ts';
import type { CompiledFunction } from '../bytecode.ts';

/** Live services used to construct the C `argc` and `argv` arguments for main. */
export interface MainArgumentsRuntimeContext {
  readonly memory: VirtualMemory;
  get io(): VirtualIO | undefined;
  readonly chargeWork: (count: number, at: CompiledFunction['fn']['location']) => void;
  readonly integer: (value: bigint | number | boolean, type?: CValue['type']) => CValue;
  readonly valueForType: (value: CValue, type: CValue['type'], at: CompiledFunction['fn']['location']) => CValue;
}

export interface MainArgumentsRuntime {
  readonly mainArguments: (compiled: CompiledFunction) => CValue[];
}

export function createMainArgumentsRuntime(context: MainArgumentsRuntimeContext): MainArgumentsRuntime {
  const mainArguments = (compiled: CompiledFunction): CValue[] => {
    const parameters = compiled.fn.parameters;
    if (parameters.length === 0) return [];
    const argvPointer = parameters[1] ? pointedToType(parameters[1].type) : undefined;
    const argvElementPointer = argvPointer ? pointerType(argvPointer) : undefined;
    if (parameters.length !== 2 || unqualifiedType(parameters[0]?.type ?? 'void') !== 'int' || !argvElementPointer ||
        unqualifiedType(pointedToType(argvPointer!) ?? 'void') !== 'char') {
      failure('INVALID_ENTRY_SIGNATURE', 'main must have the form int main(void) or int main(int, char **).', compiled.fn.location);
    }
    if (context.io!.argv.length > 2147483647) failure('ARGUMENT_COUNT_RANGE', 'The argv vector exceeds the int range for argc.', compiled.fn.location);
    const pointerToChar = pointerTo('char');
    const vector = context.memory.allocate(arrayOf(pointerToChar, context.io!.argv.length + 1), 'static', compiled.fn.location);
    context.memory.zeroInitialize(vector, compiled.fn.location);
    for (let index = 0; index < context.io!.argv.length; index++) {
      const encoded = new TextEncoder().encode(context.io!.argv[index]);
      context.chargeWork(encoded.length + 1, compiled.fn.location);
      const string = context.memory.allocate(arrayOf('char', encoded.length + 1), 'static', compiled.fn.location);
      context.memory.zeroInitialize(string, compiled.fn.location);
      for (let byte = 0; byte < encoded.length; byte++) {
        context.memory.write(context.memory.element(string, byte, compiled.fn.location), context.integer(BigInt.asIntN(8, BigInt(encoded[byte])), 'char'), compiled.fn.location);
      }
      context.memory.write(
        context.memory.element(vector, index, compiled.fn.location),
        context.valueForType(context.memory.decay(string), pointerToChar, compiled.fn.location),
        compiled.fn.location,
      );
    }
    return [context.integer(BigInt(context.io!.argv.length), 'int'), context.valueForType(context.memory.decay(vector), parameters[1].type, compiled.fn.location)];
  };

  return { mainArguments };
}
