import type { PrepareLimits } from './types.ts';
import { enforceLimit, failure } from './internal.ts';
import {
  INT_MAX, INT_MIN,
} from './internal.ts';
import type {
  AggregateDefinition, AggregateMember, Binding, CType, CValue, Expression, FunctionIR, GlobalObject,
  Initializer, InitializerDesignator, Location, Parameter, ParsedProgram, ScalarCType, Statement, Token,
} from './internal.ts';
import { BUILTINS, binary, commonType, convert, parseLiteral, promote, truth, unary } from './numeric.ts';
import {
  aggregateRef, arrayOf, canConvertPointerType, compatibleType, decayType, functionOf,
  isAggregate, isArray, isArithmetic, isComplete, isFunction, isInteger, isModifiableObject, isObject, isPointer,
  isScalar, layoutAggregate, pointerTo, sameType, sizeOfType, typeName,
} from './type-system.ts';
import { C_KEYWORDS } from '../syntax.ts';
import { LIBRARY_FUNCTIONS } from './headers.ts';

const reserved = new Set(C_KEYWORDS);
const scalarWords = new Set(['char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'void', '_Bool']);
const declarationWords = new Set([...scalarWords, 'struct', 'union', 'enum', 'static', 'extern', 'typedef', 'inline', '_Noreturn', 'const']);
const unsupportedWords = new Set(['auto', 'register', 'volatile', '_Alignas', '_Alignof', '_Atomic', '_Complex', '_Generic', '_Imaginary', '_Static_assert', '_Thread_local']);
const operators: Record<string, number> = {
  ',': 1, '=': 2, '+=': 2, '-=': 2, '*=': 2, '/=': 2, '%=': 2, '&=': 2, '|=': 2, '^=': 2, '<<=': 2, '>>=': 2,
  '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '<<': 11, '>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13,
};
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const floatingClassifications = new Set(['isnan', 'isinf', 'isfinite', 'isnormal', 'signbit', 'fpclassify']);
const vaIntrinsics = new Set(['__builtin_va_start', '__builtin_va_copy', '__builtin_va_end']);
type Block = Extract<Statement, { kind: 'block' }>;
type Declarator = {
  name: string; location: Location; apply: (base: CType, baseConst?: boolean) => CType; parameters?: Parameter[];
  prototype?: boolean; variadic?: boolean; oldStyle?: boolean; pointerQualifiers?: { const?: boolean; restrict?: boolean }[];
};
type TagScope = Map<string, AggregateDefinition>;
type Scope = { names: Map<string, Binding>; owner?: Block | Extract<Statement, { kind: 'for' }> };
type TypedefBinding = { type: CType; isConst?: boolean };

let nextAggregateIdForParser = 0;

const isNullPointerConstant = (node: Expression, aggregates: readonly AggregateDefinition[] = []): boolean => {
  if (node.kind === 'cast' && isPointer(node.targetType) && node.targetType.base === 'void') {
    return isNullPointerConstant(node.operand, aggregates);
  }
  try {
    const value = constantExpression(node, aggregates);
    return isInteger(value.type) && typeof value.value === 'bigint' && value.value === 0n;
  } catch {
    return false;
  }
};

function expressionChildren(node: Expression): Expression[] {
  switch (node.kind) {
    case 'literal': case 'string': case 'variable': case 'function': return [];
    case 'unary': case 'update': case 'cast': case 'decay': return [node.operand];
    case 'sizeof': return node.operand ? [node.operand] : [];
    case 'binary': return [node.left, node.right];
    case 'assignment': return [node.target, node.value];
    case 'conditional': return [node.condition, node.then, node.else];
    case 'index': return [node.base, node.index];
    case 'member': return [node.base];
    case 'compoundLiteral': return [];
    case 'vaArg': return [node.ap];
    case 'call': return [...(node.callee ? [node.callee] : []), ...node.args];
  }
}

export function parse(tokens: Token[], limits: PrepareLimits, translationUnit = tokens[0]?.file ?? 'main.c'): ParsedProgram {
  let cursor = 0;
  const peek = (offset = 0) => tokens[Math.min(cursor + offset, tokens.length - 1)];
  const consume = () => tokens[cursor++];
  const unsupported = (token: Token, message?: string): never => failure('UNSUPPORTED_FEATURE', message ?? `P3 aún no implementa «${token.text}» en este contexto.`, token);
  const expect = (text: string) => {
    const token = peek();
    if (token.text !== text) {
      if (unsupportedWords.has(token.text)) unsupported(token);
      failure('SYNTAX_ERROR', `Se esperaba «${text}»; se encontró ${token.kind === 'eof' ? 'el final del archivo' : `«${token.text}»`}.`, token);
    }
    return consume();
  };
  const identifier = (): Token => {
    const token = peek();
    if (reserved.has(token.text)) failure('SYNTAX_ERROR', `«${token.text}» es una palabra reservada y no puede ser un nombre.`, token);
    if (token.kind !== 'identifier') failure('SYNTAX_ERROR', 'Se esperaba un identificador.', token);
    return consume();
  };
  const typedefScopes: Map<string, TypedefBinding>[] = [new Map()];
  const startsType = (token = peek()) => scalarWords.has(token.text) || token.text === 'struct' || token.text === 'union' || token.text === 'enum' || token.text === 'const' ||
    typedefScopes.some((scope) => scope.has(token.text));
  const aggregates: AggregateDefinition[] = [];
  const tagScopes: TagScope[] = [new Map()];
  const enumTagScopes: Map<string, Location>[] = [new Map()];
  const ordinaryScopes: Map<string, bigint | null>[] = [new Map()];
  let lastSpecifierDefinesTag = false;
  const pushTags = () => { tagScopes.push(new Map()); enumTagScopes.push(new Map()); ordinaryScopes.push(new Map()); typedefScopes.push(new Map()); };
  const popTags = () => { if (tagScopes.length > 1) { tagScopes.pop(); enumTagScopes.pop(); ordinaryScopes.pop(); typedefScopes.pop(); } };
  const lookupTypedef = (name: string): TypedefBinding | undefined => {
    for (let index = typedefScopes.length - 1; index >= 0; index--) {
      if (ordinaryScopes[index]?.has(name)) return undefined;
      const found = typedefScopes[index].get(name);
      if (found) return found;
    }
    return undefined;
  };
  let lastSpecifierConst = false;
  let lastSpecifierVolatile = false;
  let lastSpecifierRestrict = false;
  const lookupEnumTag = (tag: string): { index: number; location: Location } | undefined => {
    for (let index = enumTagScopes.length - 1; index >= 0; index--) {
      const location = enumTagScopes[index].get(tag); if (location) return { index, location };
    }
    return undefined;
  };
  const nearestTagKind = (tag: string): { kind: 'aggregate' | 'enum'; index: number; aggregate?: AggregateDefinition; location: Location } | undefined => {
    const aggregateIndex = tagScopes.map(scope => scope.has(tag)).lastIndexOf(true);
    const enumTag = lookupEnumTag(tag);
    if (enumTag && enumTag.index > aggregateIndex) return { kind: 'enum', index: enumTag.index, location: enumTag.location };
    const aggregate = lookupTag(tag);
    if (aggregate) return { kind: 'aggregate', index: aggregateIndex, aggregate, location: aggregate.location };
    if (enumTag) return { kind: 'enum', index: enumTag.index, location: enumTag.location };
    return undefined;
  };
  const lookupEnumerator = (name: string): bigint | undefined => {
    for (let index = ordinaryScopes.length - 1; index >= 0; index--) {
      if (ordinaryScopes[index].has(name)) return ordinaryScopes[index].get(name) ?? undefined;
    }
    return undefined;
  };
  const declareOrdinary = (name: string, location: Location): void => {
    const scope = ordinaryScopes[ordinaryScopes.length - 1];
    if (typedefScopes.at(-1)?.has(name)) failure('REDECLARATION', `El identificador «${name}» ya es un nombre typedef en este ámbito.`, location);
    if (typeof scope.get(name) === 'bigint') failure('REDECLARATION', `El enumerador «${name}» ya está declarado en este ámbito.`, location);
    scope.set(name, null);
  };
  const declareTypedef = (name: string, type: CType, isConst: boolean, location: Location): void => {
    if (ordinaryScopes.at(-1)?.has(name) || typedefScopes.at(-1)?.has(name)) {
      failure('REDECLARATION', `El identificador «${name}» ya está declarado en este ámbito.`, location);
    }
    typedefScopes.at(-1)!.set(name, { type, isConst });
  };
  const isDeclarationStart = (token = peek()): boolean => declarationWords.has(token.text) || !!lookupTypedef(token.text);
  const lookupTag = (tag: string): AggregateDefinition | undefined => {
    for (let i = tagScopes.length - 1; i >= 0; i--) { const found = tagScopes[i].get(tag); if (found) return found; }
    return undefined;
  };
  const currentTag = (tag: string) => tagScopes[tagScopes.length - 1].get(tag);
  let nextAggregateId = nextAggregateIdForParser;

  const parseAggregateSpecifier = (): CType => {
    const kindToken = consume();
    const kind = kindToken.text as 'struct' | 'union';
    let tag: string | null = null;
    if (peek().kind === 'identifier' && !reserved.has(peek().text)) tag = consume().text;
    if (peek().text !== '{') {
      if (!tag) failure('SYNTAX_ERROR', `Se esperaba una etiqueta o una definición de ${kind}.`, peek());
      const nearest = nearestTagKind(tag);
      if (nearest?.kind === 'enum') failure('CONFLICTING_TYPES', `La etiqueta «${tag}» ya declara un enum.`, kindToken);
      let definition = nearest?.aggregate;
      if (!definition) {
        definition = { id: nextAggregateId++, kind, tag, complete: false, members: [], location: kindToken };
        aggregates.push(definition); tagScopes[tagScopes.length - 1].set(tag, definition);
      } else if (definition.kind !== kind) failure('CONFLICTING_TYPES', `La etiqueta «${tag}» ya declara otro tipo agregado.`, kindToken);
      return aggregateRef(definition.id);
    }

    const existing = tag === null ? undefined : currentTag(tag);
    if (tag !== null && enumTagScopes[enumTagScopes.length - 1].has(tag)) failure('CONFLICTING_TYPES', `La etiqueta «${tag}» ya declara un enum en este ámbito.`, kindToken);
    if (existing?.complete) failure('REDEFINITION', `El tipo ${kind} ${tag} ya está definido en este ámbito.`, kindToken);
    const definition: AggregateDefinition = existing ?? { id: nextAggregateId++, kind, tag, complete: false, members: [], location: kindToken };
    if (!existing) {
      aggregates.push(definition);
      if (tag !== null) tagScopes[tagScopes.length - 1].set(tag, definition);
    }
    consume();
    const members: AggregateMember[] = [];
    while (peek().text !== '}') {
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', `Falta el cierre } de ${kind}.`, peek());
      if (peek().text === ';') failure('SYNTAX_ERROR', 'Un agregado necesita declaraciones de miembros.', peek());
      const memberBase = parseTypeSpecifier();
      const memberConst = lastSpecifierConst;
      if (peek().text === ';') {
        const anonymousType = memberBase;
        if (!isAggregate(anonymousType)) failure('SYNTAX_ERROR', 'Un miembro anónimo necesita un especificador struct o union completo.', peek());
        const anonymousDefinition = aggregates.find(value => value.id === anonymousType.id);
        if (!anonymousDefinition?.complete || anonymousDefinition.tag !== null) failure('TYPE_ERROR', 'Un miembro anónimo necesita un struct o union anónimo completo.', peek());
        const location = consume();
        members.push({ name: '', type: anonymousType, index: members.length, offset: 0, location, isConst: memberConst });
        continue;
      }
      if (memberBase === 'void' || isFunction(memberBase)) failure('TYPE_ERROR', 'Un miembro de agregado debe tener tipo de objeto.', peek());
      do {
        const declarator = parseDeclarator(false);
        const memberType = declaredType(declarator, memberBase, memberConst);
        if (isFunction(memberType)) failure('TYPE_ERROR', 'Un miembro de agregado no puede ser una función.', declarator.location);
        if (peek().text === ':') unsupported(peek(), 'P3 no implementa bit-fields.');
        if (members.some(member => member.name === declarator.name)) failure('REDECLARATION', `El miembro «${declarator.name}» aparece más de una vez.`, declarator.location);
        members.push({ name: declarator.name, type: memberType, index: members.length, offset: 0, location: declarator.location, isConst: isConstObjectType(memberType, declarator, memberConst) });
        if (peek().text !== ',') break;
        consume();
      } while (true);
      expect(';');
    }
    expect('}');
    definition.members = members;
    definition.complete = true;
    if (!members.length) failure('TYPE_ERROR', 'Un struct o union debe declarar al menos un miembro.', kindToken);
    layoutAggregate(definition, aggregates, kindToken);
    lastSpecifierDefinesTag = true;
    return aggregateRef(definition.id);
  };

  const parseEnumSpecifier = (): CType => {
    const enumToken = consume();
    const tag = peek().kind === 'identifier' && !reserved.has(peek().text) ? consume().text : null;
    if (peek().text !== '{') {
      if (!tag) failure('SYNTAX_ERROR', 'Se esperaba una etiqueta o una definición de enum.', peek());
      const nearest = nearestTagKind(tag);
      if (!nearest) failure('INCOMPLETE_TYPE', `El enum «${tag}» no está definido.`, enumToken);
      if (nearest.kind !== 'enum') failure('CONFLICTING_TYPES', `La etiqueta «${tag}» ya declara un tipo agregado.`, enumToken);
      return 'int';
    }
    if (tag !== null && tagScopes[tagScopes.length - 1].has(tag)) failure('CONFLICTING_TYPES', `La etiqueta «${tag}» ya declara un agregado en este ámbito.`, enumToken);
    if (tag !== null && enumTagScopes[enumTagScopes.length - 1].has(tag)) failure('REDEFINITION', `El enum «${tag}» ya está definido en este ámbito.`, enumToken);
    if (tag !== null) enumTagScopes[enumTagScopes.length - 1].set(tag, enumToken);
    consume();
    let nextValue = 0n;
    let count = 0;
    while (peek().text !== '}') {
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', 'Falta el cierre } del enum.', peek());
      const enumerator = identifier();
      let value = nextValue;
      if (peek().text === '=') {
        consume();
        const expression = parseExpression(2, new Set([',', '}']));
        const constant = constantExpression(expression, aggregates);
        if (!isInteger(constant.type) || typeof constant.value !== 'bigint') failure('TYPE_ERROR', 'El valor de un enumerador debe ser una expresión constante entera.', enumerator);
        value = constant.value;
      }
      if (value < INT_MIN || value > INT_MAX) failure('TYPE_SIZE_RANGE', 'El valor de un enumerador debe caber en int.', enumerator);
      declareEnumerator(enumerator.text, value, enumerator);
      nextValue = value + 1n;
      count++;
      if (peek().text !== ',') break;
      consume();
      if (peek().text === '}') break;
    }
    if (!count) failure('SYNTAX_ERROR', 'Un enum necesita al menos un enumerador.', enumToken);
    expect('}');
    lastSpecifierDefinesTag = true;
    return 'int';
  };
  const declareEnumerator = (name: string, value: bigint, location: Location): void => {
    const scope = ordinaryScopes[ordinaryScopes.length - 1];
    if (scope.has(name)) failure('REDECLARATION', `El identificador «${name}» ya está declarado en este ámbito.`, location);
    scope.set(name, value);
  };

  function parseTypeSpecifier(): CType {
    lastSpecifierDefinesTag = false;
    lastSpecifierConst = false;
    lastSpecifierVolatile = false;
    lastSpecifierRestrict = false;
    const at = peek();
    const consumeQualifier = (): boolean => {
      const qualifier = peek();
      if (!['const', 'volatile', 'restrict'].includes(qualifier.text)) return false;
      consume();
      if (qualifier.text === 'const') lastSpecifierConst = true;
      else if (qualifier.text === 'volatile') unsupported(qualifier, 'volatile queda fuera del subconjunto P4.');
      else failure('TYPE_ERROR', 'restrict sólo se admite como calificador de un tipo puntero en el subconjunto P4.', qualifier);
      return true;
    };
    while (consumeQualifier()) { /* qualifiers may appear among declaration specifiers */ }
    if (peek().text === 'struct' || peek().text === 'union') {
      const isConst = lastSpecifierConst, isVolatile = lastSpecifierVolatile, isRestrict = lastSpecifierRestrict;
      const type = parseAggregateSpecifier();
      lastSpecifierConst = isConst; lastSpecifierVolatile = isVolatile; lastSpecifierRestrict = isRestrict;
      while (consumeQualifier()) { /* qualifiers may follow an aggregate specifier */ }
      return type;
    }
    if (peek().text === 'enum') {
      const isConst = lastSpecifierConst, isVolatile = lastSpecifierVolatile, isRestrict = lastSpecifierRestrict;
      const type = parseEnumSpecifier();
      lastSpecifierConst = isConst; lastSpecifierVolatile = isVolatile; lastSpecifierRestrict = isRestrict;
      while (consumeQualifier()) { /* qualifiers may follow an enum specifier */ }
      return type;
    }
    if (unsupportedWords.has(peek().text)) unsupported(peek());
    if (peek().kind === 'identifier') {
      const alias = lookupTypedef(peek().text);
      if (alias) {
        lastSpecifierConst = lastSpecifierConst || !!alias.isConst;
        consume();
        while (consumeQualifier()) { /* qualifiers may follow a typedef name */ }
        return alias.type;
      }
    }
    const words: string[] = [];
    while (true) {
      if (consumeQualifier()) continue;
      if (scalarWords.has(peek().text)) { words.push(consume().text); continue; }
      break;
    }
    if (!words.length) failure('SYNTAX_ERROR', 'Se esperaba un especificador de tipo.', at);
    const count = (word: string) => words.filter(value => value === word).length;
    for (const word of scalarWords) if (count(word) > (word === 'long' ? 2 : 1)) failure('TYPE_ERROR', 'Especificadores de tipo incompatibles o repetidos.', at);
    const signed = count('signed'), unsigned = count('unsigned');
    if (signed && unsigned) failure('TYPE_ERROR', 'Un tipo no puede ser signed y unsigned a la vez.', at);
    for (const special of ['void', '_Bool', 'float']) {
      if (count(special)) {
        if (words.length !== 1) failure('TYPE_ERROR', 'Especificadores de tipo incompatibles.', at);
        return special as ScalarCType;
      }
    }
    if (count('double')) {
      if (count('long') === 1 && words.length === 2) return 'long double';
      if (words.length !== 1) failure('TYPE_ERROR', 'Especificadores de tipo incompatibles.', at);
      return 'double';
    }
    if (count('char')) {
      if (count('int') || count('short') || count('long')) failure('TYPE_ERROR', 'Especificadores de tipo incompatibles.', at);
      return unsigned ? 'unsigned char' : signed ? 'signed char' : 'char';
    }
    if (count('short') && count('long')) failure('TYPE_ERROR', 'Un tipo no puede ser short y long a la vez.', at);
    if (count('short')) return unsigned ? 'unsigned short' : 'short';
    if (count('long') === 2) return unsigned ? 'unsigned long long' : 'long long';
    if (count('long')) return unsigned ? 'unsigned long' : 'long';
    return unsigned ? 'unsigned int' : 'int';
  }

  const parseArrayBound = (): number => {
    if (peek().text === ']') failure('INCOMPLETE_TYPE', 'P3 requiere una longitud para arrays locales; sólo se infiere con un inicializador.', peek());
    const length = parseIntegerConstant('La longitud del array');
    if (length <= 0n || length > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'La longitud del array debe ser positiva y representable.', peek());
    consume();
    return Number(length);
  };

  const parseDeclarator = (abstractAllowed: boolean): Declarator => {
    const start = peek();
    const pointerQualifiers: { const?: boolean; restrict?: boolean }[] = [];
    while (peek().text === '*') {
      consume();
      const qualifiers: { const?: boolean; restrict?: boolean } = {};
      while (peek().text === 'const' || peek().text === 'restrict' || peek().text === 'volatile') {
        const qualifier = consume();
        if (qualifier.text === 'const') qualifiers.const = true;
        else if (qualifier.text === 'restrict') qualifiers.restrict = true;
        else unsupported(qualifier, 'volatile queda fuera del subconjunto P4.');
      }
      pointerQualifiers.push(qualifiers);
    }
    let name = '';
    let location: Location = start;
    let declaredParameters: Parameter[] | undefined;
    let declaredPrototype: boolean | undefined;
    let declaredVariadic = false;
    let declaredOldStyle = false;
    let direct: (base: CType) => CType;
    if (peek().text === '(' && (peek(1).text === '*' || peek(1).text === '(' || peek(1).kind === 'identifier')) {
      consume();
      const nested = parseDeclarator(abstractAllowed);
      expect(')');
      name = nested.name; location = nested.location; direct = nested.apply; declaredParameters = nested.parameters;
      declaredPrototype = nested.prototype; declaredVariadic = !!nested.variadic; declaredOldStyle = !!nested.oldStyle;
    } else if (peek().kind === 'identifier' && !reserved.has(peek().text)) {
      const token = identifier(); name = token.text; location = token; direct = base => base;
    } else if (abstractAllowed) {
      direct = base => base;
    } else {
      if (peek().text === '[') failure('SYNTAX_ERROR', 'Un array declarado necesita un identificador.', peek());
      failure('SYNTAX_ERROR', 'Se esperaba un declarador con nombre.', peek());
    }
    while (true) {
      if (peek().text === '[') {
        consume();
        let length: number | null;
        if (peek().text === ']') { consume(); length = null; }
        else length = parseArrayBound();
        const previous = direct;
        direct = base => previous(arrayOf(base, length)); continue;
      }
      if (peek().text === '(') {
        consume();
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
            names.push(identifier());
            if (peek().text !== ',') break;
            consume();
            if (peek().text === ')') failure('SYNTAX_ERROR', 'Falta un identificador en la lista antigua de parámetros.', peek());
          } while (true);
          for (const parameter of names) {
            parameters.push({ name: parameter.text, type: 'int', location: parameter });
            parameterTypes.push('int');
          }
        } else {
          while (true) {
            const parameterAt = peek();
            if (peek().text === '...') {
              if (!parameters.length) failure('SYNTAX_ERROR', 'Una función variádica requiere al menos un parámetro con tipo.', peek());
              consume(); variadic = true; break;
            }
            const parameterBase = parseTypeSpecifier();
            const parameterConst = lastSpecifierConst;
            const parameterDeclarator = parseDeclarator(true);
            let parameterType = declaredType(parameterDeclarator, parameterBase, parameterConst);
            if (parameterType === 'void') failure('TYPE_ERROR', 'void sólo puede aparecer como lista de parámetros vacía.', parameterAt);
            if (isArray(parameterType) || isFunction(parameterType)) parameterType = decayType(parameterType);
            const isConst = isConstObjectType(parameterType, parameterDeclarator, parameterConst);
            parameters.push({ name: parameterDeclarator.name, type: parameterType, isConst, location: parameterDeclarator.location });
            parameterTypes.push(parameterType);
            if (peek().text !== ',') break;
            consume();
          }
        }
        expect(')');
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
      apply: (base, baseConst = false) => direct(applyPointers(base, pointerQualifiers, baseConst)),
    };
  };
  const applyPointers = (base: CType, qualifiers: { const?: boolean; restrict?: boolean }[], baseConst = false): CType => {
    let type = base;
    qualifiers.forEach((qualifier, index) => { type = pointerTo(type, { ...qualifier, ...(index === 0 && baseConst ? { baseConst: true } : {}) }); });
    return type;
  };
  const declaredType = (declarator: Declarator, base: CType, baseConst = false): CType => {
    let type = declarator.apply(base, baseConst);
    if (baseConst && !declarator.pointerQualifiers?.length && isPointer(type)) {
      type = pointerTo(type.base, { const: true, restrict: type.restrict, baseConst: type.baseConst });
    }
    return type;
  };
  const isConstObjectType = (type: CType, declarator: Declarator, baseConst: boolean): boolean =>
    isPointer(type) ? !!type.const : declarator.pointerQualifiers?.length
      ? !!declarator.pointerQualifiers.at(-1)?.const
      : baseConst;

  const decodeString = (text: string, at: Location): number[] => {
    if (!text.startsWith('"') || !text.endsWith('"')) failure('UNTERMINATED_STRING', 'Literal de cadena sin cierre.', at);
    const result: number[] = [];
    const body = text.slice(1, -1);
    for (let index = 0; index < body.length; index++) {
      let code = 0;
      const char = body[index];
      if (char !== '\\') {
        code = body.charCodeAt(index);
        if (code > 127) unsupported({ ...at, text: char, kind: 'string' }, 'P3 admite cadenas de caracteres ASCII; Unicode queda pendiente.');
      } else {
        const next = body[++index];
        if (next === undefined) failure('SYNTAX_ERROR', 'Escape incompleto en literal de cadena.', at);
        const simple: Record<string, number> = { "'": 39, '"': 34, '?': 63, '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
        if (Object.hasOwn(simple, next)) code = simple[next];
        else if (/[0-7]/.test(next)) {
          let digits = next;
          while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) digits += body[++index];
          code = Number.parseInt(digits, 8);
        } else if (next === 'x') {
          let digits = '';
          while (/[0-9a-fA-F]/.test(body[index + 1] ?? '')) digits += body[++index];
          if (!digits) failure('SYNTAX_ERROR', 'El escape hexadecimal de cadena requiere al menos un dígito.', at);
          code = Number.parseInt(digits, 16);
        } else if (next === 'u' || next === 'U') unsupported({ ...at, text: `\\${next}`, kind: 'string' }, 'P3 no implementa escapes Unicode.');
        else failure('SYNTAX_ERROR', `Escape de cadena desconocido: \\${next}.`, at);
      }
      result.push(code);
    }
    return result;
  };

  const parseIntegerConstant = (context: string): bigint => {
    const at = peek();
    const expression = parseExpression(1, new Set([']']));
    const value = constantExpression(expression, aggregates);
    if (!isInteger(value.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', `${context} debe ser una expresión constante entera.`, at);
    return value.value;
  };

  let parseExpression: (minPrecedence?: number, stops?: ReadonlySet<string>) => Expression;
  let expressionDuration: 'automatic' | 'static' = 'automatic';

  const parseInitializer = (): Initializer => {
    const at = peek();
    if (peek().text !== '{') {
      const value = parseExpression(2, new Set([',', ';', '}']));
      return { kind: 'expression', value, location: at };
    }
    consume();
    const list: { designators: InitializerDesignator[]; initializer: Initializer; location: Location }[] = [];
    while (peek().text !== '}') {
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', 'Falta el cierre } del inicializador.', peek());
      const itemAt = peek();
      const designators: InitializerDesignator[] = [];
      while (peek().text === '.' || peek().text === '[') {
        if (peek().text === '.') {
          const designator = consume(); const name = identifier();
          designators.push({ kind: 'member', name: name.text, location: designator });
        } else {
          const designator = consume();
          const index = parseIntegerConstant('El designador de array');
          if (index < 0n) failure('INVALID_DESIGNATOR', 'El índice de un designador no puede ser negativo.', designator);
          expect(']'); designators.push({ kind: 'index', index, location: designator });
        }
      }
      if (designators.length) expect('=');
      const initializer = parseInitializer();
      list.push({ designators, initializer, location: itemAt });
      if (peek().text !== ',') break;
      consume();
      if (peek().text === '}') break;
    }
    if (!list.length) failure('SYNTAX_ERROR', 'Un inicializador con llaves necesita al menos un elemento en C11.', at);
    expect('}');
    return { kind: 'list', items: list, location: at };
  };

  const typeName = (): CType => {
    const base = parseTypeSpecifier();
    return parseDeclarator(true).apply(base);
  };

  parseExpression = (minPrecedence = 1, stops: ReadonlySet<string> = new Set()): Expression => {
    type Value = { expression: Expression; depth: number };
    type Marker =
      | { kind: 'group'; token: Token; valueStart: number }
      | { kind: 'call'; token: Token; valueStart: number; callee: Expression; baseDepth: number; args: Expression[]; maxDepth: number }
      | { kind: 'index'; token: Token; valueStart: number; base: Expression; baseDepth: number };
    type Operator =
      | { kind: 'unary'; token: Token; operator: string; targetType?: CType }
      | { kind: 'binary' | 'conditional' | 'question'; token: Token; operator: string }
      | Marker;
    const values: Value[] = [];
    const stack: Operator[] = [];
    const markers: number[] = [];
    const questionCounts = [0];
    let expectingOperand = true;
    const pushValue = (expression: Expression, depth: number) => {
      enforceLimit('maxDepth', depth, limits.maxDepth, expression.location);
      values.push({ expression, depth });
    };
    const operatorPrecedence = (operator: Operator): number => operator.kind === 'unary' ? 14 :
      operator.kind === 'binary' || operator.kind === 'conditional' ? operators[operator.operator] ?? 0 : 0;
    const reduce = (): void => {
      const operator = stack.pop();
      if (!operator || operator.kind === 'group' || operator.kind === 'call' || operator.kind === 'index' || operator.kind === 'question') {
        failure('SYNTAX_ERROR', 'Expresión incompleta.', operator?.token ?? peek());
      }
      const right = values.pop();
      if (!right) failure('SYNTAX_ERROR', 'Falta el operando derecho.', operator.token);
      if (operator.kind === 'unary') {
        const expression: Expression = operator.operator === 'sizeof'
          ? { kind: 'sizeof', operand: right.expression, location: operator.token }
          : operator.operator === '++' || operator.operator === '--'
            ? { kind: 'update', operator: operator.operator, operand: right.expression, prefix: true, location: operator.token }
            : operator.operator === 'cast'
              ? { kind: 'cast', targetType: operator.targetType!, operand: right.expression, location: operator.token }
              : { kind: 'unary', operator: operator.operator, operand: right.expression, location: operator.token };
        pushValue(expression, right.depth + 1);
        return;
      }
      const left = values.pop();
      if (!left) failure('SYNTAX_ERROR', 'Falta el operando izquierdo.', operator.token);
      if (operator.kind === 'conditional') {
        const condition = values.pop();
        if (!condition) failure('SYNTAX_ERROR', 'Falta la condición de ?: .', operator.token);
        pushValue({ kind: 'conditional', condition: condition.expression, then: left.expression, else: right.expression, location: operator.token },
          Math.max(condition.depth, left.depth, right.depth) + 1);
      } else {
        const node = assignments.has(operator.operator)
          ? { kind: 'assignment' as const, target: left.expression, operator: operator.operator, value: right.expression, location: operator.token }
          : { kind: 'binary' as const, operator: operator.operator, left: left.expression, right: right.expression, location: operator.token };
        pushValue(node, Math.max(left.depth, right.depth) + 1);
      }
    };
    const openMarker = (marker: Marker): void => {
      enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, marker.token);
      markers.push(stack.length);
      stack.push(marker);
      questionCounts.push(0);
    };
    const closeMarker = (kind: Marker['kind'], token: Token): void => {
      const open = markers[markers.length - 1];
      if (open === undefined) failure('SYNTAX_ERROR', `«${token.text}» sin apertura correspondiente.`, token);
      while (stack.length > open + 1) reduce();
      const marker = stack.pop()! as Marker;
      if (marker.kind !== kind) failure('SYNTAX_ERROR', `Se esperaba el cierre de «${marker.kind === 'group' || marker.kind === 'call' ? '(' : '['}».`, token);
      markers.pop(); questionCounts.pop(); consume();
      if (marker.kind === 'group') {
        if (values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Expresión inválida dentro de paréntesis.', token);
        expectingOperand = false;
        return;
      }
      if (marker.kind === 'call') {
        if (expectingOperand) {
          if (values.length !== marker.valueStart || marker.args.length || stack.length !== open) failure('SYNTAX_ERROR', 'Falta un argumento de la llamada.', token);
        } else {
          if (values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Argumento inválido.', token);
          const argument = values.pop()!;
          marker.args.push(argument.expression); marker.maxDepth = Math.max(marker.maxDepth, argument.depth);
        }
        const depth = Math.max(marker.baseDepth, marker.maxDepth) + 1;
        pushValue({ kind: 'call', callee: marker.callee, args: marker.args, location: marker.token }, depth);
        expectingOperand = false;
        return;
      }
      if (expectingOperand || values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'El subíndice requiere una expresión.', token);
      const index = values.pop()!;
      pushValue({ kind: 'index', base: marker.base, index: index.expression, location: marker.token }, Math.max(marker.baseDepth, index.depth) + 1);
      expectingOperand = false;
    };

    while (true) {
      const token = peek();
      const open = markers[markers.length - 1] ?? -1;
      const pendingQuestion = questionCounts[questionCounts.length - 1] > 0;
      if (token.kind === 'eof' || open < 0 && stops.has(token.text) && !((token.text === ':' || token.text === ',') && pendingQuestion)) break;
      if (expectingOperand) {
        if (token.text === ')' && open >= 0 && stack[open].kind === 'call') {
          closeMarker('call', token); continue;
        }
        if (token.text === '+' || token.text === '-' || token.text === '!' || token.text === '~' || token.text === '&' || token.text === '*' || token.text === '++' || token.text === '--') {
          enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, token);
          stack.push({ kind: 'unary', token: consume(), operator: token.text });
          continue;
        }
        if (token.text === 'sizeof') {
          consume();
          if (peek().text === '(' && startsType(peek(1))) {
            consume(); const valueType = typeName(); expect(')');
            pushValue({ kind: 'sizeof', valueType, location: token }, 1); expectingOperand = false;
          } else {
            enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, token);
            stack.push({ kind: 'unary', token, operator: 'sizeof' });
          }
          continue;
        }
        if (token.text === '(' && startsType(peek(1))) {
          consume(); const targetType = typeName(); expect(')');
          if (peek().text === '{') {
            const initializer = parseInitializer();
            const literal: Expression = { kind: 'compoundLiteral', objectType: inferArrayType(targetType, initializer), initializer, duration: expressionDuration, location: token };
            pushValue(literal, 1); expectingOperand = false;
          } else {
            enforceLimit('maxDepth', stack.length + 1, limits.maxDepth, token);
            stack.push({ kind: 'unary', token, operator: 'cast', targetType });
          }
          continue;
        }
        if (token.text === '(') {
          consume(); openMarker({ kind: 'group', token, valueStart: values.length }); continue;
        }
        if (token.text === '__builtin_va_arg' && peek(1).text === '(') {
          consume(); consume();
          const ap = parseExpression(1, new Set([',']));
          expect(',');
          const valueType = typeName();
          expect(')');
          pushValue({ kind: 'vaArg', ap, valueType, location: token }, 1);
          expectingOperand = false;
          continue;
        }
        if (token.kind === 'integer' || token.kind === 'floating' || token.kind === 'character') {
          consume(); pushValue({ kind: 'literal', value: parseLiteral(token.text, token), location: token }, 1); expectingOperand = false; continue;
        }
        if (token.kind === 'string') {
          const first = consume(); const bytes = decodeString(first.text, first);
          while (peek().kind === 'string') bytes.push(...decodeString(consume().text, first));
          bytes.push(0); pushValue({ kind: 'string', bytes, location: first }, 1); expectingOperand = false; continue;
        }
        if (token.kind === 'identifier' && !reserved.has(token.text)) {
          consume();
          const enumerator = lookupEnumerator(token.text);
          pushValue(enumerator === undefined
            ? { kind: 'variable', name: token.text, location: token }
            : { kind: 'literal', value: { type: 'int', value: enumerator }, location: token }, 1);
          expectingOperand = false; continue;
        }
        if (unsupportedWords.has(token.text)) unsupported(token);
        failure('SYNTAX_ERROR', 'Se esperaba una expresión de C.', token);
      }

      if (token.text === ')' || token.text === ']') {
        if (open < 0) {
          if (stops.has(token.text)) break;
          failure('SYNTAX_ERROR', `«${token.text}» sin apertura correspondiente.`, token);
        }
        const marker = stack[open];
        const wanted: Marker['kind'] = token.text === ']' ? 'index' : marker.kind === 'call' ? 'call' : 'group';
        closeMarker(wanted, token); continue;
      }
      if (token.text === '[' || token.text === '(') {
        const base = values.pop();
        if (!base) failure('SYNTAX_ERROR', `El operador «${token.text}» no tiene una expresión base.`, token);
        consume();
        if (token.text === '[') openMarker({ kind: 'index', token, valueStart: values.length, base: base.expression, baseDepth: base.depth });
        else openMarker({ kind: 'call', token, valueStart: values.length, callee: base.expression, baseDepth: base.depth, args: [], maxDepth: 0 });
        expectingOperand = true; continue;
      }
      if (token.text === '.' || token.text === '->') {
        const base = values.pop()!; consume(); const name = identifier();
        const node: Expression = { kind: 'member', base: base.expression, name: name.text, arrow: token.text === '->', location: token };
        pushValue(node, base.depth + 1); continue;
      }
      if (token.text === '++' || token.text === '--') {
        const operand = values.pop()!; consume();
        pushValue({ kind: 'update', operand: operand.expression, operator: token.text, prefix: false, location: token }, operand.depth + 1); continue;
      }
      if (token.text === '?') {
        if (3 < minPrecedence && open < 0 && !pendingQuestion) break;
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === 'group' || top.kind === 'call' || top.kind === 'index' || top.kind === 'question') break;
          if (operatorPrecedence(top) <= 3) break;
          reduce();
        }
        stack.push({ kind: 'question', token: consume(), operator: '?:' }); questionCounts[questionCounts.length - 1]++; expectingOperand = true; continue;
      }
      if (token.text === ':') {
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === 'group' || top.kind === 'call' || top.kind === 'index') break;
          if (top.kind === 'question') break;
          reduce();
        }
        const question = stack[stack.length - 1];
        if (!question || question.kind !== 'question') {
          if (open < 0 && stops.has(':')) break;
          failure('SYNTAX_ERROR', '«:» sin «?» correspondiente.', token);
        }
        stack.pop(); questionCounts[questionCounts.length - 1]--;
        stack.push({ kind: 'conditional', token: question.token, operator: '?:' }); consume(); expectingOperand = true; continue;
      }
      if (token.text === ',' && open >= 0 && stack[open].kind === 'call' && !pendingQuestion) {
        while (stack.length > open + 1) reduce();
        const call = stack[open] as Extract<Marker, { kind: 'call' }>;
        if (values.length !== call.valueStart + 1) failure('SYNTAX_ERROR', 'Argumento inválido.', token);
        const argument = values.pop()!;
        call.args.push(argument.expression); call.maxDepth = Math.max(call.maxDepth, argument.depth);
        consume(); expectingOperand = true; continue;
      }
      const precedence = operators[token.text];
      if (precedence !== undefined) {
        if (open < 0 && precedence < minPrecedence && !pendingQuestion) break;
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === 'group' || top.kind === 'call' || top.kind === 'index' || top.kind === 'question') break;
          const topPrecedence = operatorPrecedence(top);
          if (topPrecedence < precedence || topPrecedence === precedence && assignments.has(token.text)) break;
          reduce();
        }
        stack.push({ kind: 'binary', token: consume(), operator: token.text }); expectingOperand = true; continue;
      }
      if (unsupportedWords.has(token.text)) unsupported(token);
      failure('SYNTAX_ERROR', `Falta un operador antes de «${token.text}».`, token);
    }
    if (expectingOperand) failure('SYNTAX_ERROR', 'Falta una expresión u operando.', peek());
    if (markers.length) failure('SYNTAX_ERROR', 'Falta cerrar un paréntesis o subíndice.', peek());
    while (stack.length) reduce();
    if (values.length !== 1) failure('SYNTAX_ERROR', 'Expresión inválida.', peek());
    return values[0].expression;
  };

  const inferArrayType = (type: CType, initializer: Initializer | undefined): CType => {
    if (!isArray(type) || type.length !== null) return type;
    if (!initializer) return type;
    let length = 0;
    if (initializer.kind === 'expression' && initializer.value.kind === 'string' && type.element === 'char') {
      length = initializer.value.bytes.length;
    } else if (initializer.kind === 'list') {
      let next = 0;
      for (const item of initializer.items) {
        const designator = item.designators[0];
        if (designator?.kind === 'index') next = Number(designator.index) + 1;
        else next++;
        length = Math.max(length, next);
      }
    }
    if (!length) failure('INCOMPLETE_TYPE', 'Un array incompleto necesita un inicializador que determine su longitud.', initializer.location);
    return arrayOf(type.element, length);
  };

  const parseDeclaration = (depth: number, local: boolean): Statement => {
    const at = peek();
    enforceLimit('maxDepth', depth, limits.maxDepth, at);
    let isStatic = false;
    let isExtern = false;
    let isTypedef = false;
    while (['static', 'extern', 'typedef', 'inline', '_Noreturn'].includes(peek().text)) {
      const storage = consume();
      if (storage.text === 'static') isStatic = true;
      else if (storage.text === 'extern') isExtern = true;
      else if (storage.text === 'typedef') isTypedef = true;
      else unsupported(storage, 'inline y _Noreturn solo se admiten en declaraciones de función de ámbito de archivo.');
    }
    if (isStatic && isExtern || isTypedef && (isStatic || isExtern)) failure('TYPE_ERROR', 'Clases de almacenamiento incompatibles.', at);
    if (local && isExtern) unsupported(at, 'Las declaraciones extern de ámbito de bloque quedan pendientes de enlace en P5.');
    const base = parseTypeSpecifier();
    const baseConst = lastSpecifierConst;
    const standaloneTag = lastSpecifierDefinesTag;
    if (peek().text === ';' && (isAggregate(base) || standaloneTag)) { consume(); return { kind: 'empty', location: at }; }
    if (isAggregate(base) && peek().text === ';') { consume(); return { kind: 'empty', location: at }; }
    if (isTypedef) {
      do {
        const declarator = parseDeclarator(false);
        const type = declaredType(declarator, base, baseConst);
        if (peek().text === '=') failure('SYNTAX_ERROR', 'Un typedef no admite inicializador.', peek());
        declareTypedef(declarator.name, type, isConstObjectType(type, declarator, baseConst), declarator.location);
        if (peek().text !== ',') break;
        consume();
      } while (true);
      expect(';');
      return { kind: 'empty', location: at };
    }
    if (isStatic && !local) failure('ENGINE_INTERNAL_ERROR', 'static file-scope debe manejarse en una declaración externa.', at);
    const declarations: Statement[] = [];
    do {
      const declarator = parseDeclarator(false);
      let type = declaredType(declarator, base, baseConst);
      if (isFunction(type)) failure('UNSUPPORTED_FEATURE', 'Una declaración de función no puede aparecer como variable local.', declarator.location);
      if (type === 'void') failure('TYPE_ERROR', 'Una variable no puede tener tipo void.', declarator.location);
      let initializer: Initializer | undefined;
      declareOrdinary(declarator.name, declarator.location);
      if (peek().text === '=') {
        consume();
        const priorDuration = expressionDuration;
        if (isStatic) expressionDuration = 'static';
        try { initializer = parseInitializer(); } finally { expressionDuration = priorDuration; }
      }
      type = inferArrayType(type, initializer);
      if (!isComplete(type, aggregates)) failure('INCOMPLETE_TYPE', 'El objeto declarado debe tener un tipo completo.', declarator.location);
      declarations.push({ kind: 'declaration', name: declarator.name, type, initializer, static: isStatic, const: isConstObjectType(type, declarator, baseConst), location: declarator.location });
      if (peek().text !== ',') break;
      consume();
    } while (true);
    expect(';');
    if (declarations.length === 1) return declarations[0];
    return { kind: 'sequence', statements: declarations, location: at };
  };

  const parseBody = (depth = 1, parameterNames: readonly { name: string; location: Location }[] = []): Block => {
    enforceLimit('maxDepth', depth, limits.maxDepth, peek());
    const open = expect('{');
    const block: Block = { kind: 'block', statements: [], location: open, endLocation: open };
    pushTags();
    for (const parameter of parameterNames) if (parameter.name) declareOrdinary(parameter.name, parameter.location);
    const pending: { block: Block; depth: number }[] = [{ block, depth }];
    while (pending.length) {
      const current = pending[pending.length - 1];
      if (peek().text === '}') {
        current.block.endLocation = consume(); popTags(); pending.pop(); continue;
      }
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', 'Falta el cierre } del bloque.', peek());
      enforceLimit('maxDepth', current.depth + 1, limits.maxDepth, peek());
      if (peek().text === '{') {
        const nestedOpen = consume();
        const nested: Block = { kind: 'block', statements: [], location: nestedOpen, endLocation: nestedOpen };
        current.block.statements.push(nested); pushTags(); pending.push({ block: nested, depth: current.depth + 1 });
        continue;
      }
      current.block.statements.push(parseStatement(current.depth + 1, true));
    }
    return block;
  };

  const parseStatement = (depth: number, allowDeclaration: boolean): Statement => {
    const token = peek(); enforceLimit('maxDepth', depth, limits.maxDepth, token);
    if (token.text === '{') return parseBody(depth);
    if (token.text === ';') { consume(); return { kind: 'empty', location: token }; }
    if (isDeclarationStart(token)) {
      if (!allowDeclaration) failure('SYNTAX_ERROR', 'Una declaración debe estar dentro de un bloque o en el inicializador de for.', token);
      return parseDeclaration(depth, true);
    }
    if (unsupportedWords.has(token.text)) unsupported(token);
    if (token.text === 'if') {
      consume(); expect('('); const condition = parseExpression(1, new Set([')'])); expect(')');
      const then = parseStatement(depth + 1, false);
      const node: Extract<Statement, { kind: 'if' }> = { kind: 'if', condition, scopeName: 'if(...)', then, location: token };
      if (peek().text === 'else') { consume(); node.else = parseStatement(depth + 1, false); }
      return node;
    }
    if (token.text === 'while' || token.text === 'switch') {
      consume(); expect('('); const value = parseExpression(1, new Set([')'])); expect(')');
      const scopeName = `${token.text}(...)`;
      const body = parseStatement(depth + 1, false);
      return token.text === 'while'
        ? { kind: 'while', condition: value, scopeName, body, location: token }
        : { kind: 'switch', value, scopeName, body, location: token };
    }
    if (token.text === 'do') {
      consume(); const body = parseStatement(depth + 1, false);
      expect('while'); expect('('); const condition = parseExpression(1, new Set([')'])); expect(')');
      expect(';');
      return { kind: 'do', condition, scopeName: 'do { ... } while (...)', body, location: token };
    }
    if (token.text === 'for') {
      consume(); pushTags(); expect('(');
      let initializer: Statement | undefined; let condition: Expression | undefined; let increment: Expression | undefined;
      if (peek().text === ';') consume();
      else if (isDeclarationStart()) initializer = parseForDeclaration(depth + 1);
      else { const at = peek(); initializer = { kind: 'expression', value: parseExpression(1, new Set([';'])), location: at }; expect(';'); }
      if (peek().text !== ';') condition = parseExpression(1, new Set([';'])); expect(';');
      if (peek().text !== ')') increment = parseExpression(1, new Set([')'])); expect(')');
      const body = parseStatement(depth + 1, false);
      popTags();
      return { kind: 'for', initializer, condition, increment, scopeName: 'for(...)', body, location: token };
    }
    if (token.text === 'return') {
      consume(); const value = peek().text === ';' ? undefined : parseExpression(1, new Set([';'])); expect(';');
      return { kind: 'return', value, location: token };
    }
    if (token.text === 'break' || token.text === 'continue') { consume(); expect(';'); return { kind: token.text, location: token }; }
    if (token.text === 'goto') { consume(); const target = identifier(); expect(';'); return { kind: 'goto', target: target.text, location: token }; }
    if (token.text === 'case' || token.text === 'default') {
      consume(); const value = token.text === 'case' ? parseExpression(2, new Set([':'])) : undefined; expect(':');
      const statement = parseStatement(depth + 1, true);
      return { kind: 'case', value, statement, location: token };
    }
    if (token.kind === 'identifier' && !reserved.has(token.text) && peek(1).text === ':') {
      consume(); consume(); const statement = parseStatement(depth + 1, true);
      return { kind: 'label', name: token.text, statement, location: token };
    }
    const value = parseExpression(1, new Set([';'])); expect(';');
    return { kind: 'expression', value, location: token };
  };

  function parseForDeclaration(depth: number): Statement {
    const at = peek();
    enforceLimit('maxDepth', depth, limits.maxDepth, at);
    let isStatic = false;
    let isTypedef = false;
    if (peek().text === 'static') { consume(); isStatic = true; }
    else if (peek().text === 'typedef') { consume(); isTypedef = true; }
    else if (peek().text === 'extern') unsupported(peek(), 'Las declaraciones extern de ámbito de bloque quedan pendientes de enlace en P5.');
    const base = parseTypeSpecifier();
    const baseConst = lastSpecifierConst;
    const standaloneTag = lastSpecifierDefinesTag;
    if (peek().text === ';' && standaloneTag) { consume(); return { kind: 'empty', location: at }; }
    const statements: Statement[] = [];
    do {
      const declarator = parseDeclarator(false);
      let type = declaredType(declarator, base, baseConst);
      if (isTypedef) {
        declareTypedef(declarator.name, type, isConstObjectType(type, declarator, baseConst), declarator.location);
        if (peek().text !== ',') break;
        consume();
        continue;
      }
      if (isFunction(type) || type === 'void') failure('TYPE_ERROR', 'Declaración inválida en el inicializador de for.', declarator.location);
      let initializer: Initializer | undefined;
      declareOrdinary(declarator.name, declarator.location);
      if (peek().text === '=') { consume(); initializer = parseInitializer(); }
      type = inferArrayType(type, initializer);
      if (!isComplete(type, aggregates)) failure('INCOMPLETE_TYPE', 'El objeto declarado debe tener un tipo completo.', declarator.location);
      statements.push({ kind: 'declaration', name: declarator.name, type, initializer, static: isStatic, const: baseConst || !!declarator.pointerQualifiers?.at(-1)?.const, location: declarator.location });
      if (peek().text !== ',') break;
      consume();
    } while (true);
    expect(';');
    if (isTypedef) return { kind: 'empty', location: at };
    return statements.length === 1 ? statements[0] : { kind: 'sequence', statements, location: at };
  }

  const functions: FunctionIR[] = [];
  const globals: GlobalObject[] = [];
  const fileLinkage = new Map<string, 'internal' | 'external'>();
  while (peek().kind !== 'eof') {
    const at = peek();
    let isStatic = false;
    let isExtern = false;
    let isTypedef = false;
    let isInline = false;
    let isNoreturn = false;
    while (['static', 'extern', 'typedef', 'inline', '_Noreturn'].includes(peek().text)) {
      const storage = consume();
      if (storage.text === 'static') isStatic = true;
      else if (storage.text === 'extern') isExtern = true;
      else if (storage.text === 'typedef') isTypedef = true;
      else if (storage.text === 'inline') isInline = true;
      else isNoreturn = true;
    }
    if (isStatic && isExtern || isTypedef && (isStatic || isExtern || isInline || isNoreturn)) {
      failure('TYPE_ERROR', 'Clases de almacenamiento o especificadores de función incompatibles.', at);
    }
    const typeStart = peek();
    const base = parseTypeSpecifier();
    const baseConst = lastSpecifierConst;
    const standaloneTag = lastSpecifierDefinesTag;
    if (((typeStart.text === 'struct' || typeStart.text === 'union') && peek().text === ';' || standaloneTag && peek().text === ';')) { consume(); continue; }
    let first = true;
    while (true) {
      const declarator = parseDeclarator(false);
      const type = declaredType(declarator, base, baseConst);
      if (isTypedef) {
        if (peek().text === '=') failure('SYNTAX_ERROR', 'Un typedef no admite inicializador.', peek());
        declareTypedef(declarator.name, type, isConstObjectType(type, declarator, baseConst), declarator.location);
        if (peek().text !== ',') break;
        consume(); first = false; continue;
      }
      if (isFunction(type)) {
        if (baseConst) failure('TYPE_ERROR', 'Los especificadores de objeto no son válidos en esta declaración de función.', declarator.location);
        declareOrdinary(declarator.name, declarator.location);
        if (type.returnType !== 'void' && (isArray(type.returnType) || isFunction(type.returnType) || !isComplete(type.returnType, aggregates))) {
          failure('TYPE_ERROR', 'Una función debe devolver void o un tipo de objeto completo que no sea array.', declarator.location);
        }
        let linkage: 'internal' | 'external' = isStatic ? 'internal' : 'external';
        if (isExtern && fileLinkage.get(declarator.name) === 'internal') linkage = 'internal';
        const previousLinkage = fileLinkage.get(declarator.name);
        if (previousLinkage && previousLinkage !== linkage) failure('CONFLICTING_LINKAGE', `La función «${declarator.name}» mezcla linkage interno y externo.`, declarator.location);
        fileLinkage.set(declarator.name, linkage);
        const parameterTypes = type.parameters;
        const sourceParameters = declarator.parameters ?? [];
        const parameters: Parameter[] = parameterTypes.map((parameterType, index) => ({
          name: sourceParameters[index]?.name ?? '', type: parameterType, isConst: sourceParameters[index]?.isConst,
          location: sourceParameters[index]?.location ?? declarator.location,
        }));
        const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
        const fn: FunctionIR = {
          name: declarator.name, returnType: type.returnType, parameters, bindings: [], location: at,
          linkage, symbolKey, translationUnit, variadic: !!type.variadic, prototype: type.prototype !== false,
          oldStyle: !!declarator.oldStyle, inline: isInline, noreturn: isNoreturn,
        };
        if (peek().text === '{' || declarator.oldStyle && isDeclarationStart()) {
          if (!first || peek(1).text === ';') failure('SYNTAX_ERROR', 'Una definición de función debe ser una declaración externa independiente.', peek());
          if (isInline && linkage === 'external') unsupported(at, 'Las definiciones inline con linkage externo quedan pendientes hasta resolver por completo sus restricciones C11.');
          if (isNoreturn && declarator.name === 'main') failure('TYPE_ERROR', 'main no puede declararse _Noreturn.', declarator.location);
          if (declarator.oldStyle) {
            const byName = new Map(parameters.map((parameter, index) => [parameter.name, index]));
            const declared = new Set<string>();
            while (isDeclarationStart() && peek().text !== '{') {
              const declarationAt = peek();
              if (['static', 'extern', 'typedef', 'inline', '_Noreturn'].includes(peek().text)) {
                failure('SYNTAX_ERROR', 'Una declaración de parámetro K&R debe especificar solo su tipo y declarador.', declarationAt);
              }
              const parameterBase = parseTypeSpecifier();
              const parameterConst = lastSpecifierConst;
              do {
                const parameterDeclarator = parseDeclarator(false);
                const index = byName.get(parameterDeclarator.name);
                if (index === undefined) failure('UNKNOWN_IDENTIFIER', `«${parameterDeclarator.name}» no aparece en la lista K&R de parámetros.`, parameterDeclarator.location);
                if (declared.has(parameterDeclarator.name)) failure('REDECLARATION', `El parámetro K&R «${parameterDeclarator.name}» se declara más de una vez.`, parameterDeclarator.location);
                if (peek().text === '=') failure('SYNTAX_ERROR', 'Un parámetro no admite inicializador.', peek());
                let parameterType = declaredType(parameterDeclarator, parameterBase, parameterConst);
                if (isArray(parameterType) || isFunction(parameterType)) parameterType = decayType(parameterType);
                if (parameterType === 'void' || !isComplete(parameterType, aggregates)) failure('TYPE_ERROR', 'Un parámetro K&R requiere un tipo completo de objeto.', parameterDeclarator.location);
                parameters[index] = { name: parameterDeclarator.name, type: parameterType, isConst: isConstObjectType(parameterType, parameterDeclarator, parameterConst), location: parameterDeclarator.location };
                declared.add(parameterDeclarator.name);
                if (peek().text !== ',') break;
                consume();
              } while (true);
              expect(';');
            }
          }
          if (parameters.some(parameter => !parameter.name)) failure('SYNTAX_ERROR', 'Los parámetros de una definición necesitan un nombre.', fn.location);
          if (!declarator.prototype && !declarator.oldStyle && parameters.length) failure('TYPE_ERROR', 'Una definición sin prototipo no puede tener parámetros tipados.', fn.location);
          fn.parameters = parameters;
          fn.body = parseBody(1, parameters);
        } else if (peek().text !== ',') expect(';');
        if (isInline && linkage === 'external' && fn.body) unsupported(at, 'Las definiciones inline con linkage externo no están implementadas.');
        functions.push(fn);
      } else {
        if (isInline || isNoreturn) failure('TYPE_ERROR', 'inline y _Noreturn solo se aplican a funciones.', declarator.location);
        if (isExtern && isStatic) failure('CONFLICTING_LINKAGE', 'Un objeto no puede declarar simultáneamente static y extern.', declarator.location);
        declareOrdinary(declarator.name, declarator.location);
        if (type === 'void' || isFunction(type) || !isComplete(type, aggregates) && !isArray(type)) failure('TYPE_ERROR', 'Un objeto global necesita un tipo de objeto válido.', declarator.location);
        let initializer: Initializer | undefined;
        if (peek().text === '=') {
          consume();
          const priorDuration: 'automatic' | 'static' = expressionDuration; expressionDuration = 'static';
          try { initializer = parseInitializer(); } finally { expressionDuration = priorDuration; }
        }
        const inferredType = inferArrayType(type, initializer);
        const incompleteTentativeArray = isArray(inferredType) && inferredType.length === null && !initializer && isComplete(inferredType.element, aggregates);
        if (!isComplete(inferredType, aggregates) && !incompleteTentativeArray) failure('INCOMPLETE_TYPE', 'El objeto global debe tener un tipo completo.', declarator.location);
        let linkage: 'internal' | 'external' = isStatic ? 'internal' : 'external';
        if (isExtern && fileLinkage.get(declarator.name) === 'internal') linkage = 'internal';
        const previousLinkage = fileLinkage.get(declarator.name);
        if (previousLinkage && previousLinkage !== linkage) failure('CONFLICTING_LINKAGE', `El objeto «${declarator.name}» mezcla linkage interno y externo.`, declarator.location);
        fileLinkage.set(declarator.name, linkage);
        const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
        const prior = globals.find(global => global.symbolKey === symbolKey);
        if (prior) {
          const isConst = isConstObjectType(inferredType, declarator, baseConst);
          if (!!prior.isConst !== isConst || !compatibleType(prior.type, inferredType)) failure('CONFLICTING_TYPES', `Declaraciones incompatibles del objeto «${declarator.name}».`, declarator.location);
          if (prior.initializer && initializer) failure('REDEFINITION', `El objeto global «${declarator.name}» ya tiene una definición.`, declarator.location);
          if (!prior.initializer && initializer) prior.initializer = initializer;
          prior.tentative = prior.tentative || !isExtern && !initializer;
          prior.declarationOnly = prior.declarationOnly && isExtern && !initializer;
          if (!isComplete(prior.type, aggregates) && isComplete(inferredType, aggregates)) prior.type = inferredType;
        } else {
          globals.push({
            id: globals.length, name: declarator.name, type: inferredType, initializer, location: declarator.location,
            linkage, symbolKey, translationUnit, tentative: !isExtern && !initializer,
            declarationOnly: isExtern && !initializer, isConst: isConstObjectType(inferredType, declarator, baseConst),
          });
        }
      }
      first = false;
      if (peek().text !== ',') break;
      consume();
      if (functions.length && functions[functions.length - 1].location === at && functions[functions.length - 1].body) failure('SYNTAX_ERROR', 'Una definición de función no puede compartir declaradores.', at);
    }
    if (peek().text === ';') consume();
  }
  if (cursor === 0) failure('SYNTAX_ERROR', 'El archivo no contiene declaraciones externas.', peek());
  nextAggregateIdForParser = nextAggregateId;
  return { functions, aggregates, globals, translationUnit };
}

