import type { CType, Expression } from './internal.ts';
import { commonType, promote } from './numeric.ts';
import {
  arrayOf, arrayType, compatibleType, conditionalPointerCompositeType, decayType, functionType,
  isAggregate, isArithmetic, isInteger, isPointer, pointedToType, pointerTo, qualifyType, qualifiersOf, unqualifiedType,
} from './type-system.ts';
import { aggregateMemberPath, expressionChildren, selectGenericAssociation } from './parser-constant-expressions.ts';
import { assignments } from './parser-expression-operators.ts';
import type { ExpressionGrammar, ParserContext } from './parser-context-types.ts';

export function createExpressionInference(context: ParserContext): Pick<ExpressionGrammar, 'inferExpressionType' | 'resolveGenericSelection'> {
  const { aggregates } = context;

const inferExpressionType = (root: Expression): CType | undefined => {
  const inferred = new Map<Expression, CType>();
  const pending: { node: Expression; done: boolean }[] = [{ node: root, done: false }];
  while (pending.length) {
    const { node, done } = pending.pop()!;
    if (!done) {
      if (node.type && node.kind !== 'generic') { inferred.set(node, node.type); continue; }
      pending.push({ node, done: true });
      const children = node.kind === 'sizeof' ? [] : expressionChildren(node);
      for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], done: false });
      continue;
    }
    const operandType = (child: Expression): CType | undefined => inferred.get(child) ?? child.type;
    let type: CType | undefined;
    try {
      switch (node.kind) {
        case 'literal': type = node.value.type; break;
        case 'string': type = arrayOf('char', node.bytes.length); break;
        case 'variable': case 'function': type = node.type ?? context.lookupOrdinaryType(node.name); break;
        case 'sizeof': type = 'unsigned long'; break;
        case 'generic': {
          const controlType = operandType(node.control);
          if (controlType) {
            const selected = selectGenericAssociation(controlType, node.associations, aggregates, node.location);
            node.selected = selected;
            type = operandType(selected);
          }
          break;
        }
        case 'cast': type = node.targetType; break;
        case 'unary': {
          const source = operandType(node.operand);
          if (!source) break;
          if (node.operator === '&') type = pointerTo(source);
          else if (node.operator === '*') type = pointedToType(source);
          else if (node.operator === '!') type = 'int';
          else type = promote(source);
          break;
        }
        case 'update': type = operandType(node.operand); break;
        case 'binary': {
          const left = operandType(node.left), right = operandType(node.right);
          if (!left || !right) break;
          if (assignments.has(node.operator)) type = unqualifiedType(left);
          else if (node.operator === ',') type = right;
          else if (['||', '&&', '==', '!=', '<', '>', '<=', '>='].includes(node.operator)) type = 'int';
          else if (node.operator === '+' || node.operator === '-') {
            if (isPointer(left) && isInteger(right)) type = left;
            else if (node.operator === '+' && isInteger(left) && isPointer(right)) type = right;
            else if (node.operator === '-' && isPointer(left) && isPointer(right)) type = 'long';
            else if (isArithmetic(left) && isArithmetic(right)) type = commonType(left, right);
          } else if (isArithmetic(left) && isArithmetic(right)) type = commonType(left, right);
          break;
        }
        case 'conditional': {
          const left = operandType(node.then), right = operandType(node.else);
          if (!left || !right) break;
          if (isArithmetic(left) && isArithmetic(right)) type = commonType(left, right);
          else if (isAggregate(left) && compatibleType(left, right)) type = left;
          else if (isPointer(left) && isPointer(right)) type = conditionalPointerCompositeType(left, right);
          else if (isPointer(left) && isInteger(right)) type = left;
          else if (isInteger(left) && isPointer(right)) type = right;
          else if (left === 'void' && right === 'void') type = 'void';
          break;
        }
        case 'index': {
          const base = operandType(node.base);
          type = base ? arrayType(base)?.element ?? pointedToType(base) : undefined;
          break;
        }
        case 'member': {
          let base = operandType(node.base);
          if (base && node.arrow) base = pointedToType(base);
          if (base && isAggregate(base)) {
            const path = aggregateMemberPath(base, node.name, aggregates, node.location);
            const last = path.at(-1)!;
            const baseQualifiers = qualifiersOf(base);
            const memberQualifiers = last.qualifiers ?? qualifiersOf(last.type);
            type = qualifyType(last.type, {
              ...(baseQualifiers.const || memberQualifiers.const ? { const: true } : {}),
              ...(baseQualifiers.volatile || memberQualifiers.volatile ? { volatile: true } : {}),
              ...(baseQualifiers.restrict || memberQualifiers.restrict ? { restrict: true } : {}),
            });
          }
          break;
        }
        case 'decay': {
          const source = operandType(node.operand);
          if (source) type = decayType(source);
          break;
        }
        case 'compoundLiteral': type = node.objectType; break;
        case 'vaArg': type = node.valueType; break;
        case 'call': {
          const callee = node.callee ? operandType(node.callee) : undefined;
          const signature = callee && (functionType(callee) ?? functionType(pointedToType(callee) ?? 'void'));
          type = signature?.returnType;
          break;
        }
        case 'assignment': type = operandType(node.target); break;
      }
    } catch {
      // Best-effort type inference only chooses a parse-time generic branch;
      // full diagnostics and type validation still run in analyze().
    }
    if (type) inferred.set(node, type);
  }
  return inferred.get(root) ?? root.type;
};

const resolveGenericSelection = (node: Extract<Expression, { kind: 'generic' }>): Expression | undefined => {
  const controlType = inferExpressionType(node.control);
  if (!controlType) return undefined;
  const selected = selectGenericAssociation(controlType, node.associations, aggregates, node.location);
  node.selected = selected;
  return selected;
};

  return { inferExpressionType, resolveGenericSelection };
}
