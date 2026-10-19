import { binary } from '../numeric.ts';
import { enforceLimit, failure } from '../internal.ts';
import type { CValue, CType, Expression, Location } from '../internal.ts';
import type { ExecuteLimits } from '../types.ts';
import { compatibleType, isInteger, isPointer, pointedToType, pointerType, sameType, unqualifiedType } from '../type-system.ts';
import type { ExpressionHandler, ExpressionRuntimeContext } from './expression-runtime-context.ts';
import { createSimpleExpressionHandler } from './expression-simple.ts';
import { createMutationExpressionHandler } from './expression-mutation.ts';
import { createCompositeExpressionHandler } from './expression-composite.ts';
import { createLibraryExpressionHandler } from './expression-library.ts';
import type { Frame } from './runtime-types.ts';

export interface ExpressionRuntimeFactoryContext extends Omit<ExpressionRuntimeContext, 'evaluate' | 'operateBinary' | 'vaArgTypesMatch'> {
  readonly limits: Pick<ExecuteLimits, 'maxDepth'>;
  get scopeDepth(): number;
  readonly instruction: (at: Location) => void;
}

export interface ExpressionRuntime {
  readonly evaluate: ExpressionRuntimeContext['evaluate'];
  readonly operateBinary: ExpressionRuntimeContext['operateBinary'];
}

export function createExpressionRuntime(context: ExpressionRuntimeFactoryContext): ExpressionRuntime {
  const operateBinary = (operator: string, left: CValue, right: CValue, at: Location): CValue => {
    const leftPointer = isPointer(left.type);
    const rightPointer = isPointer(right.type);
    if ((operator === '+' || operator === '-') && leftPointer && isInteger(right.type)) {
      const count = right.value;
      if (typeof count !== 'bigint') failure('INVALID_OPERAND_TYPE', 'A pointer offset must be an integer.', at);
      return context.memory.pointerAdd(left, operator === '-' ? -count : count, at);
    }
    if (operator === '+' && rightPointer && isInteger(left.type)) {
      if (typeof left.value !== 'bigint') failure('INVALID_OPERAND_TYPE', 'A pointer offset must be an integer.', at);
      return context.memory.pointerAdd(right, left.value, at);
    }
    if (operator === '-' && leftPointer && rightPointer) return context.memory.pointerDifference(left, right, at);
    if ((operator === '==' || operator === '!=') && (leftPointer || rightPointer)) {
      const pointerType = leftPointer ? left.type : right.type;
      const convertedLeft = context.valueForType(left, pointerType, at);
      const convertedRight = context.valueForType(right, pointerType, at);
      const leftFunction = typeof convertedLeft.value === 'object' && convertedLeft.value !== null &&
        (convertedLeft.value as { kind?: string }).kind === 'function-pointer';
      const rightFunction = typeof convertedRight.value === 'object' && convertedRight.value !== null &&
        (convertedRight.value as { kind?: string }).kind === 'function-pointer';
      let equal: boolean;
      if (convertedLeft.value === null || convertedRight.value === null) equal = convertedLeft.value === convertedRight.value;
      else if (leftFunction || rightFunction) {
        if (!leftFunction || !rightFunction) failure('INVALID_POINTER_COMPARISON', 'Pointers to objects and functions cannot be compared.', at);
        equal = (convertedLeft.value as { functionIndex: number }).functionIndex === (convertedRight.value as { functionIndex: number }).functionIndex;
      } else equal = context.memory.pointerEqual(convertedLeft, convertedRight, at);
      return context.integer(operator === '==' ? equal : !equal);
    }
    if (['<', '<=', '>', '>='].includes(operator) && leftPointer && rightPointer) {
      return context.integer(context.memory.pointerRelationalCompare(left, right, operator, at));
    }
    return binary(operator, left, right, at);
  };

  const isVoidPointerType = (type: CType): boolean =>
    !!pointerType(type) && unqualifiedType(pointedToType(type)!) === 'void';
  const isCharacterPointerType = (type: CType): boolean => {
    if (!pointerType(type)) return false;
    const base = unqualifiedType(pointedToType(type)!);
    return base === 'char' || base === 'signed char' || base === 'unsigned char';
  };
  const vaArgSignedUnsignedPairs: readonly (readonly [string, string, bigint])[] = [
    ['signed char', 'unsigned char', 127n],
    ['short', 'unsigned short', 32767n],
    ['int', 'unsigned int', 2147483647n],
    ['long', 'unsigned long', (1n << 63n) - 1n],
    ['long long', 'unsigned long long', (1n << 63n) - 1n],
  ];
  const vaArgTypesMatch = (argument: CValue, requestedType: CType): boolean => {
    if (compatibleType(argument.type, requestedType) || sameType(argument.type, requestedType)) return true;
    const argumentType = unqualifiedType(argument.type);
    const requested = unqualifiedType(requestedType);
    for (const [signedType, unsignedType, signedMaximum] of vaArgSignedUnsignedPairs) {
      const matchingPair = argumentType === signedType && requested === unsignedType ||
        argumentType === unsignedType && requested === signedType;
      if (matchingPair) {
        return typeof argument.value === 'bigint' && argument.value >= 0n && argument.value <= signedMaximum;
      }
    }
    return isVoidPointerType(argument.type) && isCharacterPointerType(requestedType) ||
      isCharacterPointerType(argument.type) && isVoidPointerType(requestedType);
  };

  function evaluate(root: Expression, frame: Frame, depth = 1, used = true, _wantLvalue = false): void {
    context.work.push(() => {
      const at = root.location;
      context.instruction(at);
      enforceLimit('maxDepth', context.scopeDepth + depth, context.limits.maxDepth, at);
      if (handleSimpleExpression(root, frame, depth, used)) return;
      if (handleMutationExpression(root, frame, depth, used)) return;
      if (handleCompositeExpression(root, frame, depth, used)) return;
      handleLibraryExpression(root, frame, depth, used);
    });
  }

  const handlerContext = Object.assign(Object.create(context) as ExpressionRuntimeContext, {
    evaluate: (root: Expression, frame: Frame, depth?: number, used?: boolean, wantLvalue?: boolean) =>
      evaluate(root, frame, depth, used, wantLvalue),
    operateBinary,
    vaArgTypesMatch,
  });
  const handleSimpleExpression: ExpressionHandler = createSimpleExpressionHandler(handlerContext);
  const handleMutationExpression: ExpressionHandler = createMutationExpressionHandler(handlerContext);
  const handleCompositeExpression: ExpressionHandler = createCompositeExpressionHandler(handlerContext);
  const handleLibraryExpression: ExpressionHandler = createLibraryExpressionHandler(handlerContext);

  return { evaluate, operateBinary };
}