const requireInteger = (type: CType, location: Location) => {
  if (!isInteger(type)) failure('TYPE_ERROR', 'Este operador requiere operandos enteros.', location);
};
const requireArithmetic = (type: CType, location: Location) => {
  if (!isArithmetic(type)) failure('TYPE_ERROR', 'Este operador requiere un tipo aritmético.', location);
};
const requireScalar = (type: CType, location: Location) => {
  if (!isScalar(type)) failure('TYPE_ERROR', 'Este operador requiere un operando escalar.', location);
};

function constantExpression(root: Expression, aggregates: readonly AggregateDefinition[]): CValue {
  type Task =
    | { kind: 'evaluate'; node: Expression }
    | { kind: 'unary'; node: Extract<Expression, { kind: 'unary' | 'cast' }> }
    | { kind: 'binary-left'; node: Extract<Expression, { kind: 'binary' }> }
    | { kind: 'binary-right'; node: Extract<Expression, { kind: 'binary' }>; left: CValue }
    | { kind: 'conditional'; node: Extract<Expression, { kind: 'conditional' }>; selected?: Expression };
  const inferIntegerType = (root: Expression): CType => {
    const types = new Map<Expression, CType>();
    const pending: { node: Expression; done: boolean }[] = [{ node: root, done: false }];
    while (pending.length) {
      const current = pending.pop()!;
      const node = current.node;
      if (!current.done) {
        if (node.type) { types.set(node, node.type); continue; }
        pending.push({ node, done: true });
        const children = node.kind === 'sizeof' ? [] : expressionChildren(node);
        for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], done: false });
        continue;
      }
      switch (node.kind) {
        case 'literal': types.set(node, node.value.type); break;
        case 'sizeof': types.set(node, 'unsigned long'); break;
        case 'cast': types.set(node, node.targetType); break;
        case 'unary': types.set(node, node.operator === '!' ? 'int' : promote(types.get(node.operand)!)); break;
        case 'binary':
          types.set(node, ['&&', '||', '==', '!=', '<', '>', '<=', '>='].includes(node.operator)
            ? 'int' : node.operator === '<<' || node.operator === '>>' ? promote(types.get(node.left)!) : commonType(types.get(node.left)!, types.get(node.right)!));
          break;
        case 'conditional': types.set(node, commonType(types.get(node.then)!, types.get(node.else)!)); break;
        default: failure('NON_CONSTANT_CASE', 'case requiere una expresión constante entera.', node.location);
      }
    }
    return types.get(root)!;
  };
  const values = new Map<Expression, CValue>();
  const tasks: Task[] = [{ kind: 'evaluate', node: root }];
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === 'evaluate') {
      const node = task.node;
      if (node.kind === 'literal') { values.set(node, node.value); continue; }
      if (node.kind === 'sizeof') {
        const type = node.valueType ?? node.operand?.type;
        if (!type) failure('NON_CONSTANT_CASE', 'sizeof requiere un tipo conocido en una expresión constante.', node.location);
        values.set(node, { type: 'unsigned long', value: BigInt(sizeOfType(type, aggregates, node.location)) }); continue;
      }
      if (node.kind === 'cast' || node.kind === 'unary') {
        tasks.push({ kind: 'unary', node }); tasks.push({ kind: 'evaluate', node: node.operand }); continue;
      }
      if (node.kind === 'binary') {
        tasks.push({ kind: 'binary-left', node }); tasks.push({ kind: 'evaluate', node: node.left }); continue;
      }
      if (node.kind === 'conditional') {
        tasks.push({ kind: 'conditional', node }); tasks.push({ kind: 'evaluate', node: node.condition }); continue;
      }
      failure('NON_CONSTANT_CASE', 'case requiere una expresión constante entera.', node.location);
    }
    if (task.kind === 'unary') {
      const operand = values.get(task.node.operand)!;
      if (task.node.kind === 'cast') {
        if (!isInteger(task.node.targetType)) failure('NON_CONSTANT_CASE', 'Una constante sólo puede convertirse a un tipo entero.', task.node.location);
        values.set(task.node, convert(operand, task.node.targetType, task.node.location));
      } else if (task.node.operator === '!') values.set(task.node, { type: 'int', value: truth(operand) ? 0n : 1n });
      else values.set(task.node, unaryConstant(task.node.operator, operand, task.node.location));
      continue;
    }
    if (task.kind === 'binary-left') {
      const left = values.get(task.node.left)!;
      if (task.node.operator === '&&' && !truth(left)) { values.set(task.node, { type: 'int', value: 0n }); continue; }
      if (task.node.operator === '||' && truth(left)) { values.set(task.node, { type: 'int', value: 1n }); continue; }
      if (task.node.operator === ',') failure('NON_CONSTANT_CASE', 'La coma no forma parte de una expresión constante entera evaluada.', task.node.location);
      tasks.push({ kind: 'binary-right', node: task.node, left }); tasks.push({ kind: 'evaluate', node: task.node.right }); continue;
    }
    if (task.kind === 'binary-right') {
      const right = values.get(task.node.right)!;
      values.set(task.node, binary(task.node.operator, task.left, right, task.node.location)); continue;
    }
    if (task.selected) {
      const selectedValue = values.get(task.selected)!;
      const resultType = task.node.type ?? commonType(inferIntegerType(task.node.then), inferIntegerType(task.node.else));
      values.set(task.node, convert(selectedValue, resultType, task.node.location));
    } else {
      const condition = values.get(task.node.condition)!;
      const selected = truth(condition) ? task.node.then : task.node.else;
      tasks.push({ kind: 'conditional', node: task.node, selected });
      tasks.push({ kind: 'evaluate', node: selected });
    }
  }
  const result = values.get(root)!;
  if (!isInteger(result.type)) failure('NON_CONSTANT_CASE', 'case requiere una expresión constante entera.', root.location);
  return result;
}
function unaryConstant(operator: string, value: CValue, at: Location): CValue {
  return unary(operator, value, at);
}

