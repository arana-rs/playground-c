import type { CType, Expression } from './internal.ts';
import { failure } from './internal.ts';
import type { AnalyzedValue, AssignmentChecker, FunctionAnalysisContext } from './parser-analysis-context.ts';
import { MATH_CLASSIFICATION_FUNCTIONS, MATH_CLASSIFICATION_BUILTINS, MATH_COMPARISON_BUILTINS } from './math-metadata.ts';
import {
  functionType, isAggregate, isComplete, isFunction, isScalar, pointedToType, pointerTo,
  typeName, unqualifiedType,
} from './type-system.ts';

const floatingClassifications = new Set<string>([...MATH_CLASSIFICATION_FUNCTIONS, ...MATH_CLASSIFICATION_BUILTINS]);
const floatingComparisons = new Set<string>(MATH_COMPARISON_BUILTINS);
export const vaIntrinsics = new Set(['__builtin_va_start', '__builtin_va_copy', '__builtin_va_end']);

export function analyzeCallExpression(
  context: FunctionAnalysisContext,
  node: Extract<Expression, { kind: 'call' }>,
  analyzedValue: AnalyzedValue,
  canAssign: AssignmentChecker,
): void {
  const { aggregates, options, visibleFunctions } = context.environment;
            if (!node.callee) failure('ENGINE_INTERNAL_ERROR', 'Call has no callee.', node.location);
            const calleeType = node.callee.type!;
            let signatureType: CType;
            if (isFunction(calleeType)) {
              signatureType = calleeType;
              const fnNode = node.callee.kind === 'function' ? node.callee : undefined;
              if (fnNode) {
                node.name = fnNode.name; node.functionIndex = fnNode.functionIndex; node.symbolKey = fnNode.symbolKey;
                const signature = visibleFunctions.get(fnNode.name);
                node.builtin = signature?.definition === undefined &&
                  (!!signature?.fn.builtin || signature?.builtin !== undefined) || vaIntrinsics.has(fnNode.name);
              }
              node.callee = { kind: 'decay', operand: node.callee, location: node.callee.location, type: pointerTo(calleeType) };
            } else {
              const valueCallee = analyzedValue(node.callee);
              node.callee = valueCallee;
              const designated = pointedToType(valueCallee.type!);
              if (!designated || !isFunction(designated)) failure('NOT_CALLABLE', 'The called expression is neither a function nor a function pointer.', node.location);
              signatureType = designated;
            }
            const signature = functionType(signatureType)!;
            const returnType = unqualifiedType(signature.returnType);
            if (returnType !== 'void' && !isComplete(signature.returnType, aggregates)) {
              failure('INCOMPLETE_TYPE', 'The called function must return void or a complete object type.', node.location);
            }
            if (signature.prototype !== false && (node.args.length < signature.parameters.length || !signature.variadic && node.args.length !== signature.parameters.length)) {
              failure('TYPE_ERROR', `Call requires ${signature.variadic ? 'at least ' : ''}${signature.parameters.length} arguments.`, node.location);
            }
            if (signature.prototype === false && !options.allowUnresolved && node.args.length !== signature.parameters.length && signature.parameters.length > 0) {
              // A no-prototype call is checked against the definition at link time.
            }
            for (let index = 0; index < node.args.length; index++) {
              node.args[index] = analyzedValue(node.args[index]);
              const actual = node.args[index].type!;
              if (index < signature.parameters.length && signature.prototype !== false) {
                const expected = signature.parameters[index];
                if (!canAssign(expected, actual, node.args[index])) failure('TYPE_ERROR', `Argument ${index + 1} is not compatible with ${typeName(expected, aggregates)}.`, node.args[index].location);
              } else if (!signature.prototype || signature.variadic) {
                if (!(isScalar(actual) || isAggregate(actual) && isComplete(actual, aggregates))) failure('TYPE_ERROR', 'A variadic argument requires a permitted complete type.', node.args[index].location);
              }
            }
            if (node.name && node.builtin && floatingClassifications.has(node.name) && node.args[0] &&
                node.args[0].type !== 'float' && node.args[0].type !== 'double' && node.args[0].type !== 'long double') {
              failure('TYPE_ERROR', `«${node.name}» requires a floating-point argument.`, node.args[0].location);
            }
            if (node.name && node.builtin && floatingComparisons.has(node.name)) {
              for (const argument of node.args) {
                if (argument.type !== 'float' && argument.type !== 'double' && argument.type !== 'long double') {
                  failure('TYPE_ERROR', `«${node.name}» requires real floating-point arguments.`, argument.location);
                }
              }
            }
            node.type = signature.returnType;
}
