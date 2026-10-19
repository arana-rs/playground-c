import { failure } from '../internal.ts';
import type { CValue, Expression } from '../internal.ts';
import { isFunction, isPointer, pointedToType, functionType } from '../type-system.ts';
import { isFloatingMathBuiltin } from '../numeric.ts';
import type { ExpressionHandler, ExpressionRuntimeContext } from './expression-runtime-context.ts';
import type { Frame } from './runtime-types.ts';

export function createLibraryExpressionHandler(context: ExpressionRuntimeContext): ExpressionHandler {
  const {
    functions, functionIndices, functionSymbolIndices, work, operands,
    vaCursors, plain, integer, valueForType, activePointerBases,
    activeUnknownPointerBases, mergeEffects, materialize, evaluate, markerId,
    vaArgTypesMatch, invokeBuiltin, isBuiltinContinuation, continueLibraryGenerator, defaultArgumentPromotion,
    invoke
  } = context;
  return (node: Expression, frame: Frame, depth: number, used: boolean): boolean => {
    const at = node.location;
        if (node.kind === 'vaArg') {
          work.push(() => {
            const handleResult = operands.pop();
            if (!handleResult) failure('ENGINE_STACK_ERROR', 'Missing va_arg argument list.', at);
            const handle = materialize(handleResult, at);
            const id = markerId(handle);
            const cursor = id === undefined ? undefined : vaCursors.get(id);
            if (!cursor?.active || cursor.indeterminate || cursor.frame.returned || !cursor.frame.vaCursorIds.has(id!)) {
              failure('INVALID_VA_LIST', 'va_arg requires an active list within the lifetime of its call.', at);
            }
            const argument = cursor.args[cursor.index];
            if (!argument) failure('VA_ARG_EXHAUSTED', 'va_arg requested an argument past the end of the list.', at);
            if (!vaArgTypesMatch(argument, node.valueType)) {
              failure('VA_ARG_TYPE_MISMATCH', `va_arg requested ${String(node.valueType)}, but the promoted argument is ${String(argument.type)}.`, at);
            }
            cursor.index++;
            operands.push(plain(valueForType(argument, node.valueType, at)));
          });
          evaluate(node.ap, frame, depth + 1);
        } else if (node.kind === 'call') {
          const start = operands.length;
          // va_start/va_copy/va_end are direct runtime intrinsics without a linked function object.
          const intrinsicBuiltin = !!node.builtin && node.functionIndex === undefined && node.symbolKey === undefined;
          work.push(() => {
            const evaluated = operands.splice(start);
            const callee = node.callee && !intrinsicBuiltin ? evaluated.shift() : undefined;
            if (evaluated.length !== node.args.length) failure('ENGINE_STACK_ERROR', 'The number of evaluated arguments does not match.', at);
            let effects = plain(integer(0));
            if (callee) {
              materialize(callee, at);
              effects = mergeEffects(effects, callee, at);
            }
            const args: CValue[] = [];
            const argumentPointerBases: ReadonlySet<number>[] = [];
            const argumentUnknownPointerBases: ReadonlySet<number>[] = [];
            for (const item of evaluated) {
              const argument = materialize(item, at);
              effects = mergeEffects(effects, item, at);
              args.push(argument);
              argumentPointerBases.push(isPointer(argument.type)
                ? activePointerBases(item.pointerBases) : new Set<number>());
              argumentUnknownPointerBases.push(isPointer(argument.type)
                ? activeUnknownPointerBases(item.unknownPointerBases) : new Set<number>());
            }
            effects.pendingWrites.clear();
            let functionIndex = node.functionIndex;
            if (callee) {
              const calleeValue = materialize(callee, at);
              if (!isPointer(calleeValue.type) || !isFunction(pointedToType(calleeValue.type) ?? 'void') ||
                  typeof calleeValue.value !== 'object' || calleeValue.value === null ||
                  (calleeValue.value as { kind?: string }).kind !== 'function-pointer') {
                failure('INVALID_CALL', 'The called expression is not a function pointer.', at);
              }
              functionIndex = (calleeValue.value as { functionIndex: number | null }).functionIndex ?? undefined;
            }
            const symbolIndex = node.symbolKey ? functionSymbolIndices.get(node.symbolKey) : undefined;
            if (functionIndex === undefined) functionIndex = symbolIndex;
            const targetFunction = functionIndex === undefined ? undefined : functions[functionIndex]?.fn;
            const functionName = node.name ?? targetFunction?.name;
            const builtinTarget = !!node.builtin || functionIndex !== undefined && !!functions[functionIndex]?.fn.builtin;
            const calleeType = node.callee?.type;
            const calleeFunction = calleeType ? functionType(pointedToType(calleeType) ?? 'void') : undefined;
            const signature = calleeFunction
              ? calleeFunction
              : targetFunction ? {
                kind: 'function' as const, returnType: targetFunction.returnType,
                parameters: targetFunction.parameters.map((parameter) => parameter.type),
                variadic: !!targetFunction.variadic, prototype: targetFunction.prototype,
              } : undefined;
            const callArgs = args.map((argument, index) => {
              if (signature && signature.prototype !== false && index < signature.parameters.length) {
                return valueForType(argument, signature.parameters[index], at);
              }
              return defaultArgumentPromotion(argument, at);
            });
            const callArgumentPointerBases = callArgs.map((argument, index) =>
              isPointer(argument.type) ? argumentPointerBases[index] ?? new Set<number>() : new Set<number>());
            const callArgumentUnknownPointerBases = callArgs.map((argument, index) =>
              isPointer(argument.type) ? argumentUnknownPointerBases[index] ?? new Set<number>() : new Set<number>());
            if (builtinTarget && functionName) {
              const runtimeArgs = isFloatingMathBuiltin(functionName) ? args : callArgs;
              const result = invokeBuiltin(functionName, runtimeArgs, node.type, at, frame);
              if (isBuiltinContinuation(result)) {
                continueLibraryGenerator(result, effects, at);
              } else {
                effects.value = result;
                operands.push(effects);
              }
            } else {
              if (functionIndex === undefined && functionName) functionIndex = functionIndices.get(functionName);
              if (functionIndex === undefined) failure('UNKNOWN_FUNCTION', 'Could not resolve the called function.', at);
              work.push(() => {
                const result = operands.pop();
                if (!result) failure('ENGINE_STACK_ERROR', 'The call did not produce a result.', at);
                effects.value = result.value;
                effects.pointerBases = activePointerBases(result.pointerBases);
                effects.unknownPointerBases = activeUnknownPointerBases(result.unknownPointerBases);
                operands.push(effects);
              });
              invoke(functions[functionIndex], callArgs, at, used, callArgumentPointerBases, callArgumentUnknownPointerBases);
            }
          });
          for (let index = node.args.length - 1; index >= 0; index--) evaluate(node.args[index], frame, depth + 1);
          if (node.callee && !intrinsicBuiltin) evaluate(node.callee, frame, depth + 1);
        }
        else return false;
        return true;
  };
}
