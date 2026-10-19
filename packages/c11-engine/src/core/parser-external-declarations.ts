import type { FunctionIR, Initializer, Parameter, Token } from './internal.ts';
import { failure } from './internal.ts';
import { alignOfType, arrayType, compatibleType, containsFlexibleAggregate, decayType, functionType, isAggregate, isArray, isComplete, isFunction, qualifiersOf, hasVariableLengthBound, unqualifiedType } from './type-system.ts';
import type { ParserContext } from './parser-context-types.ts';

export function parseExternalDeclaration(context: ParserContext): void {
  const { functions, aggregates, globals, fileLinkage, translationUnit } = context;
  const at = context.peek();
  const peek = (offset = 0) => context.peek(offset);
  const consume = () => context.consume();
  const expect = (text: string) => context.expect(text);
  const newDeclarationSpecifiers = () => context.typeSpecifiers.newDeclarationSpecifiers();
  const consumeDeclarationSpecifier = (...args: Parameters<ParserContext['typeSpecifiers']['consumeDeclarationSpecifier']>) => context.typeSpecifiers.consumeDeclarationSpecifier(...args);
  const parseTypeSpecifier = (...args: Parameters<ParserContext['typeSpecifiers']['parseTypeSpecifier']>) => context.typeSpecifiers.parseTypeSpecifier(...args);
  const parseDeclarator = (...args: Parameters<ParserContext['declarators']['parseDeclarator']>) => context.declarators.parseDeclarator(...args);
  const declaredType = (...args: Parameters<ParserContext['declarators']['declaredType']>) => context.declarators.declaredType(...args);
  const isConstObjectType = (...args: Parameters<ParserContext['declarators']['isConstObjectType']>) => context.declarators.isConstObjectType(...args);
  const parseBody = (...args: Parameters<ParserContext['statements']['parseBody']>) => context.statements.parseBody(...args);
  const inferArrayType = (...args: Parameters<ParserContext['declarations']['inferArrayType']>) => context.declarations.inferArrayType(...args);
  const parseInitializer = () => context.initializers.parseInitializer();
  const setParserMap = <K, V>(map: Map<K, V>, key: K, value: V) => context.setParserMap(map, key, value);
  const setOrdinaryType = (...args: Parameters<ParserContext['setOrdinaryType']>) => context.setOrdinaryType(...args);
  const popTags = () => context.popTags();
  const restoreTags = (...args: Parameters<ParserContext['restoreTags']>) => context.restoreTags(...args);
  const declareOrdinary = (...args: Parameters<ParserContext['declareOrdinary']>) => context.declareOrdinary(...args);
  const declareTypedef = (...args: Parameters<ParserContext['declareTypedef']>) => context.declareTypedef(...args);
  const isDeclarationStart = (token?: Token) => context.isDeclarationStart(token);
  const captureGlobalState = (...args: Parameters<ParserContext['captureGlobalState']>) => context.captureGlobalState(...args);

  const specifiers = newDeclarationSpecifiers();
  const base = parseTypeSpecifier((token) => consumeDeclarationSpecifier(specifiers, token));
  const {
    static: isStatic, extern: isExtern, typedef: isTypedef, inline: isInline,
    noreturn: isNoreturn, threadLocal: isThreadLocal, auto: isAuto, register: isRegister,
  } = specifiers;
  const alignments = specifiers.alignments;
  const storageClassCount = Number(isStatic) + Number(isExtern) + Number(isTypedef) + Number(isAuto) + Number(isRegister);
  if (storageClassCount > 1 || isTypedef && (isInline || isNoreturn || isThreadLocal || alignments.length) ||
      isAuto || isRegister) {
    failure('TYPE_ERROR', 'Incompatible storage classes or function specifiers.', at);
  }
  const baseQualifiers = { ...context.lastSpecifierQualifiers };
  const standaloneTag = context.lastSpecifierDefinesTag;
  if ((isAggregate(base) || standaloneTag) && peek().text === ';') {
    if (isStatic || isExtern || isTypedef || isAuto || isRegister || isInline || isNoreturn || isThreadLocal || alignments.length) failure('TYPE_ERROR', 'Storage/alignment specifiers require a declarator.', at);
    consume(); return;
  }
  let first = true;
  while (true) {
    const declarator = parseDeclarator(false, false, { retainFirst: true });
    const type = declaredType(declarator, base, baseQualifiers);
    const parameterScope = declarator.parameterScope;
    const detachedScope = parameterScope ? popTags() : undefined;
    if (parameterScope && (!detachedScope || detachedScope.tags !== parameterScope.tags || detachedScope.enumTags !== parameterScope.enumTags ||
        detachedScope.ordinary !== parameterScope.ordinary || detachedScope.ordinaryTypes !== parameterScope.ordinaryTypes || detachedScope.typedefs !== parameterScope.typedefs)) {
      failure('ENGINE_INTERNAL_ERROR', 'The parameter scope does not match the declarator scope stack.', declarator.location);
    }
    if (isTypedef) {
      if (alignments.length || isThreadLocal) failure('TYPE_ERROR', 'typedef does not allow _Alignas or _Thread_local.', declarator.location);
      if (hasVariableLengthBound(type)) failure('TYPE_ERROR', 'A variably modified type can only be declared at block scope.', declarator.location);
      if (peek().text === '=') failure('SYNTAX_ERROR', 'A typedef cannot have an initializer.', peek());
      declareTypedef(declarator.name, type, isConstObjectType(type), declarator.location);
      if (peek().text !== ',') break;
      consume(); first = false; continue;
    }
    if (isFunction(type)) {
      if (alignments.length || isThreadLocal) failure('TYPE_ERROR', '_Alignas and _Thread_local cannot be applied to functions.', declarator.location);
      declareOrdinary(declarator.name, declarator.location, type);
      const fnType = functionType(type)!;
      if (hasVariableLengthBound(fnType.returnType)) failure('TYPE_ERROR', 'A function cannot return a variably modified type.', declarator.location);
      let linkage: 'internal' | 'external' = isStatic ? 'internal' : 'external';
      if (isExtern && fileLinkage.get(declarator.name) === 'internal') linkage = 'internal';
      const previousLinkage = fileLinkage.get(declarator.name);
      if (previousLinkage && previousLinkage !== linkage) failure('CONFLICTING_LINKAGE', `Function «${declarator.name}» mixes internal and external linkage.`, declarator.location);
      setParserMap(fileLinkage, declarator.name, linkage);
      const parameterTypes = fnType.parameters;
      const sourceParameters = declarator.parameters ?? [];
      const parameters: Parameter[] = parameterTypes.map((parameterType, index) => ({
        name: sourceParameters[index]?.name ?? '', type: parameterType, isConst: !!qualifiersOf(parameterType).const, qualifiers: qualifiersOf(parameterType), register: sourceParameters[index]?.register,
        ...(sourceParameters[index]?.prototypeVariableLengthBound ? { prototypeVariableLengthBound: true } : {}),
        ...(sourceParameters[index]?.minimumArrayBound !== undefined ? { minimumArrayBound: sourceParameters[index].minimumArrayBound } : {}),
        ...(sourceParameters[index]?.variableLengthBounds ? { variableLengthBounds: sourceParameters[index].variableLengthBounds } : {}),
        location: sourceParameters[index]?.location ?? declarator.location,
      }));
      const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
      const fn: FunctionIR = {
        name: declarator.name, returnType: fnType.returnType, parameters, bindings: [], location: at,
        linkage, symbolKey, translationUnit, variadic: !!fnType.variadic, prototype: fnType.prototype !== false,
        oldStyle: !!declarator.oldStyle, inline: isInline, extern: isExtern, noreturn: isNoreturn,
      };
      if (peek().text === '{' || declarator.oldStyle && isDeclarationStart()) {
        if (!first) failure('SYNTAX_ERROR', 'A function definition must be a separate external declaration.', peek());
        if (sourceParameters.some((parameter) => parameter.prototypeVariableLengthBound)) {
          failure('TYPE_ERROR', 'An array declarator using `[*]` is only permitted in function prototype scope.', declarator.location);
        }
        if (isNoreturn && declarator.name === 'main') failure('TYPE_ERROR', 'main cannot be declared _Noreturn.', declarator.location);
        if (parameterScope) restoreTags(parameterScope);
        if (unqualifiedType(fn.returnType) !== 'void' && !isComplete(fn.returnType, aggregates)) {
          failure('INCOMPLETE_TYPE', 'A function definition requires a complete object or void return type.', declarator.location);
        }
        if (declarator.oldStyle) {
          const byName = new Map(parameters.map((parameter, index) => [parameter.name, index]));
          const declared = new Set<string>();
          while (isDeclarationStart() && peek().text !== '{') {
            const declarationAt = peek();
            if (['static', 'extern', 'typedef', 'inline', '_Noreturn'].includes(peek().text)) {
              failure('SYNTAX_ERROR', 'A K&R parameter declaration must specify only its type and declarator.', declarationAt);
            }
            const parameterSpecifiers = newDeclarationSpecifiers();
            const parameterBase = parseTypeSpecifier((token) => {
              if (token.text !== 'register') failure('TYPE_ERROR', 'register is the only storage class allowed for a K&R parameter.', token);
              consumeDeclarationSpecifier(parameterSpecifiers, token);
            });
            const registerParameter = parameterSpecifiers.register;
            const parameterQualifiers = { ...context.lastSpecifierQualifiers };
            do {
              const parameterDeclarator = parseDeclarator(false);
              const index = byName.get(parameterDeclarator.name);
              if (index === undefined) failure('UNKNOWN_IDENTIFIER', `«${parameterDeclarator.name}» is not in the K&R parameter list.`, parameterDeclarator.location);
              if (declared.has(parameterDeclarator.name)) failure('REDECLARATION', `K&R parameter «${parameterDeclarator.name}» is declared more than once.`, parameterDeclarator.location);
              if (peek().text === '=') failure('SYNTAX_ERROR', 'A parameter cannot have an initializer.', peek());
              let parameterType = declaredType(parameterDeclarator, parameterBase, parameterQualifiers);
              if (isArray(parameterType) || isFunction(parameterType)) parameterType = decayType(parameterType);
              if (parameterType === 'void' || !isComplete(parameterType, aggregates)) failure('TYPE_ERROR', 'A K&R parameter requires a complete object type.', parameterDeclarator.location);
              parameters[index] = { name: parameterDeclarator.name, type: parameterType, isConst: isConstObjectType(parameterType), qualifiers: qualifiersOf(parameterType), register: registerParameter, location: parameterDeclarator.location };
              declared.add(parameterDeclarator.name);
              if (peek().text !== ',') break;
              consume();
            } while (true);
            expect(';');
          }
        }
        if (parameters.some(parameter => !parameter.name)) failure('SYNTAX_ERROR', 'Parameters in a definition must have names.', fn.location);
        if (!declarator.prototype && !declarator.oldStyle && parameters.length) failure('TYPE_ERROR', 'A definition without a prototype cannot have typed parameters.', fn.location);
        if (parameters.some(parameter => !isComplete(parameter.type, aggregates))) {
          const incompleteParameter = parameters.find(parameter => !isComplete(parameter.type, aggregates))!;
          failure('INCOMPLETE_TYPE', 'A parameter in a definition must have a complete type after adjustments.', incompleteParameter.location);
        }
        fn.parameters = parameters;
        fn.body = parseBody(1, parameters);
        if (parameterScope) popTags();
      } else if (peek().text !== ',') expect(';');
      functions.push(fn);
    } else {
      if (isInline || isNoreturn) failure('TYPE_ERROR', 'inline and _Noreturn only apply to functions.', declarator.location);
      if (hasVariableLengthBound(type)) failure('TYPE_ERROR', 'A variably modified type can only be declared at block or function prototype scope.', declarator.location);
      declareOrdinary(declarator.name, declarator.location, type);
      if (unqualifiedType(type) === 'void' || isFunction(type) || !isComplete(type, aggregates) && !isArray(type)) failure('TYPE_ERROR', 'A global object requires a valid object type.', declarator.location);
      let initializer: Initializer | undefined;
      if (peek().text === '=') {
        consume();
        const priorDuration: 'automatic' | 'static' = context.expressionDuration; context.expressionDuration = 'static';
        try { initializer = parseInitializer(); } finally { context.expressionDuration = priorDuration; }
      }
      const inferredType = inferArrayType(type, initializer);
      setOrdinaryType(declarator.name, inferredType);
      const inferredArray = arrayType(inferredType);
      const incompleteArray = !!inferredArray && inferredArray.length === null && isComplete(inferredArray.element, aggregates);
      const incompleteTentativeArray = incompleteArray && !initializer && !isExtern;
      if (!isComplete(inferredType, aggregates) && !(incompleteArray && (isExtern || incompleteTentativeArray))) failure('INCOMPLETE_TYPE', 'The global object must have a complete type.', declarator.location);
      if (inferredArray && containsFlexibleAggregate(inferredArray.element, aggregates)) failure('TYPE_ERROR', 'Cannot declare an array of a struct that contains a flexible member.', declarator.location);
      if (isThreadLocal && inferredArray?.length === null && !isExtern) failure('INCOMPLETE_TYPE', 'A thread-local array requires a complete length or a later definition.', declarator.location);
      const requestedAlignment = alignments.filter((value) => value > 0);
      const naturalAlignment = alignOfType(inferredArray?.length === null ? inferredArray.element : inferredType, aggregates, declarator.location);
      if (requestedAlignment.some((value) => value < naturalAlignment)) failure('TYPE_ERROR', '_Alignas cannot reduce the object’s natural alignment.', declarator.location);
      const effectiveAlignment = Math.max(naturalAlignment, ...requestedAlignment, 1);
      let linkage: 'internal' | 'external' = isStatic ? 'internal' : 'external';
      if (isExtern && fileLinkage.get(declarator.name) === 'internal') linkage = 'internal';
      const previousLinkage = fileLinkage.get(declarator.name);
      if (previousLinkage && previousLinkage !== linkage) failure('CONFLICTING_LINKAGE', `Object «${declarator.name}» mixes internal and external linkage.`, declarator.location);
      setParserMap(fileLinkage, declarator.name, linkage);
      const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
      const prior = globals.find(global => global.symbolKey === symbolKey);
      if (prior) {
        captureGlobalState(prior);
        const isConst = isConstObjectType(inferredType);
        if (!!prior.isConst !== isConst || !!prior.threadLocal !== isThreadLocal || !compatibleType(prior.type, inferredType)) failure('CONFLICTING_TYPES', `Incompatible declarations of object «${declarator.name}».`, declarator.location);
        if (prior.initializer && initializer) failure('REDEFINITION', `Global object «${declarator.name}» already has a definition.`, declarator.location);
        if (!prior.initializer && initializer) prior.initializer = initializer;
        prior.tentative = prior.tentative || !isExtern && !initializer;
        prior.declarationOnly = prior.declarationOnly && isExtern && !initializer;
        if (!isComplete(prior.type, aggregates) && isComplete(inferredType, aggregates)) prior.type = inferredType;
        prior.alignment = Math.max(prior.alignment ?? naturalAlignment, effectiveAlignment);
        prior.requestedAlignment = Math.max(prior.requestedAlignment ?? 0, ...requestedAlignment, 0) || undefined;
      } else {
        globals.push({
          id: globals.length, name: declarator.name, type: inferredType, initializer, location: declarator.location,
          linkage, symbolKey, translationUnit, tentative: !isExtern && !initializer,
          declarationOnly: isExtern && !initializer, isConst: isConstObjectType(inferredType), qualifiers: qualifiersOf(inferredType),
          alignment: effectiveAlignment, requestedAlignment: requestedAlignment.length ? Math.max(...requestedAlignment) : undefined,
          threadLocal: isThreadLocal,
        });
      }
    }
    first = false;
    if (peek().text !== ',') break;
    consume();
    if (functions.length && functions[functions.length - 1].location === at && functions[functions.length - 1].body) failure('SYNTAX_ERROR', 'A function definition cannot share declarators.', at);
  }
  if (peek().text === ';') consume();
}