export function analyze(program: ParsedProgram, options: { allowMissingMain?: boolean; allowUnresolved?: boolean } = {}): number | undefined {
  const { functions, globals, aggregates } = program;
  type Signature = { fn: FunctionIR; definition?: number; builtin?: number };
  const signatures = new Map<string, Signature>();
  const globalByName = new Map<string, GlobalObject>();
  for (const global of globals) {
    const prior = globalByName.get(global.name);
    if (prior) {
      if (!compatibleType(prior.type, global.type)) failure('CONFLICTING_TYPES', `Declaraciones incompatibles de «${global.name}».`, global.location);
      if (prior.initializer && global.initializer) failure('REDEFINITION', `El objeto global «${global.name}» ya está inicializado.`, global.location);
      if (!prior.initializer && global.initializer) prior.initializer = global.initializer;
      continue;
    }
    globalByName.set(global.name, global);
  }
  const functionType = (fn: FunctionIR): CType => functionOf(fn.returnType, fn.parameters.map(parameter => parameter.type), !!fn.variadic, fn.prototype !== false);
  for (let index = 0; index < functions.length; index++) {
    const fn = functions[index];
    if (globalByName.has(fn.name)) failure('CONFLICTING_TYPES', `«${fn.name}» declara tanto un objeto como una función.`, fn.location);
    const prior = signatures.get(fn.name);
    if (prior && !compatibleType(functionType(prior.fn), functionType(fn))) failure('CONFLICTING_TYPES', `Declaraciones incompatibles de «${fn.name}».`, fn.location);
    if (fn.body && prior?.definition !== undefined) failure('REDEFINITION', `La función «${fn.name}» ya tiene una definición.`, fn.location);
    const signature = prior ?? { fn };
    if (fn.body) signature.definition = index;
    const builtin = BUILTINS[fn.name] || LIBRARY_FUNCTIONS.includes(fn.name) || fn.name.startsWith('__builtin_va_')
      ? { returnType: fn.returnType, parameters: fn.parameters.map(parameter => parameter.type) }
      : undefined;
    if (!fn.body && builtin) {
      if (!LIBRARY_FUNCTIONS.includes(fn.name) && !fn.name.startsWith('__builtin_va_') &&
          (!sameType(fn.returnType, builtin.returnType) || fn.parameters.length !== builtin.parameters.length || !fn.parameters.every((parameter, parameterIndex) => sameType(parameter.type, builtin.parameters[parameterIndex])))) {
        failure('CONFLICTING_TYPES', `El prototipo de «${fn.name}» no coincide con su biblioteca.`, fn.location);
      }
      signature.builtin = index;
    }
    if (signature.fn.prototype === false && fn.prototype !== false) signature.fn = fn;
    signatures.set(fn.name, signature);
  }
  for (const signature of signatures.values()) if (signature.definition === undefined && signature.builtin !== undefined) functions[signature.builtin].builtin = true;
  const main = signatures.get('main');
  if (!options.allowMissingMain) {
    if (!main || main.definition === undefined) failure('MISSING_MAIN', 'Se requiere una definición de main con linkage externo.', functions[0]?.location ?? globals[0]?.location ?? { file: program.translationUnit ?? 'main.c', line: 1, column: 1 });
    if (main.fn.returnType !== 'int' || main.fn.parameters.length &&
        !(main.fn.parameters.length === 2 && main.fn.parameters[0].type === 'int' && isPointer(main.fn.parameters[1].type) &&
          isPointer(main.fn.parameters[1].type.base) && main.fn.parameters[1].type.base.base === 'char')) {
      failure('UNSUPPORTED_FEATURE', 'P4 admite int main(void) o int main(int, char **).', main.fn.location);
    }
  }
  const mainDefinition = main?.definition;

  const visibleFunctions = new Map<string, Signature>();
  let globalsAnalyzed = false;
  for (const fn of functions) {
    const signature = signatures.get(fn.name)!;
    visibleFunctions.set(fn.name, signature);
    if (!fn.body) continue;
    type ScopeOwner = Block | Extract<Statement, { kind: 'for' }>;
    const scopes: Scope[] = [{ names: new Map(), owner: fn.body }];
    const globalVisible = new Map<string, GlobalObject>();
    for (const global of globals) {
      if (comesBefore(global.location, fn.location)) globalVisible.set(global.name, globalByName.get(global.name)!);
    }
    fn.body.bindings = []; fn.bindings = [];
    const findLocal = (name: string) => {
      for (let index = scopes.length - 1; index >= 0; index--) {
        const binding = scopes[index].names.get(name); if (binding) return binding;
      }
      return undefined;
    };
    const declare = (name: string, type: CType, location: Location, parameter = false, isConst = false, staticStorage = false) => {
      const scope = scopes[scopes.length - 1];
      if (scope.names.has(name)) failure('REDECLARATION', `La variable «${name}» ya está declarada en este ámbito.`, location);
      const id = fn.bindings.length;
      const binding: Binding = {
        id, name, type, location, isConst: isConst || (isPointer(type) && !!type.const),
        ...(parameter ? { isParameter: true } : {}),
        storageDuration: staticStorage ? 'static' : 'automatic',
        ...(staticStorage ? { storageKey: `${fn.translationUnit ?? program.translationUnit ?? location.file}::${fn.symbolKey ?? fn.name}::${name}::${id}` } : {}),
      };
      fn.bindings.push(binding); scope.names.set(name, binding);
      if (!parameter) scope.owner?.bindings?.push(binding.id);
      return binding.id;
    };
    const isLvalue = (node: Expression): boolean => {
      switch (node.kind) {
        case 'variable': case 'index': return true;
        case 'member': return node.type !== undefined && !isFunction(node.type) && (node.arrow || isLvalue(node.base));
        case 'unary': return node.operator === '*';
        case 'compoundLiteral': return true;
        default: return false;
      }
    };
    const canAssign = (target: CType, source: CType, expression: Expression): boolean => {
      if (isArithmetic(target) && isArithmetic(source)) return true;
      if (isAggregate(target) || isAggregate(source)) return compatibleType(target, source);
      if (isPointer(target)) {
        if (isPointer(source)) return compatibleType(target, source) || canConvertPointerType(source, target);
        return isInteger(source) && isNullPointerConstant(expression, aggregates);
      }
      return false;
    };
    const convertedValue = (node: Expression): Expression => {
      const source = analyzeExpression(node);
      if (isArray(source) || isFunction(source)) {
        const decay = decayType(source);
        const converted: Expression = {
          kind: 'decay', operand: node, location: node.location,
          type: isArray(source) && node.isConst && isPointer(decay) ? pointerTo(decay.base, { baseConst: true }) : decay,
        };
        return converted;
      }
      return node;
    };
    const findMemberPath = (type: CType, name: string, at: Location): AggregateMember[] => {
      if (!isAggregate(type)) failure('TYPE_ERROR', 'El acceso a miembros requiere un struct o union.', at);
      const root = aggregates.find(item => item.id === type.id);
      if (!root || !root.complete) failure('INCOMPLETE_TYPE', 'No se puede acceder a miembros de un agregado incompleto.', at);
      const matches: AggregateMember[][] = [];
      const pending: { definition: AggregateDefinition; path: AggregateMember[] }[] = [{ definition: root, path: [] }];
      while (pending.length) {
        const current = pending.pop()!;
        for (let index = current.definition.members.length - 1; index >= 0; index--) {
          const member = current.definition.members[index];
          const path = [...current.path, member];
          if (member.name === name) matches.push(path);
          else if (member.name === '' && isAggregate(member.type)) {
            const memberType = member.type;
            const nested = aggregates.find(item => item.id === memberType.id);
            if (nested?.complete) pending.push({ definition: nested, path });
          }
        }
      }
      if (!matches.length) failure('UNKNOWN_MEMBER', `El agregado no tiene un miembro «${name}».`, at);
      if (matches.length > 1) failure('AMBIGUOUS_MEMBER', `El miembro «${name}» está promovido por más de un miembro anónimo.`, at);
      return matches[0];
    };

    const analyzedValue = (node: Expression): Expression => {
      const source = node.type!;
      return isArray(source) || isFunction(source)
        ? {
          kind: 'decay', operand: node, location: node.location,
          type: isArray(source) && node.isConst && isPointer(decayType(source))
            ? pointerTo((decayType(source) as Extract<CType, { kind: 'pointer' }>).base, { baseConst: true })
            : decayType(source),
        }
        : node;
    };
    const analyzeExpression = (root: Expression): CType => {
      const pending: { node: Expression; done: boolean }[] = [{ node: root, done: false }];
      while (pending.length) {
        const work = pending.pop()!;
        const node = work.node;
        if (!work.done) {
          pending.push({ node, done: true });
          const children = expressionChildren(node);
          for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], done: false });
          continue;
        }
        switch (node.kind) {
          case 'literal': node.type = node.value.type; break;
          case 'string': node.type = arrayOf('char', node.bytes.length); break;
          case 'variable': {
            if (vaIntrinsics.has(node.name)) {
              const replacement = node as unknown as Extract<Expression, { kind: 'function' }>;
              replacement.kind = 'function'; replacement.name = node.name;
              replacement.type = functionOf('void', [], true);
              break;
            }
            const local = findLocal(node.name);
            if (local) { node.binding = local.id; node.type = local.type; node.isConst = !!local.isConst; break; }
            const global = globalVisible.get(node.name);
            if (global) { node.globalBinding = global.id; node.type = global.type; node.isConst = !!global.isConst; break; }
            const signature = visibleFunctions.get(node.name);
            if (signature) {
            const functionIndex = signature.definition ?? signature.builtin;
            if (functionIndex === undefined && !options.allowUnresolved) failure('UNDEFINED_FUNCTION', `La función «${node.name}» no tiene definición en este programa.`, node.location);
              const replacement = node as unknown as Extract<Expression, { kind: 'function' }>;
            replacement.kind = 'function'; replacement.functionIndex = functionIndex; replacement.symbolKey = signature.fn.symbolKey; replacement.type = functionType(signature.fn); break;
            }
            failure('UNKNOWN_IDENTIFIER', `La variable «${node.name}» no está declarada en este ámbito.`, node.location);
          }
          case 'function': {
            const signature = visibleFunctions.get(node.name);
            if (!signature) failure('UNKNOWN_FUNCTION', `La función «${node.name}» debe declararse antes de su uso.`, node.location);
            const functionIndex = signature.definition ?? signature.builtin;
            if (functionIndex === undefined && !options.allowUnresolved) failure('UNDEFINED_FUNCTION', `La función «${node.name}» no tiene definición en este programa.`, node.location);
            node.functionIndex = functionIndex; node.symbolKey = signature.fn.symbolKey; node.type = functionType(signature.fn); break;
          }
          case 'unary': {
            if (node.operator === '&') {
              const operandType = node.operand.type!;
              if (!isLvalue(node.operand) && !isFunction(operandType)) failure('INVALID_LVALUE', 'El operador & requiere un objeto o función designador.', node.location);
              if (isArray(operandType) && !isComplete(operandType, aggregates)) failure('INCOMPLETE_TYPE', 'No se puede tomar la dirección de un array incompleto.', node.location);
              node.type = pointerTo(operandType, { baseConst: !!node.operand.isConst }); break;
            }
            node.operand = analyzedValue(node.operand);
            const operandType = node.operand.type!;
            if (node.operator === '*') {
              if (!isPointer(operandType)) failure('TYPE_ERROR', 'El operador * requiere un puntero.', node.location);
              if (operandType.base === 'void') failure('INCOMPLETE_TYPE', 'No se puede desreferenciar void *. ', node.location);
              if (!isComplete(operandType.base, aggregates) && !isFunction(operandType.base)) failure('INCOMPLETE_TYPE', 'No se puede desreferenciar un puntero a tipo incompleto.', node.location);
              node.type = operandType.base; node.isConst = !!operandType.baseConst; break;
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
              if (node.operator === '-' && isPointer(leftType) && isPointer(rightType) && compatibleType(leftType, rightType) && leftType.base !== 'void') { node.type = 'long'; break; }
              failure('TYPE_ERROR', `Operandos incompatibles para «${node.operator}».`, node.location);
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
              failure('TYPE_ERROR', `Operandos incompatibles para «${node.operator}».`, node.location);
            }
            failure('UNSUPPORTED_FEATURE', `Operador binario no implementado: «${node.operator}».`, node.location);
          }
          case 'assignment': {
            const targetType = node.target.type!;
            if (!isLvalue(node.target) || node.target.isConst || !isModifiableObject(targetType, aggregates)) failure('INVALID_LVALUE', 'La asignación necesita un lvalue modificable.', node.location);
            node.value = analyzedValue(node.value);
            const valueType = node.value.type!;
            if (node.operator === '=') {
              if (!canAssign(targetType, valueType, node.value)) failure('TYPE_ERROR', `No se puede asignar ${typeName(valueType, aggregates)} a ${typeName(targetType, aggregates)}.`, node.location);
            } else {
              const op = node.operator.slice(0, -1);
              if (isPointer(targetType) && (op === '+' || op === '-') && isInteger(valueType)) requirePointerArithmetic(targetType, aggregates, node.location);
              else if (!isArithmetic(targetType) || !isArithmetic(valueType)) failure('TYPE_ERROR', `El operador «${node.operator}» requiere operandos aritméticos compatibles.`, node.location);
              else if (['%', '&', '|', '^', '<<', '>>'].includes(op)) { requireInteger(targetType, node.location); requireInteger(valueType, node.location); }
            }
            node.type = targetType; break;
          }
          case 'update': {
            const type = node.operand.type!;
            if (!isLvalue(node.operand) || node.operand.isConst || !isModifiableObject(type, aggregates)) failure('INVALID_LVALUE', '++ y -- necesitan un lvalue modificable.', node.location);
            if (!isArithmetic(type)) {
              if (!isPointer(type)) failure('TYPE_ERROR', '++ y -- requieren un tipo aritmético o puntero a objeto.', node.location);
              requirePointerArithmetic(type, aggregates, node.location);
            }
            node.type = type; break;
          }
          case 'cast': {
            node.operand = analyzedValue(node.operand);
            const source = node.operand.type!;
            const target = node.targetType;
            if (target === 'void') { node.type = target; break; }
            if (isArray(target) || isFunction(target) || isAggregate(target)) failure('TYPE_ERROR', 'Un cast debe producir void o un tipo escalar.', node.location);
            if (isArithmetic(target) && isArithmetic(source) || isPointer(target) && (isPointer(source) || isInteger(source)) || isInteger(target) && isPointer(source)) { node.type = target; break; }
            failure('TYPE_ERROR', 'Tipos incompatibles en el cast.', node.location);
          }
          case 'sizeof': {
            const type = node.valueType ?? node.operand!.type!;
            if (!isComplete(type, aggregates) || isFunction(type)) failure('INCOMPLETE_TYPE', 'sizeof requiere un tipo de objeto completo.', node.location);
            sizeOfType(type, aggregates, node.location); node.type = 'unsigned long'; break;
          }
          case 'conditional': {
            node.condition = analyzedValue(node.condition); requireScalar(node.condition.type!, node.condition.location);
            node.then = analyzedValue(node.then); node.else = analyzedValue(node.else);
            const left = node.then.type!, right = node.else.type!;
            if (left === 'void' && right === 'void') node.type = 'void';
            else if (isArithmetic(left) && isArithmetic(right)) node.type = commonType(left, right);
            else if (isAggregate(left) && compatibleType(left, right)) node.type = left;
            else if (isPointer(left) && isPointer(right) && (compatibleType(left, right) || canConvertPointerType(left, right))) node.type = compatibleType(left, right) ? left : pointerTo('void');
            else if (isPointer(left) && isInteger(right) && isNullPointerConstant(node.else, aggregates)) node.type = left;
            else if (isPointer(right) && isInteger(left) && isNullPointerConstant(node.then, aggregates)) node.type = right;
            else failure('TYPE_ERROR', 'Las ramas de ?: deben tener tipos compatibles.', node.location);
            break;
          }
          case 'index': {
            node.base = analyzedValue(node.base); node.index = analyzedValue(node.index);
            let baseType = node.base.type!, indexType = node.index.type!;
            if (isInteger(baseType) && isPointer(indexType)) {
              [node.base, node.index] = [node.index, node.base];
              [baseType, indexType] = [indexType, baseType];
            }
            if (!isPointer(baseType) || !isInteger(indexType)) failure('TYPE_ERROR', 'El subíndice requiere un puntero a objeto y un índice entero.', node.location);
            if (baseType.base === 'void' || isFunction(baseType.base) || !isComplete(baseType.base, aggregates)) failure('INCOMPLETE_TYPE', 'El subíndice requiere un puntero a tipo completo de objeto.', node.location);
            node.type = baseType.base; node.isConst = !!baseType.baseConst; break;
          }
          case 'member': {
            const throughPointer = node.arrow;
            let aggregateType: CType;
            if (node.arrow) {
              node.base = analyzedValue(node.base);
              const pointer = node.base.type!;
              if (!isPointer(pointer) || pointer.base === 'void') failure('TYPE_ERROR', 'El operador -> requiere un puntero a struct o union.', node.location);
              aggregateType = pointer.base;
            } else aggregateType = node.base.type!;
            const path = findMemberPath(aggregateType, node.name, node.location);
            const baseConst = throughPointer
              ? isPointer(node.base.type!) && !!node.base.type!.baseConst
              : !!node.base.isConst;
            let intermediate = node.base;
            const firstIndex = 0;
            const last = path[path.length - 1];
            const end = path.length - 1;
            for (let index = firstIndex; index < end; index++) {
              const member = path[index];
              intermediate = { kind: 'member', base: intermediate, name: member.name, arrow: node.arrow && index === 0, memberIndex: member.index, location: node.location, type: member.type };
            }
            if (path.length > 1) { node.base = intermediate; node.arrow = false; }
            node.memberIndex = last.index; node.name = last.name; node.type = last.type;
            node.isConst = baseConst || path.some(member => !!member.isConst);
            break;
          }
          case 'decay': {
            const source = node.operand.type!;
            if (!isArray(source) && !isFunction(source)) failure('TYPE_ERROR', 'Conversión array/function decay inválida.', node.location);
            node.type = decayType(source); break;
          }
          case 'compoundLiteral': {
            if (isFunction(node.objectType) || node.objectType === 'void' || !isComplete(node.objectType, aggregates)) failure('INCOMPLETE_TYPE', 'Un compound literal necesita un tipo de objeto completo.', node.location);
            node.initializer = analyzeInitializer(node.objectType, node.initializer, false);
            node.type = node.objectType; break;
          }
          case 'vaArg': {
            node.ap = analyzedValue(node.ap);
            if (!isPointer(node.ap.type!) || node.ap.type!.base !== 'void') failure('TYPE_ERROR', 'va_arg requiere una va_list activa.', node.location);
            if (!isScalar(node.valueType) && !isAggregate(node.valueType) || !isComplete(node.valueType, aggregates)) {
              failure('TYPE_ERROR', 'El tipo de va_arg debe ser un tipo completo de objeto.', node.location);
            }
            node.type = node.valueType;
            break;
          }
          case 'call': {
            if (!node.callee) failure('ENGINE_INTERNAL_ERROR', 'La llamada no tiene callee.', node.location);
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
              if (!isPointer(valueCallee.type!) || !isFunction(valueCallee.type!.base)) failure('NOT_CALLABLE', 'La expresión llamada no es una función ni un puntero a función.', node.location);
              signatureType = valueCallee.type!.base;
            }
            const signature = signatureType as Extract<CType, { kind: 'function' }>;
            if (signature.prototype !== false && (node.args.length < signature.parameters.length || !signature.variadic && node.args.length !== signature.parameters.length)) {
              failure('TYPE_ERROR', `La llamada requiere ${signature.variadic ? 'al menos ' : ''}${signature.parameters.length} argumentos.`, node.location);
            }
            if (signature.prototype === false && !options.allowUnresolved && node.args.length !== signature.parameters.length && signature.parameters.length > 0) {
              // A no-prototype call is checked against the definition at link time.
            }
            for (let index = 0; index < node.args.length; index++) {
              node.args[index] = analyzedValue(node.args[index]);
              const actual = node.args[index].type!;
              if (index < signature.parameters.length && signature.prototype !== false) {
                const expected = signature.parameters[index];
                if (!canAssign(expected, actual, node.args[index])) failure('TYPE_ERROR', `El argumento ${index + 1} no es compatible con ${typeName(expected, aggregates)}.`, node.args[index].location);
              } else if (!signature.prototype || signature.variadic) {
                if (!(isScalar(actual) || isAggregate(actual) && isComplete(actual, aggregates))) failure('TYPE_ERROR', 'Un argumento variádico requiere un tipo completo permitido.', node.args[index].location);
              }
            }
            if (node.name && node.builtin && floatingClassifications.has(node.name) && node.args[0] &&
                node.args[0].type !== 'float' && node.args[0].type !== 'double' && node.args[0].type !== 'long double') {
              failure('TYPE_ERROR', `«${node.name}» requiere un argumento flotante.`, node.args[0].location);
            }
            node.type = signature.returnType; break;
          }
        }
      }
      return root.type!;
    };

    const integerConstantValue = (node: Expression): bigint | undefined => {
      try {
        const value = constantExpression(node, aggregates);
        return isInteger(value.type) && typeof value.value === 'bigint' ? value.value : undefined;
      } catch { return undefined; }
    };
    const isArithmeticConstantExpression = (root: Expression): boolean => {
      const pending: Expression[] = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.kind === 'literal') { if (!isArithmetic(node.value.type)) return false; continue; }
        if (node.kind === 'sizeof') continue;
        if (node.kind === 'cast') {
          if (!isArithmetic(node.targetType)) return false;
          pending.push(node.operand); continue;
        }
        if (node.kind === 'unary') {
          if (!['+', '-', '!', '~'].includes(node.operator)) return false;
          pending.push(node.operand); continue;
        }
        if (node.kind === 'binary') {
          if (node.operator === ',') return false;
          pending.push(node.left, node.right); continue;
        }
        if (node.kind === 'conditional') { pending.push(node.condition, node.then, node.else); continue; }
        return false;
      }
      return true;
    };
    const isStaticAddressConstant = (node: Expression): boolean => {
      if (node.kind === 'function' || node.kind === 'string') return true;
      if (node.kind === 'unary' && node.operator === '&') {
        const operand = node.operand;
        if (operand.kind === 'function') return true;
        if (operand.kind === 'variable') return operand.globalBinding !== undefined;
        if (operand.kind === 'index' || operand.kind === 'member') return isStaticObjectDesignator(operand);
        if (operand.kind === 'unary' && operand.operator === '*') return isStaticAddressConstant(operand.operand);
        if (operand.kind === 'compoundLiteral') return operand.duration === 'static' && isStaticInitializer(operand.initializer);
        return false;
      }
      if (node.kind === 'decay') return node.operand.kind === 'string' || node.operand.kind === 'function' || node.operand.kind === 'variable' && node.operand.globalBinding !== undefined ||
        node.operand.kind === 'compoundLiteral' && node.operand.duration === 'static' && isStaticInitializer(node.operand.initializer);
      if (node.kind === 'cast' && isPointer(node.targetType)) return isStaticAddressConstant(node.operand) || integerConstantValue(node.operand) !== undefined;
      if (node.kind === 'binary' && (node.operator === '+' || node.operator === '-')) {
        return isStaticAddressConstant(node.left) && integerConstantValue(node.right) !== undefined ||
          node.operator === '+' && integerConstantValue(node.left) !== undefined && isStaticAddressConstant(node.right);
      }
      if (node.kind === 'compoundLiteral') return node.duration === 'static' && isStaticInitializer(node.initializer);
      return false;
    };
    const isStaticObjectDesignator = (node: Expression): boolean => {
      if (node.kind === 'variable') return node.globalBinding !== undefined;
      if (node.kind === 'member') return node.arrow ? isStaticAddressConstant(node.base) : isStaticObjectDesignator(node.base);
      if (node.kind === 'index') return integerConstantValue(node.index) !== undefined &&
        (isStaticObjectDesignator(node.base) || isStaticAddressConstant(node.base));
      if (node.kind === 'unary' && node.operator === '*') return isStaticAddressConstant(node.operand);
      return false;
    };
    const isStaticInitializerExpression = (node: Expression): boolean => {
      if (node.kind === 'string') return true;
      if (isArithmetic(node.type ?? 'void')) return isArithmeticConstantExpression(node);
      if (isPointer(node.type ?? 'void')) return isNullPointerConstant(node, aggregates) || isStaticAddressConstant(node);
      if (node.kind === 'compoundLiteral') return node.duration === 'static' && isStaticInitializer(node.initializer);
      return false;
    };
    function isStaticInitializer(initializer: Initializer): boolean {
      if (initializer.kind === 'expression') return isStaticInitializerExpression(initializer.value);
      return initializer.items.every(item => isStaticInitializer(item.initializer));
    }
    function* scalarInitializerTypes(root: CType): Generator<CType> {
      const pending: { type: CType; next: number; count: number }[] = [{ type: root, next: 0, count: 0 }];
      while (pending.length) {
        const current = pending[pending.length - 1];
        if (isArray(current.type)) {
          if (current.type.length === null) failure('INCOMPLETE_TYPE', 'Un array incompleto no admite inicialización por subobjetos.', fn.location);
          if (current.next >= current.type.length) { pending.pop(); continue; }
          current.next++;
          pending.push({ type: current.type.element, next: 0, count: 0 });
          continue;
        }
        if (isAggregate(current.type)) {
          const aggregateType = current.type;
          const definition = aggregates.find(value => value.id === aggregateType.id)!;
          current.count = definition.kind === 'union' ? Math.min(1, definition.members.length) : definition.members.length;
          if (current.next >= current.count) { pending.pop(); continue; }
          const member = definition.members[current.next++];
          pending.push({ type: member.type, next: 0, count: 0 });
          continue;
        }
        yield current.type;
        pending.pop();
      }
    }
    const analyzeInitializer = (type: CType, initializer: Initializer, fileDuration: boolean): Initializer => {
      if (!isComplete(type, aggregates)) failure('INCOMPLETE_TYPE', 'El inicializador requiere un objeto completo.', initializer.location);
      if (initializer.kind === 'expression') {
        const original = initializer.value;
        const sourceType = analyzeExpression(original);
        if (isArray(type) && type.element === 'char' && original.kind === 'string') {
          const textLength = original.bytes.length - 1;
          if (type.length! < textLength) failure('INITIALIZER_TOO_LARGE', 'La cadena no cabe en el array de caracteres.', original.location);
        } else {
          initializer.value = convertedValue(original);
          if (!canAssign(type, initializer.value.type!, initializer.value)) failure('TYPE_ERROR', `No se puede inicializar ${typeName(type, aggregates)} con ${typeName(sourceType, aggregates)}.`, original.location);
        }
        if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'Un objeto de duración estática requiere un inicializador constante.', initializer.location);
        return initializer;
      }

      if (isArray(type) && type.element === 'char' && initializer.items.length === 1 && initializer.items[0].designators.length === 0) {
        const single = initializer.items[0].initializer;
        if (single.kind === 'expression' && single.value.kind === 'string') return analyzeInitializer(type, single, fileDuration);
      }
      if ((isArray(type) || isAggregate(type)) && initializer.items.length > 0 &&
          initializer.items.every(item => item.designators.length === 0 && item.initializer.kind === 'expression') &&
          initializer.items.every(item => !isAggregate(analyzeExpression((item.initializer as Extract<Initializer, { kind: 'expression' }>).value)))) {
        const slots = scalarInitializerTypes(type);
        for (const item of initializer.items) {
          const slot = slots.next();
          if (slot.done) failure('INITIALIZER_TOO_LARGE', 'Hay más valores que subobjetos escalares en el inicializador.', item.location);
          analyzeInitializer(slot.value, item.initializer, fileDuration);
        }
        if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'Un objeto de duración estática requiere un inicializador constante.', initializer.location);
        return initializer;
      }
      let nextIndex = 0;
      let count = 0;
      for (const item of initializer.items) {
        if (isArray(type)) {
          let selected = nextIndex;
          let childType: CType = type.element;
          if (item.designators.length) {
            const first = item.designators[0];
            if (first.kind !== 'index') failure('INVALID_DESIGNATOR', 'Un array requiere un designador de índice.', first.location);
            if (first.index > BigInt(Number.MAX_SAFE_INTEGER)) failure('INVALID_DESIGNATOR', 'El índice designado excede el rango representable.', first.location);
            selected = Number(first.index);
            if (type.length !== null && selected >= type.length) failure('INVALID_DESIGNATOR', 'El índice designado excede el array.', first.location);
            nextIndex = selected + 1;
            childType = followDesignators(type, item.designators);
          } else {
            if (type.length !== null && selected >= type.length) failure('INITIALIZER_TOO_LARGE', 'Hay más elementos que posiciones en el array.', item.location);
            nextIndex++; childType = followDesignators(childType, []);
          }
          analyzeInitializer(childType, item.initializer, fileDuration); count++; continue;
        }
        if (isAggregate(type)) {
          const definition = aggregates.find(value => value.id === type.id)!;
          if (definition.kind === 'union' && count > 0) failure('INITIALIZER_TOO_LARGE', 'Un union sólo puede inicializar un miembro.', item.location);
          let member: AggregateMember;
          if (item.designators.length) {
            const first = item.designators[0];
            if (first.kind !== 'member') failure('INVALID_DESIGNATOR', 'Un struct o union requiere un designador de miembro.', first.location);
            const nestedType = followDesignators(type, item.designators);
            const selected = item.designators[0];
            if (selected.kind !== 'member') failure('ENGINE_INTERNAL_ERROR', 'La ruta de miembro perdió su designador inicial.', item.location);
            member = definition.members[selected.memberIndex ?? definition.members.findIndex(value => value.name === selected.name)];
            if (!member) failure('UNKNOWN_MEMBER', `El agregado no tiene un miembro «${first.name}».`, first.location);
            nextIndex = member.index + 1;
            analyzeInitializer(nestedType, item.initializer, fileDuration); count++; continue;
          }
          if (nextIndex >= definition.members.length) failure('INITIALIZER_TOO_LARGE', 'Hay más inicializadores que miembros en el agregado.', item.location);
          member = definition.members[nextIndex++];
          analyzeInitializer(member.type, item.initializer, fileDuration); count++; continue;
        }
        if (item.designators.length) failure('INVALID_DESIGNATOR', 'Un escalar no admite designadores.', item.designators[0].location);
        if (count > 0) failure('INITIALIZER_TOO_LARGE', 'Un escalar sólo admite un elemento de inicialización.', item.location);
        analyzeInitializer(type, item.initializer, fileDuration); count++;
      }
      if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'Un objeto de duración estática requiere un inicializador constante.', initializer.location);
      return initializer;
    };
    const followDesignators = (initial: CType, designators: InitializerDesignator[]): CType => {
      let type = initial;
      const expanded: InitializerDesignator[] = [];
      for (const designator of designators) {
        if (designator.kind === 'member') {
          if (!isAggregate(type)) failure('INVALID_DESIGNATOR', 'Un designador de miembro requiere un struct o union.', designator.location);
          const aggregateType = type;
          const definition = aggregates.find(value => value.id === aggregateType.id)!;
          let path: AggregateMember[];
          if (designator.memberIndex !== undefined) {
            const member = definition.members[designator.memberIndex];
            if (!member || member.name !== designator.name) failure('INVALID_DESIGNATOR', 'El índice del miembro designado no coincide con el agregado.', designator.location);
            path = [member];
          } else path = findMemberPath(aggregateType, designator.name, designator.location);
          for (const member of path) {
            expanded.push({ kind: 'member', name: member.name, memberIndex: member.index, location: designator.location });
            type = member.type;
          }
        } else {
          const arrayType = type;
          if (!isArray(arrayType)) failure('INVALID_DESIGNATOR', 'Un designador de índice requiere un array.', designator.location);
          if (designator.index > BigInt(Number.MAX_SAFE_INTEGER) || arrayType.length !== null && designator.index >= BigInt(arrayType.length)) failure('INVALID_DESIGNATOR', 'El índice designado excede el array.', designator.location);
          expanded.push(designator);
          type = arrayType.element;
        }
      }
      designators.splice(0, designators.length, ...expanded);
      return type;
    };

    if (!globalsAnalyzed) {
      globalsAnalyzed = true;
      const priorVisible = new Map(globalVisible);
      const priorFunctions = new Map(visibleFunctions);
      for (const global of globals) {
        if (!global.initializer) continue;
        globalVisible.clear();
        for (const candidate of globals) {
          if (comesBefore(candidate.location, global.initializer.location)) globalVisible.set(candidate.name, globalByName.get(candidate.name)!);
        }
        visibleFunctions.clear();
        for (const declaration of functions) {
          if (comesBefore(declaration.location, global.initializer.location)) visibleFunctions.set(declaration.name, signatures.get(declaration.name)!);
        }
        global.initializer = analyzeInitializer(global.type, global.initializer, true);
      }
      globalVisible.clear();
      for (const [name, global] of priorVisible) globalVisible.set(name, global);
      visibleFunctions.clear();
      for (const [name, declaration] of priorFunctions) visibleFunctions.set(name, declaration);
    }
    for (const parameter of fn.parameters) {
      if (!parameter.name) failure('SYNTAX_ERROR', 'Los parámetros de una definición necesitan un nombre.', parameter.location);
      parameter.binding = declare(parameter.name, parameter.type, parameter.location, true, parameter.isConst);
    }
    type SwitchContext = { type: CType; cases: Set<string>; hasDefault: boolean };
    const labels = new Map<string, Location>();
    const gotos: Extract<Statement, { kind: 'goto' }>[] = [];
    const pushScope = (owner?: ScopeOwner) => {
      if (owner) owner.bindings = [];
      scopes.push({ names: new Map(), owner });
    };
    const popScope = () => { if (scopes.length > 1) scopes.pop(); };
    type StatementWork =
      | { node: Statement; loops: number; switches: SwitchContext[]; root?: boolean }
      | { leaveScope: true }
      | { finishFor: Extract<Statement, { kind: 'for' }> };
    const pendingStatements: StatementWork[] = [{ node: fn.body, loops: 0, switches: [], root: true }];
    while (pendingStatements.length) {
      const work = pendingStatements.pop()!;
      if ('leaveScope' in work) { popScope(); continue; }
      if ('finishFor' in work) {
        const node = work.finishFor;
        if (node.condition) { node.condition = convertedValue(node.condition); requireScalar(node.condition.type!, node.condition.location); }
        if (node.increment) analyzeExpression(node.increment);
        continue;
      }
      const { node, loops, switches } = work;
      switch (node.kind) {
        case 'block':
          if (!work.root) { pushScope(node); pendingStatements.push({ leaveScope: true }); }
          for (let index = node.statements.length - 1; index >= 0; index--) pendingStatements.push({ node: node.statements[index], loops, switches });
          break;
        case 'sequence':
          for (let index = node.statements.length - 1; index >= 0; index--) pendingStatements.push({ node: node.statements[index], loops, switches });
          break;
        case 'declaration': {
          node.binding = declare(node.name, node.type, node.location, false, !!node.const, !!node.static);
          if (node.initializer) node.initializer = analyzeInitializer(node.type, node.initializer, !!node.static);
          break;
        }
        case 'return': {
          if (fn.returnType === 'void') {
            if (node.value) failure('TYPE_ERROR', 'Una función void no puede devolver una expresión.', node.location);
          } else {
            if (!node.value) failure('SYNTAX_ERROR', 'Una función no void requiere un valor de retorno.', node.location);
            node.value = convertedValue(node.value);
            if (!canAssign(fn.returnType, node.value.type!, node.value)) failure('TYPE_ERROR', `No se puede devolver ${typeName(node.value.type!, aggregates)} desde una función que retorna ${typeName(fn.returnType, aggregates)}.`, node.location);
          }
          break;
        }
        case 'expression': analyzeExpression(node.value); break;
        case 'if':
          node.condition = convertedValue(node.condition); requireScalar(node.condition.type!, node.condition.location);
          pushScope(); pendingStatements.push({ leaveScope: true });
          if (node.else) pendingStatements.push({ node: node.else, loops, switches });
          pendingStatements.push({ node: node.then, loops, switches });
          break;
        case 'while': case 'do':
          node.condition = convertedValue(node.condition); requireScalar(node.condition.type!, node.condition.location);
          pushScope(); pendingStatements.push({ leaveScope: true });
          pendingStatements.push({ node: node.body, loops: loops + 1, switches });
          break;
        case 'for': {
          pushScope(node); pendingStatements.push({ leaveScope: true });
          pendingStatements.push({ node: node.body, loops: loops + 1, switches });
          pendingStatements.push({ finishFor: node });
          if (node.initializer) pendingStatements.push({ node: node.initializer, loops, switches });
          break;
        }
        case 'switch': {
          const valueType = analyzeExpression(node.value); requireInteger(valueType, node.value.location);
          const context: SwitchContext = { type: promote(valueType), cases: new Set(), hasDefault: false };
          pushScope(); pendingStatements.push({ leaveScope: true });
          pendingStatements.push({ node: node.body, loops, switches: [...switches, context] });
          break;
        }
        case 'case': {
          const context = switches[switches.length - 1];
          if (!context) failure('INVALID_CASE', 'case y default necesitan un switch envolvente.', node.location);
          if (node.value) {
            requireInteger(analyzeExpression(node.value), node.value.location);
            const constant = convert(constantExpression(node.value, aggregates), context.type, node.location);
            const key = String(constant.value);
            if (context.cases.has(key)) failure('DUPLICATE_CASE', 'El switch contiene dos case con el mismo valor.', node.location);
            context.cases.add(key); node.constant = constant;
          } else {
            if (context.hasDefault) failure('DUPLICATE_DEFAULT', 'El switch contiene más de un default.', node.location);
            context.hasDefault = true;
          }
          pendingStatements.push({ node: node.statement, loops, switches });
          break;
        }
        case 'label':
          if (labels.has(node.name)) failure('DUPLICATE_LABEL', `La etiqueta «${node.name}» ya existe en esta función.`, node.location);
          labels.set(node.name, node.location); pendingStatements.push({ node: node.statement, loops, switches });
          break;
        case 'goto': gotos.push(node); break;
        case 'break': if (!loops && !switches.length) failure('INVALID_BREAK', 'break necesita un bucle o switch envolvente.', node.location); break;
        case 'continue': if (!loops) failure('INVALID_CONTINUE', 'continue necesita un bucle envolvente.', node.location); break;
        case 'empty': break;
      }
    }
    for (const node of gotos) if (!labels.has(node.target)) failure('UNKNOWN_LABEL', `La etiqueta «${node.target}» no existe en esta función.`, node.location);
  }
  return mainDefinition;
}

function comesBefore(left: Location, right: Location): boolean {
  return left.file !== right.file || left.line < right.line || left.line === right.line && left.column <= right.column;
}
function requirePointerArithmetic(type: Extract<CType, { kind: 'pointer' }>, aggregates: readonly AggregateDefinition[], at: Location): void {
  if (type.base === 'void' || isFunction(type.base) || !isObject(type.base) || !isComplete(type.base, aggregates)) {
    failure('INCOMPLETE_TYPE', 'La aritmética de punteros requiere un tipo completo de objeto distinto de void.', at);
  }
  sizeOfType(type.base, aggregates, at);
}
