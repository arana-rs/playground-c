import type { CType, Expression, Token, TypeQualifiers, Location, Parameter } from './internal.ts';
import { failure } from './internal.ts';
import {
  arrayOf, arrayType, decayType, functionOf, functionType, isArray, isComplete,
  isFunction, isInteger, pointerTo, pointerType, pointedToType, qualifyType, qualifiersOf,
  unqualifiedType, variableLengthArrayTypes,
} from './type-system.ts';
import { constantExpression, isIntegerConstantExpression } from './parser-constant-expressions.ts';
import type { Declarator, ParameterScopeContext, ParserContext, DeclaratorGrammar } from './parser-context-types.ts';
import { C_KEYWORDS } from '../syntax.ts';

const reserved = new Set(C_KEYWORDS);

export function createDeclaratorGrammar(context: ParserContext): DeclaratorGrammar {
  const { aggregates } = context;
  const peek = (offset = 0): Token => context.peek(offset);
  const consume = (): Token => context.consume();
  const expect = (text: string): Token => context.expect(text);
  const identifier = (): Token => context.identifier();
  const pushTags = () => context.pushTags();
  const popTags = () => context.popTags();
  const declareOrdinary = (name: string, location: Location, type?: CType) => context.declareOrdinary(name, location, type);
  const startsType = (token = peek()) => context.startsType(token);
  const resolveGenericSelection = context.expressions.resolveGenericSelection;
  const inferExpressionType = (node: Expression) => context.expressions.inferExpressionType(node);

const parseArrayBound = (): { length: number | null; expression?: Expression } => {
  if (peek().text === ']') {
    consume();
    return { length: null };
  }
  const at = peek();
  const expression = context.expressions.parseExpression(1, new Set([']']));
  consume();
  if (isIntegerConstantExpression(expression, aggregates, resolveGenericSelection)) {
    const value = constantExpression(expression, aggregates, resolveGenericSelection);
    if (!isInteger(value.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', 'The array length must have integer type.', at);
    if (value.value <= 0n || value.value > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'Array length must be positive and representable.', at);
    return { length: Number(value.value) };
  }
  const inferredType = inferExpressionType(expression);
  if (inferredType && !isInteger(inferredType)) failure('TYPE_ERROR', 'A variable-length array bound must have integer type.', at);
  return { length: null, expression };
};

const parseDeclarator = (abstractAllowed: boolean, parameterDeclarator = false, parameterScopeContext?: ParameterScopeContext): Declarator => {
  const start = peek();
  const pointerQualifiers: TypeQualifiers[] = [];
  while (peek().text === '*') {
    consume();
    const qualifiers: { const?: boolean; restrict?: boolean; volatile?: boolean } = {};
    while (peek().text === 'const' || peek().text === 'restrict' || peek().text === 'volatile') {
      const qualifier = consume();
      if (qualifier.text === 'const') qualifiers.const = true;
      else if (qualifier.text === 'restrict') qualifiers.restrict = true;
      else qualifiers.volatile = true;
    }
    pointerQualifiers.push(qualifiers);
  }
  let name = '';
  let location: Location = start;
  let declaredParameters: Parameter[] | undefined;
  let declaredPrototype: boolean | undefined;
  let declaredVariadic = false;
  let declaredOldStyle = false;
  let parameterArrayQualifiers: TypeQualifiers | undefined;
  let minimumArrayBound: number | undefined;
  let prototypeVariableLengthBound = false;
  let direct: (base: CType) => CType;
  if (peek().text === '(' && (peek(1).text === '*' || peek(1).text === '(' || peek(1).kind === 'identifier')) {
    consume();
    const nested = parseDeclarator(abstractAllowed, parameterDeclarator, parameterScopeContext);
    expect(')');
    name = nested.name; location = nested.location; direct = nested.apply; declaredParameters = nested.parameters;
    declaredPrototype = nested.prototype; declaredVariadic = !!nested.variadic; declaredOldStyle = !!nested.oldStyle;
    parameterArrayQualifiers = nested.parameterArrayQualifiers;
    minimumArrayBound = nested.minimumArrayBound;
    prototypeVariableLengthBound = !!nested.prototypeVariableLengthBound;
  } else if (peek().kind === 'identifier' && !reserved.has(peek().text)) {
    const token = identifier(); name = token.text; location = token; direct = base => base;
  } else if (abstractAllowed) {
    direct = base => base;
  } else {
    if (peek().text === '[') failure('SYNTAX_ERROR', 'A declared array requires an identifier.', peek());
    failure('SYNTAX_ERROR', 'Expected a named declarator.', peek());
  }
  let sawArraySuffix = false;
  while (true) {
    if (peek().text === '[') {
      const bracket = consume();
      const supportsParameterArrayModifiers = parameterDeclarator && !sawArraySuffix;
      const arrayQualifiers: TypeQualifiers = {};
      let hasStaticMinimum = false;
      if (peek().text === 'static') {
        if (!supportsParameterArrayModifiers) failure('TYPE_ERROR', 'static inside brackets is only allowed in an array parameter declarator.', peek());
        consume(); hasStaticMinimum = true;
      }
      while (['const', 'volatile', 'restrict'].includes(peek().text)) {
        if (!supportsParameterArrayModifiers) failure('TYPE_ERROR', 'Array qualifiers are only allowed in an array parameter declarator.', peek());
        const qualifier = consume().text as keyof TypeQualifiers;
        (arrayQualifiers as { const?: boolean; volatile?: boolean; restrict?: boolean })[qualifier] = true;
      }
      if (peek().text === 'static') {
        if (!supportsParameterArrayModifiers || hasStaticMinimum) failure('TYPE_ERROR', 'static inside brackets is only allowed once in an array parameter.', peek());
        consume(); hasStaticMinimum = true;
      }
      let bound: { length: number | null; expression?: Expression };
      if (peek().text === '*') {
        if (!parameterDeclarator) failure('TYPE_ERROR', 'An array declarator using `[*]` is only permitted in function prototype scope.', bracket);
        consume();
        expect(']');
        bound = { length: null };
        prototypeVariableLengthBound = true;
      } else bound = parseArrayBound();
      const { length } = bound;
      if (hasStaticMinimum && length === null && !bound.expression) failure('TYPE_ERROR', 'A static parameter bound requires a positive length.', bracket);
      if (Object.values(arrayQualifiers).some(Boolean) || hasStaticMinimum) {
        parameterArrayQualifiers = arrayQualifiers;
        if (hasStaticMinimum && length !== null) minimumArrayBound = length;
      }
      sawArraySuffix = true;
      const previous = direct;
      direct = base => previous(arrayOf(base, length, bound.expression)); continue;
    }
    if (peek().text === '(') {
      consume();
      const parameterScope = pushTags();
      const parameters: Parameter[] = [];
      const parameterTypes: CType[] = [];
      let prototype = true;
      let variadic = false;
      let oldStyle = false;
      if (peek().text === ')') {
        prototype = false;
      } else if (peek().text === 'void' && peek(1).text === ')') consume();
      else if (!startsType() && peek().kind === 'identifier' && !reserved.has(peek().text)) {
        oldStyle = true;
        prototype = false;
        const names: Token[] = [];
        do {
          const parameter = identifier();
          names.push(parameter);
          declareOrdinary(parameter.text, parameter, 'int');
          if (peek().text !== ',') break;
          consume();
          if (peek().text === ')') failure('SYNTAX_ERROR', 'An identifier is missing from the old-style parameter list.', peek());
        } while (true);
        for (const parameter of names) {
          parameters.push({ name: parameter.text, type: 'int', location: parameter });
          parameterTypes.push('int');
        }
      } else {
        while (true) {
          const parameterAt = peek();
          if (peek().text === '...') {
            if (!parameters.length) failure('SYNTAX_ERROR', 'A variadic function requires at least one typed parameter.', peek());
            consume(); variadic = true; break;
          }
          const parameterSpecifiers = context.typeSpecifiers.newDeclarationSpecifiers();
          const parameterBase = context.typeSpecifiers.parseTypeSpecifier((token) => {
            if (token.text !== 'register') failure('TYPE_ERROR', 'register is the only storage class allowed for a parameter.', token);
            context.typeSpecifiers.consumeDeclarationSpecifier(parameterSpecifiers, token);
          });
          const registerParameter = parameterSpecifiers.register;
          const parameterQualifiers = { ...context.lastSpecifierQualifiers };
          const parameterDeclarator = parseDeclarator(true, true);
          let parameterType = declaredType(parameterDeclarator, parameterBase, parameterQualifiers);
          if (parameterType === 'void') failure('TYPE_ERROR', 'void may only appear as an empty parameter list.', parameterAt);
          const variableLengthBounds = variableLengthArrayTypes(parameterType)
            .filter((array) => array.lengthExpression !== undefined);
          if (parameterDeclarator.parameterArrayQualifiers && !isArray(parameterType)) {
            failure('TYPE_ERROR', 'static and bracket qualifiers only apply to a parameter’s outer array.', parameterAt);
          }
          const minimumArrayBound = parameterDeclarator.minimumArrayBound;
          if (isArray(parameterType)) {
            parameterType = qualifyType(decayType(parameterType), parameterDeclarator.parameterArrayQualifiers ?? {});
            validateRestrictType(parameterType, parameterAt);
          } else if (isFunction(parameterType)) parameterType = decayType(parameterType);
          const parameterConst = !!qualifiersOf(parameterType).const;
          const isConst = parameterConst;
          parameters.push({ name: parameterDeclarator.name, type: parameterType, isConst, qualifiers: qualifiersOf(parameterType), register: registerParameter,
            ...(variableLengthBounds.length ? { variableLengthBounds } : {}),
            ...(parameterDeclarator.prototypeVariableLengthBound ? { prototypeVariableLengthBound: true } : {}),
            ...(minimumArrayBound !== undefined ? { minimumArrayBound } : {}), location: parameterDeclarator.location });
          parameterTypes.push(parameterType);
          if (parameterDeclarator.name) declareOrdinary(parameterDeclarator.name, parameterDeclarator.location, parameterType);
          if (peek().text !== ',') break;
          consume();
        }
      }
      expect(')');
      if (parameterScopeContext?.retainFirst && !parameterScopeContext.frame) parameterScopeContext.frame = parameterScope;
      else popTags();
      const previous = direct;
      direct = base => previous(functionOf(base, parameterTypes, variadic, prototype));
      declaredParameters = parameters;
      declaredPrototype = prototype;
      declaredVariadic = variadic;
      declaredOldStyle = oldStyle;
      continue;
    }
    break;
  }
  return {
    name, location, parameters: declaredParameters, prototype: declaredPrototype, variadic: declaredVariadic,
    oldStyle: declaredOldStyle, pointerQualifiers,
    ...(parameterScopeContext?.frame ? { parameterScope: parameterScopeContext.frame } : {}),
    ...(parameterArrayQualifiers ? { parameterArrayQualifiers } : {}),
    ...(minimumArrayBound !== undefined ? { minimumArrayBound } : {}),
    ...(prototypeVariableLengthBound ? { prototypeVariableLengthBound: true } : {}),
    apply: (base) => direct(applyPointers(base, pointerQualifiers)),
  };
};
const applyPointers = (base: CType, qualifiers: TypeQualifiers[]): CType => {
  let type = base;
  qualifiers.forEach((qualifier) => { type = qualifyType(pointerTo(type), qualifier); });
  return type;
};
const validateDeclaratorTypeConstraints = (type: CType, at: Location, visited = new Set<CType>()): void => {
  const current = unqualifiedType(type);
  if (typeof current === 'string' || visited.has(current)) return;
  visited.add(current);
  const array = arrayType(current);
  if (array) {
    if (!isComplete(array.element, aggregates)) {
      failure('INCOMPLETE_TYPE', 'An array element must have a complete type.', at);
    }
    validateDeclaratorTypeConstraints(array.element, at, visited);
    return;
  }
  const pointer = pointerType(current);
  if (pointer) {
    validateDeclaratorTypeConstraints(pointer.base, at, visited);
    return;
  }
  const fn = functionType(current);
  if (fn) {
    if (isArray(fn.returnType) || isFunction(fn.returnType)) {
      failure('TYPE_ERROR', 'A function cannot return an array or another function.', at);
    }
    validateDeclaratorTypeConstraints(fn.returnType, at, visited);
    for (const parameter of fn.parameters) validateDeclaratorTypeConstraints(parameter, at, visited);
  }
};
const declaredType = (declarator: Declarator, base: CType, specifiers: TypeQualifiers | boolean = {}): CType => {
  const qualifiers = typeof specifiers === 'boolean' ? specifiers ? { const: true } : {} : specifiers;
  if (qualifiers.restrict && !pointerType(base)) failure('TYPE_ERROR', 'restrict can only qualify a pointer type.', declarator.location);
  const type = declarator.apply(qualifyType(base, qualifiers));
  validateDeclaratorTypeConstraints(type, declarator.location);
  validateRestrictType(type, declarator.location);
  return type;
};
const isConstObjectType = (type: CType, _declarator?: Declarator, _baseConst?: boolean | TypeQualifiers): boolean =>
  !!qualifiersOf(type).const || !!arrayType(type) && isConstObjectType(arrayType(type)!.element);

function validateRestrictType(type: CType, at: Location): void {
  const qualifiers = qualifiersOf(type);
  const pointer = pointerType(type);
  if (qualifiers.restrict && (!pointer || isFunction(pointedToType(type)!))) {
    failure('TYPE_ERROR', 'restrict can only qualify an object pointer.', at);
  }
  const base = unqualifiedType(type);
  if (typeof base === 'string') return;
  if (base.kind === 'pointer') validateRestrictType(base.base, at);
  else if (base.kind === 'array') validateRestrictType(base.element, at);
  else if (base.kind === 'function') {
    validateRestrictType(base.returnType, at);
    for (const parameter of base.parameters) validateRestrictType(parameter, at);
  }
}
  return { parseDeclarator, applyPointers, validateDeclaratorTypeConstraints, declaredType, isConstObjectType, validateRestrictType };
}
