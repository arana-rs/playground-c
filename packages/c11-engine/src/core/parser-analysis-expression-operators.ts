import type { AggregateDefinition, CType, Location, TypeQualifiers } from './internal.ts';
import { failure } from './internal.ts';
import { isNullPointerConstant, requireArithmetic, requireInteger, requireScalar } from './parser-constant-expressions.ts';
import { commonType, promote } from './numeric.ts';
import {
  canConvertPointerType, compatibleType, conditionalPointerCompositeType, hasVariableLengthObjectSize, isAggregate,
  isArithmetic, isArray, isComplete, isFunction, isInteger, isModifiableObject, isObject, isPointer,
  pointedToType, pointerTo, qualifyType, qualifiersOf, sizeOfType, typeName, unqualifiedType, variableLengthArrayTypes,
} from './type-system.ts';
import type {
  AnalyzedValue, AssignmentChecker, LvalueChecker, MemberPathResolver, OperatorExpression,
  VariableLengthBoundsAnalyzer,
} from './parser-analysis-context.ts';
import type { FunctionAnalysisContext } from './parser-analysis-context.ts';

export interface OperatorExpressionOperations {
  analyzedValue: AnalyzedValue;
  analyzeVariableLengthBounds: VariableLengthBoundsAnalyzer;
  isLvalue: LvalueChecker;
  canAssign: AssignmentChecker;
  findMemberPath: MemberPathResolver;
}

