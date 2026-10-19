import type { CType, Expression, Initializer, Parameter, Statement } from './internal.ts';
import { enforceLimit, failure } from './internal.ts';
import { alignOfType, arrayOf, arrayType, compatibleType, containsFlexibleAggregate, functionType, isAggregate, isArray, isComplete, isFunction, qualifiersOf, hasVariableLengthBound, hasVariableLengthObjectSize, unqualifiedType } from './type-system.ts';
import type { DeclarationGrammar, ParserContext } from './parser-context-types.ts';

export function createDeclarationGrammar(context: ParserContext): DeclarationGrammar {
  const { limits, aggregates, functions, globals, fileLinkage, translationUnit } = context;
  const peek = (offset = 0) => context.peek(offset);
  const consume = () => context.consume();
  const expect = (text: string) => context.expect(text);
  const newDeclarationSpecifiers = () => context.typeSpecifiers.newDeclarationSpecifiers();
  const parseTypeSpecifier = (...args: Parameters<ParserContext['typeSpecifiers']['parseTypeSpecifier']>) => context.typeSpecifiers.parseTypeSpecifier(...args);
  const consumeDeclarationSpecifier = (...args: Parameters<ParserContext['typeSpecifiers']['consumeDeclarationSpecifier']>) => context.typeSpecifiers.consumeDeclarationSpecifier(...args);
  const parseDeclarator = (...args: Parameters<ParserContext['declarators']['parseDeclarator']>) => context.declarators.parseDeclarator(...args);
  const declaredType = (...args: Parameters<ParserContext['declarators']['declaredType']>) => context.declarators.declaredType(...args);
  const isConstObjectType = (...args: Parameters<ParserContext['declarators']['isConstObjectType']>) => context.declarators.isConstObjectType(...args);
  const parseInitializer = () => context.initializers.parseInitializer();
  const setParserMap = <K, V>(map: Map<K, V>, key: K, value: V) => context.setParserMap(map, key, value);
  const declareOrdinary = (...args: Parameters<ParserContext['declareOrdinary']>) => context.declareOrdinary(...args);
  const declareTypedef = (...args: Parameters<ParserContext['declareTypedef']>) => context.declareTypedef(...args);
  const setOrdinaryType = (...args: Parameters<ParserContext['setOrdinaryType']>) => context.setOrdinaryType(...args);
  const captureGlobalState = (...args: Parameters<ParserContext['captureGlobalState']>) => context.captureGlobalState(...args);
  const inferArrayType = (type: CType, initializer: Initializer | undefined): CType => {
    const array = arrayType(type);
    if (!array || array.length !== null || array.lengthExpression) return type;
    if (!initializer) return type;
    let length = 0;
    let stringLiteral: Extract<Expression, { kind: 'string' }> | undefined;
    if (initializer.kind === 'expression' && initializer.value.kind === 'string') {
      stringLiteral = initializer.value;
    } else if (initializer.kind === 'list' && initializer.items.length === 1 && initializer.items[0].designators.length === 0) {
      const item = initializer.items[0].initializer;
      if (item.kind === 'expression' && item.value.kind === 'string') stringLiteral = item.value;
    }
    if (stringLiteral && unqualifiedType(array.element) === 'char') {
      length = stringLiteral.bytes.length;
    } else if (initializer.kind === 'list') {
      let next = 0;
      for (const item of initializer.items) {
        const designator = item.designators[0];
        if (designator?.kind === 'index') next = Number(designator.index) + 1;
        else next++;
        length = Math.max(length, next);
      }
    }
    if (!length) failure('INCOMPLETE_TYPE', 'An incomplete array requires an initializer that determines its length.', initializer.location);
    return arrayOf(array.element, length);
  };

  const parseDeclaration = (depth: number, local: boolean): Statement => {
    const at = peek();
    enforceLimit('maxDepth', depth, limits.maxDepth, at);
    const specifiers = newDeclarationSpecifiers();
    const base = parseTypeSpecifier((token) => consumeDeclarationSpecifier(specifiers, token));
    const {
      static: isStatic, extern: isExtern, typedef: isTypedef, threadLocal: isThreadLocal,
      auto: isAuto, register: isRegister, inline: isInline, noreturn: isNoreturn,
    } = specifiers;
    const alignments = specifiers.alignments;
    const storageClassCount = Number(isStatic) + Number(isExtern) + Number(isTypedef) + Number(isAuto) + Number(isRegister);
    if (storageClassCount > 1 || isThreadLocal && (isTypedef || isAuto || isRegister) || !local && (isAuto || isRegister)) {
      failure('TYPE_ERROR', 'Incompatible or invalid storage classes in this scope.', at);
    }
    if (local && isRegister && alignments.length) {
      failure('TYPE_ERROR', '_Alignas cannot be applied to a register object.', at);
    }
    if (isThreadLocal && local && !isStatic && !isExtern) failure('TYPE_ERROR', '_Thread_local at block scope requires static or extern.', at);
    if (!local && isThreadLocal && !isStatic && !isExtern) failure('TYPE_ERROR', '_Thread_local at file scope requires static or extern.', at);
    const baseQualifiers = { ...context.lastSpecifierQualifiers };
    const standaloneTag = context.lastSpecifierDefinesTag;
    if (peek().text === ';' && (isAggregate(base) || standaloneTag)) {
      if (alignments.length || isStatic || isExtern || isTypedef || isThreadLocal || isAuto || isRegister || isInline || isNoreturn) {
        failure('TYPE_ERROR', 'Storage/alignment specifiers require a declarator.', at);
      }
      consume(); return { kind: 'empty', location: at };
    }
    if (isInline || isNoreturn) failure('TYPE_ERROR', 'inline and _Noreturn only apply to function declarations.', at);
    if (isTypedef) {
      if (alignments.length || isThreadLocal) failure('TYPE_ERROR', 'typedef does not allow _Alignas or _Thread_local.', at);
      const declarations: Statement[] = [];
      do {
        const declarator = parseDeclarator(false);
        const type = declaredType(declarator, base, baseQualifiers);
        if (hasVariableLengthBound(type) && !local) failure('TYPE_ERROR', 'A variably modified type can only be declared at block scope.', declarator.location);
        if (peek().text === '=') failure('SYNTAX_ERROR', 'A typedef cannot have an initializer.', peek());
        declareTypedef(declarator.name, type, isConstObjectType(type), declarator.location);
        if (hasVariableLengthBound(type)) declarations.push({ kind: 'typeDeclaration', type, location: declarator.location });
        if (peek().text !== ',') break;
        consume();
      } while (true);
      expect(';');
      if (!declarations.length) return { kind: 'empty', location: at };
      if (declarations.length === 1) return declarations[0];
      return { kind: 'sequence', statements: declarations, location: at };
    }
    const declarations: Statement[] = [];
    do {
      const declarator = parseDeclarator(false);
      let type = declaredType(declarator, base, baseQualifiers);
      if (isFunction(type)) {
        if (hasVariableLengthBound(functionType(type)!.returnType)) failure('TYPE_ERROR', 'A function cannot return a variably modified type.', declarator.location);
        if (!local) failure('ENGINE_INTERNAL_ERROR', 'File-scope function declarations must be handled by the outer parser.', declarator.location);
        if (alignments.length || isStatic || isThreadLocal || isAuto || isRegister) failure('TYPE_ERROR', 'A function declaration does not allow this storage or alignment specifier.', declarator.location);
        if (peek().text === '=') failure('TYPE_ERROR', 'A function declaration cannot have an initializer.', peek());
        declareOrdinary(declarator.name, declarator.location, type);
        const priorLinkage = fileLinkage.get(declarator.name);
        const linkage: 'internal' | 'external' = priorLinkage ?? 'external';
        setParserMap(fileLinkage, declarator.name, linkage);
        const fnType = functionType(type)!;
        const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
        const parameters: Parameter[] = (declarator.parameters ?? []).map((parameter, index) => ({
          ...parameter, type: fnType.parameters[index] ?? parameter.type,
        }));
        functions.push({
          name: declarator.name, returnType: fnType.returnType, parameters, bindings: [], location: declarator.location,
          linkage, symbolKey, translationUnit, variadic: !!fnType.variadic, prototype: fnType.prototype !== false,
          oldStyle: !!declarator.oldStyle, inline: isInline, extern: isExtern,
        });
        if (peek().text !== ',') break;
        consume();
        continue;
      }
      if (unqualifiedType(type) === 'void') failure('TYPE_ERROR', 'A variable cannot have type void.', declarator.location);
      if (hasVariableLengthBound(type) && !local) {
        failure('TYPE_ERROR', 'A variably modified type can only be declared at block or function prototype scope.', declarator.location);
      }
      if (hasVariableLengthBound(type) && isExtern) {
        failure('TYPE_ERROR', 'An identifier with a variably modified type cannot have linkage.', declarator.location);
      }
      if (hasVariableLengthObjectSize(type) && (isStatic || isThreadLocal)) {
        failure('TYPE_ERROR', 'An object with variable-length array type cannot have static or thread storage duration.', declarator.location);
      }
      if (isInline || isNoreturn) failure('TYPE_ERROR', 'inline and _Noreturn only apply to functions.', declarator.location);
      let initializer: Initializer | undefined;
      declareOrdinary(declarator.name, declarator.location, type);
      if (peek().text === '=') {
        if (local && isExtern) failure('TYPE_ERROR', 'A block-scope extern object cannot have an initializer.', peek());
        consume();
        const priorDuration = context.expressionDuration;
        if (isStatic || isThreadLocal) context.expressionDuration = 'static';
        try { initializer = parseInitializer(); } finally { context.expressionDuration = priorDuration; }
      }
      type = inferArrayType(type, initializer);
      if (isArray(type) && hasVariableLengthBound(type) && initializer) {
        failure('TYPE_ERROR', 'A variable-length array cannot have an initializer.', declarator.location);
      }
      setOrdinaryType(declarator.name, type);
      const incompleteExternArray = isExtern && arrayType(type)?.length === null && !arrayType(type)?.lengthExpression && isComplete(arrayType(type)!.element, aggregates);
      if (!isComplete(type, aggregates) && !incompleteExternArray) failure('INCOMPLETE_TYPE', 'The declared object must have a complete type.', declarator.location);
      if (arrayType(type) && containsFlexibleAggregate(arrayType(type)!.element, aggregates)) failure('TYPE_ERROR', 'Cannot declare an array of a struct that contains a flexible member.', declarator.location);
      const requestedAlignment = alignments.filter((value) => value > 0);
      const naturalAlignment = alignOfType(type, aggregates, declarator.location);
      if (requestedAlignment.some((value) => value < naturalAlignment)) failure('TYPE_ERROR', '_Alignas cannot reduce the object’s natural alignment.', declarator.location);
      const alignment = Math.max(naturalAlignment, ...requestedAlignment, 1);
      if (local && isExtern) {
        const linkage = fileLinkage.get(declarator.name) ?? 'external';
        setParserMap(fileLinkage, declarator.name, linkage);
        const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
        const prior = globals.find((global) => global.symbolKey === symbolKey);
        if (prior && (!compatibleType(prior.type, type) || !!prior.threadLocal !== isThreadLocal)) {
          failure('CONFLICTING_TYPES', `Incompatible declarations of object «${declarator.name}».`, declarator.location);
        }
        const global = prior ?? {
          id: globals.length, name: declarator.name, type, location: declarator.location, linkage, symbolKey,
          translationUnit, declarationOnly: true, isConst: isConstObjectType(type), qualifiers: qualifiersOf(type),
          alignment, requestedAlignment: requestedAlignment.length ? Math.max(...requestedAlignment) : undefined, threadLocal: isThreadLocal,
        };
        if (!prior) globals.push(global);
        else {
          captureGlobalState(prior);
          global.alignment = Math.max(global.alignment ?? naturalAlignment, alignment);
          global.requestedAlignment = Math.max(global.requestedAlignment ?? 0, ...requestedAlignment, 0) || undefined;
        }
        declarations.push({ kind: 'declaration', name: declarator.name, type, extern: true, threadLocal: isThreadLocal, const: isConstObjectType(type), alignment, requestedAlignment: requestedAlignment.length ? Math.max(...requestedAlignment) : undefined, symbolKey, location: declarator.location });
      } else {
        declarations.push({
          kind: 'declaration', name: declarator.name, type, initializer, static: isStatic || isThreadLocal,
          const: isConstObjectType(type), threadLocal: isThreadLocal, register: isRegister,
          alignment, requestedAlignment: requestedAlignment.length ? Math.max(...requestedAlignment) : undefined, location: declarator.location,
        });
      }
      if (peek().text !== ',') break;
      consume();
    } while (true);
    expect(';');
    if (!declarations.length) return { kind: 'empty', location: at };
    if (declarations.length === 1) return declarations[0];
    return { kind: 'sequence', statements: declarations, location: at };
  };

  return { inferArrayType, parseDeclaration };
}