export function analyzeOperatorExpression(
  context: FunctionAnalysisContext,
  node: OperatorExpression,
  operations: OperatorExpressionOperations,
): void {
  const { aggregates } = context.environment;
  const { fn } = context;
  const { analyzedValue, analyzeVariableLengthBounds, isLvalue, canAssign, findMemberPath } = operations;
  switch (node.kind) {
          case 'unary': {
            if (node.operator === '&') {
              const operandType = node.operand.type!;
              if (node.operand.bitField) failure('INVALID_LVALUE', 'Cannot take the address of a bit-field.', node.location);
              if (!isLvalue(node.operand) && !isFunction(operandType)) failure('INVALID_LVALUE', 'The & operator requires an object or function designator.', node.location);
              if (node.operand.register || node.operand.kind === 'variable' && node.operand.binding !== undefined && fn.bindings[node.operand.binding]?.register) {
                failure('INVALID_LVALUE', 'Cannot take the address of a register object.', node.location);
              }
              if (isArray(operandType) && !isComplete(operandType, aggregates)) failure('INCOMPLETE_TYPE', 'Cannot take the address of an incomplete array.', node.location);
              node.type = pointerTo(qualifyType(operandType, qualifiersOf(operandType)), { baseConst: !!node.operand.isConst }); break;
            }
            node.operand = analyzedValue(node.operand);
            const operandType = node.operand.type!;
            if (node.operator === '*') {
              if (!isPointer(operandType)) failure('TYPE_ERROR', 'The * operator requires a pointer.', node.location);
              const designated = pointedToType(operandType)!;
              if (unqualifiedType(designated) === 'void') failure('INCOMPLETE_TYPE', 'Cannot dereference void *.', node.location);
              if (!isComplete(designated, aggregates) && !isFunction(designated)) failure('INCOMPLETE_TYPE', 'Cannot dereference a pointer to an incomplete type.', node.location);
              node.type = designated; node.isConst = !!qualifiersOf(designated).const; break;
            }
            if (node.operator === '!') { requireScalar(operandType, node.location); node.type = 'int'; break; }
            if (node.operator === '~') requireInteger(operandType, node.location);
            else requireArithmetic(operandType, node.location);
            node.type = promote(operandType); break;
          }
          case 'binary': {
            node.left = analyzedValue(node.left); node.right = analyzedValue(node.right);
            const leftType = node.left.type!, rightType = node.right.type!;
            if (node.operator === ',') { node.type = rightType; break; }
            if (node.operator === '&&' || node.operator === '||') {
              requireScalar(leftType, node.left.location); requireScalar(rightType, node.right.location); node.type = 'int'; break;
            }
            if (node.operator === '+' || node.operator === '-') {
              if (isArithmetic(leftType) && isArithmetic(rightType)) { node.type = commonType(leftType, rightType); break; }
              if (node.operator === '+' && isPointer(leftType) && isInteger(rightType)) { requirePointerArithmetic(leftType, aggregates, node.location); node.type = leftType; break; }
              if (node.operator === '+' && isInteger(leftType) && isPointer(rightType)) { requirePointerArithmetic(rightType, aggregates, node.location); node.type = rightType; break; }
              if (node.operator === '-' && isPointer(leftType) && isInteger(rightType)) { requirePointerArithmetic(leftType, aggregates, node.location); node.type = leftType; break; }
              if (node.operator === '-' && isPointer(leftType) && isPointer(rightType) && compatibleType(leftType, rightType) && unqualifiedType(pointedToType(leftType)!) !== 'void') { node.type = 'long'; break; }
              failure('TYPE_ERROR', `Incompatible operands for «${node.operator}».`, node.location);
            }
            if (['*', '/', '%', '&', '|', '^', '<<', '>>'].includes(node.operator)) {
              if (node.operator === '%' || ['&', '|', '^', '<<', '>>'].includes(node.operator)) { requireInteger(leftType, node.location); requireInteger(rightType, node.location); }
              else { requireArithmetic(leftType, node.location); requireArithmetic(rightType, node.location); }
              node.type = node.operator === '<<' || node.operator === '>>' ? promote(leftType) : commonType(leftType, rightType); break;
            }
            if (['==', '!=', '<', '>', '<=', '>='].includes(node.operator)) {
              if (isArithmetic(leftType) && isArithmetic(rightType)) { node.type = 'int'; break; }
              if (isPointer(leftType) && isPointer(rightType) && (compatibleType(leftType, rightType) || canConvertPointerType(leftType, rightType))) { node.type = 'int'; break; }
              if ((node.operator === '==' || node.operator === '!=') && isPointer(leftType) && isInteger(rightType) && isNullPointerConstant(node.right, aggregates)) { node.type = 'int'; break; }
              if ((node.operator === '==' || node.operator === '!=') && isPointer(rightType) && isInteger(leftType) && isNullPointerConstant(node.left, aggregates)) { node.type = 'int'; break; }
              failure('TYPE_ERROR', `Incompatible operands for «${node.operator}».`, node.location);
            }
            failure('UNSUPPORTED_FEATURE', `Unimplemented binary operator: «${node.operator}».`, node.location);
          }
          case 'assignment': {
            const targetType = node.target.type!;
            if (!isLvalue(node.target) || node.target.isConst || !isModifiableObject(targetType, aggregates)) failure('INVALID_LVALUE', 'Assignment requires a modifiable lvalue.', node.location);
            node.value = analyzedValue(node.value);
            const valueType = node.value.type!;
            if (node.operator === '=') {
              if (!canAssign(targetType, valueType, node.value)) failure('TYPE_ERROR', `Cannot assign ${typeName(valueType, aggregates)} to ${typeName(targetType, aggregates)}.`, node.location);
            } else {
              const op = node.operator.slice(0, -1);
              if (isPointer(targetType) && (op === '+' || op === '-') && isInteger(valueType)) requirePointerArithmetic(targetType, aggregates, node.location);
              else if (!isArithmetic(targetType) || !isArithmetic(valueType)) failure('TYPE_ERROR', `Operator «${node.operator}» requires compatible arithmetic operands.`, node.location);
              else if (['%', '&', '|', '^', '<<', '>>'].includes(op)) { requireInteger(targetType, node.location); requireInteger(valueType, node.location); }
            }
            node.type = unqualifiedType(targetType); break;
          }
          case 'update': {
            const type = node.operand.type!;
            if (!isLvalue(node.operand) || node.operand.isConst || !isModifiableObject(type, aggregates)) failure('INVALID_LVALUE', '++ and -- require a modifiable lvalue.', node.location);
            if (!isArithmetic(type)) {
              if (!isPointer(type)) failure('TYPE_ERROR', '++ and -- require an arithmetic type or an object pointer.', node.location);
              requirePointerArithmetic(type, aggregates, node.location);
            }
            node.type = unqualifiedType(type); break;
          }
          case 'cast': {
            analyzeVariableLengthBounds(variableLengthArrayTypes(node.targetType), node.location);
            node.operand = analyzedValue(node.operand);
            const source = node.operand.type!;
            const target = node.targetType;
            if (target === 'void') { node.type = target; break; }
            if (isArray(target) || isFunction(target) || isAggregate(target)) failure('TYPE_ERROR', 'A cast must produce void or a scalar type.', node.location);
            if (isArithmetic(target) && isArithmetic(source) || isPointer(target) && (isPointer(source) || isInteger(source)) || isInteger(target) && isPointer(source)) { node.type = target; break; }
            failure('TYPE_ERROR', 'Incompatible types in cast.', node.location);
          }
          case 'sizeof': {
            const type = node.valueType ?? node.operand!.type!;
            analyzeVariableLengthBounds(variableLengthArrayTypes(type), node.location);
            if (node.operand?.bitField) failure('TYPE_ERROR', 'sizeof does not apply to a bit-field.', node.location);
            if (!isComplete(type, aggregates) || isFunction(type)) failure('INCOMPLETE_TYPE', 'sizeof requires a complete object type.', node.location);
            if (!hasVariableLengthObjectSize(type)) sizeOfType(type, aggregates, node.location);
            node.type = 'unsigned long'; break;
          }
          case 'conditional': {
            node.condition = analyzedValue(node.condition); requireScalar(node.condition.type!, node.condition.location);
            node.then = analyzedValue(node.then); node.else = analyzedValue(node.else);
            const left = node.then.type!, right = node.else.type!;
            if (left === 'void' && right === 'void') node.type = 'void';
            else if (isArithmetic(left) && isArithmetic(right)) node.type = commonType(left, right);
            else if (isAggregate(left) && compatibleType(left, right)) node.type = left;
            else if (isPointer(left) && isPointer(right)) {
              const composite = conditionalPointerCompositeType(left, right);
              if (!composite) failure('TYPE_ERROR', 'The ?: branches require pointers to compatible types or a pointer to void.', node.location);
              node.type = composite;
            }
            else if (isPointer(left) && isInteger(right) && isNullPointerConstant(node.else, aggregates)) node.type = left;
            else if (isPointer(right) && isInteger(left) && isNullPointerConstant(node.then, aggregates)) node.type = right;
            else failure('TYPE_ERROR', 'The ?: branches must have compatible types.', node.location);
            break;
          }
          case 'index': {
            node.base = analyzedValue(node.base); node.index = analyzedValue(node.index);
            let baseType = node.base.type!, indexType = node.index.type!;
            if (isInteger(baseType) && isPointer(indexType)) {
              [node.base, node.index] = [node.index, node.base];
              [baseType, indexType] = [indexType, baseType];
            }
            if (!isPointer(baseType) || !isInteger(indexType)) failure('TYPE_ERROR', 'Subscript requires an object pointer and an integer index.', node.location);
            const designated = pointedToType(baseType);
            if (!designated || unqualifiedType(designated) === 'void' || isFunction(designated) || !isComplete(designated, aggregates)) failure('INCOMPLETE_TYPE', 'Subscript requires a pointer to a complete object type.', node.location);
            node.type = designated; node.isConst = !!qualifiersOf(designated).const; break;
          }
          case 'member': {
            let aggregateType: CType;
            let inheritedQualifiers: TypeQualifiers;
            const registerAggregate = !node.arrow && !!node.base.register;
            if (node.arrow) {
              node.base = analyzedValue(node.base);
              const pointer = node.base.type!;
              const designated = pointedToType(pointer);
              if (!designated || !isAggregate(designated)) failure('TYPE_ERROR', 'The -> operator requires a pointer to a struct or union.', node.location);
              aggregateType = designated;
              inheritedQualifiers = qualifiersOf(designated);
            } else {
              aggregateType = node.base.type!;
              inheritedQualifiers = qualifiersOf(aggregateType);
            }
            const path = findMemberPath(aggregateType, node.name, node.location);
            let intermediate = node.base;
            const firstIndex = 0;
            const last = path[path.length - 1];
            const end = path.length - 1;
            for (let index = firstIndex; index < end; index++) {
              const member = path[index];
              const memberType = qualifyType(member.type, inheritedQualifiers);
              intermediate = { kind: 'member', base: intermediate, name: member.name, arrow: node.arrow && index === 0, memberIndex: member.index, location: node.location, type: memberType, isConst: !!qualifiersOf(memberType).const };
              inheritedQualifiers = {
                ...(inheritedQualifiers.const || qualifiersOf(member.type).const ? { const: true } : {}),
                ...(inheritedQualifiers.volatile || qualifiersOf(member.type).volatile ? { volatile: true } : {}),
                ...(inheritedQualifiers.restrict || qualifiersOf(member.type).restrict ? { restrict: true } : {}),
              };
            }
            if (path.length > 1) { node.base = intermediate; node.arrow = false; }
            node.memberIndex = last.index; node.name = last.name;
            node.type = qualifyType(last.type, inheritedQualifiers);
            node.type = qualifyType(node.type, last.qualifiers ?? {});
            node.isConst = !!qualifiersOf(node.type).const;
            node.register = registerAggregate;
            node.bitField = !!last.bitField;
            break;
          }
  }
}

export function requirePointerArithmetic(type: CType, aggregates: readonly AggregateDefinition[], at: Location): void {
  const base = pointedToType(type);
  if (!base || unqualifiedType(base) === 'void' || isFunction(base) || !isObject(base) || !isComplete(base, aggregates)) {
    failure('INCOMPLETE_TYPE', 'Pointer arithmetic requires a complete object type other than void.', at);
  }
  if (!hasVariableLengthObjectSize(base)) sizeOfType(base, aggregates, at);
}
