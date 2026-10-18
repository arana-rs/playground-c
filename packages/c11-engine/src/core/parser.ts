import type { PrepareLimits } from './types.ts';
import { enforceLimit, failure } from './internal.ts';
import {
  INT_MAX, INT_MIN,
} from './internal.ts';
import type {
  AggregateDefinition, AggregateMember, ArrayCType, Binding, CType, CValue, EnumDefinition, Expression, FunctionIR, GlobalObject,
  GenericAssociation, Initializer, InitializerDesignator, Location, Parameter, ParsedProgram, ScalarCType, Statement, Token, TypeQualifiers, StaticAssertion,
} from './internal.ts';
import { BUILTINS, binary, commonType, convert, encodeUtf8Bytes, parseLiteral, promote, truth, unary } from './numeric.ts';
import {
  aggregateRef, aggregateType, arrayOf, arrayType, canConvertPointerType, compatibleType, containsFlexibleAggregate, decayType, enumRef, functionOf,
  functionType, isAggregate, isArray, isArithmetic, isComplete, isFunction, isInteger, isModifiableObject, isObject, isPointer,
  isScalar, layoutAggregate, pointerTo, pointerType, pointedToType, qualifyType, qualifiersOf, sameType, sizeOfType, typeName,
  hasVariableLengthBound, hasVariableLengthObjectSize, variableLengthArrayTypes,
  conditionalPointerCompositeType,
  unqualifiedType, alignOfType,
} from './type-system.ts';
import { C_KEYWORDS } from '../syntax.ts';
import { LIBRARY_FUNCTIONS } from './headers.ts';
import { MATH_CLASSIFICATION_BUILTINS, MATH_CLASSIFICATION_FUNCTIONS, MATH_COMPARISON_BUILTINS } from './math-metadata.ts';

const reserved = new Set(C_KEYWORDS);
const scalarWords = new Set(['char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'void', '_Bool']);
const declarationWords = new Set([...scalarWords, 'struct', 'union', 'enum', 'static', 'extern', 'typedef', 'auto', 'register', 'inline', '_Noreturn', 'const', 'volatile', 'restrict', '_Thread_local', '_Alignas']);
const declarationOnlySpecifiers = new Set(['static', 'extern', 'typedef', 'auto', 'register', 'inline', '_Noreturn', '_Thread_local', '_Alignas']);
const unsupportedWords = new Set(['_Atomic', '_Complex', '_Imaginary']);
const operators: Record<string, number> = {
  ',': 1, '=': 2, '+=': 2, '-=': 2, '*=': 2, '/=': 2, '%=': 2, '&=': 2, '|=': 2, '^=': 2, '<<=': 2, '>>=': 2,
  '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '<<': 11, '>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13,
};
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const floatingClassifications = new Set<string>([...MATH_CLASSIFICATION_FUNCTIONS, ...MATH_CLASSIFICATION_BUILTINS]);
const floatingComparisons = new Set<string>(MATH_COMPARISON_BUILTINS);
const vaIntrinsics = new Set(['__builtin_va_start', '__builtin_va_copy', '__builtin_va_end']);
type Block = Extract<Statement, { kind: 'block' }>;
type Declarator = {
  name: string; location: Location; apply: (base: CType) => CType; parameters?: Parameter[];
  prototype?: boolean; variadic?: boolean; oldStyle?: boolean; pointerQualifiers?: TypeQualifiers[];
  parameterArrayQualifiers?: TypeQualifiers; minimumArrayBound?: number; prototypeVariableLengthBound?: boolean; parameterScope?: ParserScopeFrame;
};
type TagScope = Map<string, AggregateDefinition>;
type Scope = { names: Map<string, Binding>; owner?: Block | Extract<Statement, { kind: 'for' }> };
type TypedefBinding = { type: CType; isConst?: boolean };
type ParserScopeFrame = {
  tags: TagScope;
  enumTags: Map<string, EnumDefinition>;
  ordinary: Map<string, bigint | null>;
  ordinaryTypes: Map<string, CType>;
  typedefs: Map<string, TypedefBinding>;
};
type ParameterScopeContext = { retainFirst: boolean; frame?: ParserScopeFrame };
type DeclarationSpecifiers = {
  static: boolean;
  extern: boolean;
  typedef: boolean;
  threadLocal: boolean;
  auto: boolean;
  register: boolean;
  inline: boolean;
  noreturn: boolean;
  alignments: number[];
  storageClasses: Set<string>;
};
type DeclarationSpecifierConsumer = (token: Token) => void;

let nextAggregateIdForParser = 0;
let nextEnumIdForParser = 0;

const isNullPointerConstant = (node: Expression, aggregates: readonly AggregateDefinition[] = []): boolean => {
  if (node.kind === 'cast' && isPointer(node.targetType) && pointedToType(node.targetType) === 'void') {
    return isNullPointerConstant(node.operand, aggregates);
  }
  try {
    if (!isIntegerConstantExpression(node, aggregates)) return false;
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
    case 'generic': return [node.control, ...node.associations.map((association) => association.expression)];
    case 'compoundLiteral': return [];
    case 'vaArg': return [node.ap];
    case 'call': return [...(node.callee ? [node.callee] : []), ...node.args];
  }
}

type GenericSelectionResolver = (node: Extract<Expression, { kind: 'generic' }>) => Expression | undefined;

function selectGenericAssociation(
  controlType: CType,
  associations: readonly GenericAssociation[],
  aggregates: readonly AggregateDefinition[],
  at: Location,
): Expression {
  const normalizedControlType = isArray(controlType) || isFunction(controlType)
    ? decayType(controlType)
    : unqualifiedType(controlType);
  let selected: Expression | undefined;
  let defaultExpression: Expression | undefined;
  const seenAssociationTypes: CType[] = [];
  for (const association of associations) {
    if (!association.type) {
      if (defaultExpression) failure('TYPE_ERROR', '_Generic cannot repeat the default association.', association.location);
      defaultExpression = association.expression;
      continue;
    }
    const associationType = association.type;
    if (!isComplete(associationType, aggregates) || isFunction(associationType) || unqualifiedType(associationType) === 'void') {
      failure('TYPE_ERROR', 'A _Generic association must name a complete object type.', association.location);
    }
    if (seenAssociationTypes.some((prior) => compatibleType(prior, associationType))) {
      failure('TYPE_ERROR', '_Generic associations cannot have compatible types.', association.location);
    }
    seenAssociationTypes.push(associationType);
    if (compatibleType(normalizedControlType, associationType)) selected = association.expression;
  }
  selected ??= defaultExpression;
  if (!selected) failure('NO_GENERIC_ASSOCIATION', 'No _Generic association matches the controlling type.', at);
  return selected;
}

function isIntegerConstantExpression(
  root: Expression,
  aggregates: readonly AggregateDefinition[],
  resolveGeneric?: GenericSelectionResolver,
): boolean {
  const pending: { node: Expression; evaluated: boolean }[] = [{ node: root, evaluated: true }];
  while (pending.length) {
    const { node, evaluated } = pending.pop()!;
    switch (node.kind) {
      case 'literal':
        if (!isInteger(node.value.type)) return false;
        break;
      case 'sizeof':
        // A VLA's runtime size is not an integer constant expression.
        if (!node.valueType && !node.operand?.type) return false;
        if (hasVariableLengthObjectSize(node.valueType ?? node.operand!.type!)) return false;
        break;
      case 'generic': {
        const selected = resolveGeneric?.(node) ?? node.selected;
        if (!selected) return false;
        pending.push({ node: selected, evaluated });
        break;
      }
      case 'cast':
        if (!isInteger(node.targetType)) return false;
        if (node.operand.kind === 'literal' && isArithmetic(node.operand.value.type) && !isInteger(node.operand.value.type)) break;
        pending.push({ node: node.operand, evaluated });
        break;
      case 'unary':
        if (!['+', '-', '~', '!'].includes(node.operator)) return false;
        pending.push({ node: node.operand, evaluated });
        break;
      case 'binary': {
        if (node.operator === ',' && evaluated) return false;
        if (!['||', '&&', '|', '^', '&', '==', '!=', '<', '>', '<=', '>=', '<<', '>>', '+', '-', '*', '/', '%'].includes(node.operator)) return false;
        pending.push({ node: node.left, evaluated });
        if (evaluated && (node.operator === '&&' || node.operator === '||')) {
          try {
            const left = constantExpression(node.left, aggregates, resolveGeneric);
            const shortCircuits = node.operator === '&&' ? !truth(left) : truth(left);
            pending.push({ node: node.right, evaluated: !shortCircuits });
          } catch { return false; }
        } else pending.push({ node: node.right, evaluated });
        break;
      }
      case 'conditional': {
        pending.push({ node: node.condition, evaluated });
        if (!evaluated) {
          pending.push({ node: node.then, evaluated: false }, { node: node.else, evaluated: false });
        } else try {
          const condition = constantExpression(node.condition, aggregates, resolveGeneric);
          pending.push({ node: node.then, evaluated: truth(condition) });
          pending.push({ node: node.else, evaluated: !truth(condition) });
        } catch { return false; }
        break;
      }
      case 'assignment':
        if (evaluated) return false;
        pending.push({ node: node.target, evaluated: false }, { node: node.value, evaluated: false });
        break;
      case 'update':
        if (evaluated) return false;
        pending.push({ node: node.operand, evaluated: false });
        break;
      case 'call':
        if (evaluated) return false;
        if (node.callee) pending.push({ node: node.callee, evaluated: false });
        for (const argument of node.args) pending.push({ node: argument, evaluated: false });
        break;
      case 'variable': case 'function': case 'string': case 'index': case 'member': case 'decay': case 'compoundLiteral': case 'vaArg':
        return false;
    }
  }
  return true;
}

function requireIntegerConstantExpression(
  expression: Expression,
  context: string,
  aggregates: readonly AggregateDefinition[],
  resolveGeneric?: GenericSelectionResolver,
): void {
  if (!isIntegerConstantExpression(expression, aggregates, resolveGeneric)) {
    failure('TYPE_ERROR', `${context} must be an integer constant expression.`, expression.location);
  }
}

export function parse(tokens: Token[], limits: PrepareLimits, translationUnit = tokens[0]?.file ?? 'main.c'): ParsedProgram {
  let cursor = 0;
  const peek = (offset = 0) => tokens[Math.min(cursor + offset, tokens.length - 1)];
  const consume = () => tokens[cursor++];
  const unsupported = (token: Token, message?: string): never => failure('UNSUPPORTED_FEATURE', message ?? `P3 does not yet implement «${token.text}» in this context.`, token);
  const expect = (text: string) => {
    const token = peek();
    if (token.text !== text) {
      if (unsupportedWords.has(token.text)) unsupported(token);
      failure('SYNTAX_ERROR', `Expected «${text}»; found ${token.kind === 'eof' ? 'end of file' : `«${token.text}»`}.`, token);
    }
    return consume();
  };
  const identifier = (): Token => {
    const token = peek();
    if (reserved.has(token.text)) failure('SYNTAX_ERROR', `«${token.text}» is a reserved word and cannot be a name.`, token);
    if (token.kind !== 'identifier') failure('SYNTAX_ERROR', 'Expected an identifier.', token);
    return consume();
  };
  const typedefScopes: Map<string, TypedefBinding>[] = [new Map()];
  const aggregates: AggregateDefinition[] = [];
  const enums: EnumDefinition[] = [];
  const staticAssertions: StaticAssertion[] = [];
  let parseStaticAssert: () => StaticAssertion;
  const tagScopes: TagScope[] = [new Map()];
  const enumTagScopes: Map<string, EnumDefinition>[] = [new Map()];
  const ordinaryScopes: Map<string, bigint | null>[] = [new Map()];
  const ordinaryTypeScopes: Map<string, CType>[] = [new Map()];
  let lastSpecifierDefinesTag = false;
  const pushTags = (): ParserScopeFrame => {
    const frame: ParserScopeFrame = {
      tags: new Map(), enumTags: new Map(), ordinary: new Map(), ordinaryTypes: new Map(), typedefs: new Map(),
    };
    tagScopes.push(frame.tags); enumTagScopes.push(frame.enumTags); ordinaryScopes.push(frame.ordinary);
    ordinaryTypeScopes.push(frame.ordinaryTypes); typedefScopes.push(frame.typedefs);
    return frame;
  };
  const popTags = (): ParserScopeFrame | undefined => {
    if (tagScopes.length <= 1) return undefined;
    const frame: ParserScopeFrame = {
      tags: tagScopes.pop()!, enumTags: enumTagScopes.pop()!, ordinary: ordinaryScopes.pop()!,
      ordinaryTypes: ordinaryTypeScopes.pop()!, typedefs: typedefScopes.pop()!,
    };
    return frame;
  };
  const restoreTags = (frame: ParserScopeFrame): void => {
    tagScopes.push(frame.tags); enumTagScopes.push(frame.enumTags); ordinaryScopes.push(frame.ordinary);
    ordinaryTypeScopes.push(frame.ordinaryTypes); typedefScopes.push(frame.typedefs);
  };
  const lookupTypedef = (name: string): TypedefBinding | undefined => {
    for (let index = typedefScopes.length - 1; index >= 0; index--) {
      if (ordinaryScopes[index]?.has(name)) return undefined;
      const found = typedefScopes[index].get(name);
      if (found) return found;
    }
    return undefined;
  };
  const startsType = (token = peek()) => scalarWords.has(token.text) || token.text === 'struct' || token.text === 'union' || token.text === 'enum' || ['const', 'volatile', 'restrict'].includes(token.text) ||
    !!lookupTypedef(token.text);
  let lastSpecifierConst = false;
  let lastSpecifierVolatile = false;
  let lastSpecifierRestrict = false;
  let lastSpecifierQualifiers: TypeQualifiers = {};
  const lookupEnumTag = (tag: string): { index: number; definition: EnumDefinition; location: Location } | undefined => {
    for (let index = enumTagScopes.length - 1; index >= 0; index--) {
      const definition = enumTagScopes[index].get(tag); if (definition) return { index, definition, location: definition.location };
    }
    return undefined;
  };
  const nearestTagKind = (tag: string): { kind: 'aggregate' | 'enum'; index: number; aggregate?: AggregateDefinition; enumeration?: EnumDefinition; location: Location } | undefined => {
    const aggregateIndex = tagScopes.map(scope => scope.has(tag)).lastIndexOf(true);
    const enumTag = lookupEnumTag(tag);
    if (enumTag && enumTag.index > aggregateIndex) return { kind: 'enum', index: enumTag.index, enumeration: enumTag.definition, location: enumTag.location };
    const aggregate = lookupTag(tag);
    if (aggregate) return { kind: 'aggregate', index: aggregateIndex, aggregate, location: aggregate.location };
    if (enumTag) return { kind: 'enum', index: enumTag.index, enumeration: enumTag.definition, location: enumTag.location };
    return undefined;
  };
  const lookupEnumerator = (name: string): bigint | undefined => {
    for (let index = ordinaryScopes.length - 1; index >= 0; index--) {
      if (ordinaryScopes[index].has(name)) return ordinaryScopes[index].get(name) ?? undefined;
    }
    return undefined;
  };
  const declareOrdinary = (name: string, location: Location, type?: CType): void => {
    const scope = ordinaryScopes[ordinaryScopes.length - 1];
    if (typedefScopes.at(-1)?.has(name)) failure('REDECLARATION', `Identifier «${name}» is already a typedef name in this scope.`, location);
    if (typeof scope.get(name) === 'bigint') failure('REDECLARATION', `Enumerator «${name}» is already declared in this scope.`, location);
    scope.set(name, null);
    if (type) ordinaryTypeScopes.at(-1)!.set(name, type);
  };
  const setOrdinaryType = (name: string, type: CType): void => { ordinaryTypeScopes.at(-1)!.set(name, type); };
  const lookupOrdinaryType = (name: string): CType | undefined => {
    for (let index = ordinaryScopes.length - 1; index >= 0; index--) {
      if (ordinaryScopes[index].has(name)) return ordinaryTypeScopes[index].get(name);
    }
    return undefined;
  };
  const declareTypedef = (name: string, type: CType, isConst: boolean, location: Location): void => {
    if (ordinaryScopes.at(-1)?.has(name)) {
      failure('REDECLARATION', `Identifier «${name}» is already declared in this scope.`, location);
    }
    const prior = typedefScopes.at(-1)?.get(name);
    if (prior) {
      if (sameType(prior.type, type)) return;
      failure('CONFLICTING_TYPES', `Redeclaration of typedef «${name}» has an incompatible type.`, location);
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
  let nextEnumId = nextEnumIdForParser;

  const parseAggregateSpecifier = (): CType => {
    const kindToken = consume();
    const kind = kindToken.text as 'struct' | 'union';
    let tag: string | null = null;
    if (peek().kind === 'identifier' && !reserved.has(peek().text)) tag = consume().text;
    if (peek().text !== '{') {
      if (!tag) failure('SYNTAX_ERROR', `Expected a tag or a ${kind} definition.`, peek());
      const nearest = nearestTagKind(tag);
      if (nearest?.kind === 'enum') failure('CONFLICTING_TYPES', `Tag «${tag}» already declares an enum.`, kindToken);
      let definition = nearest?.aggregate;
      if (!definition) {
        definition = { id: nextAggregateId++, kind, tag, complete: false, members: [], location: kindToken };
        aggregates.push(definition); tagScopes[tagScopes.length - 1].set(tag, definition);
      } else if (definition.kind !== kind) failure('CONFLICTING_TYPES', `Tag «${tag}» already declares a different aggregate type.`, kindToken);
      return aggregateRef(definition.id);
    }

    const existing = tag === null ? undefined : currentTag(tag);
    if (tag !== null && enumTagScopes[enumTagScopes.length - 1].has(tag)) failure('CONFLICTING_TYPES', `Tag «${tag}» already declares an enum in this scope.`, kindToken);
    if (existing?.complete) failure('REDEFINITION', `Type ${kind} ${tag} is already defined in this scope.`, kindToken);
    const definition: AggregateDefinition = existing ?? { id: nextAggregateId++, kind, tag, complete: false, members: [], location: kindToken };
    if (!existing) {
      aggregates.push(definition);
      if (tag !== null) tagScopes[tagScopes.length - 1].set(tag, definition);
    }
    consume();
    const members: AggregateMember[] = [];
    while (peek().text !== '}') {
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', `Missing closing } for ${kind}.`, peek());
      if (peek().text === ';') failure('SYNTAX_ERROR', 'An aggregate requires member declarations.', peek());
      if (peek().text === '_Static_assert') { staticAssertions.push(parseStaticAssert()); continue; }
      const alignmentSpecifiers: number[] = [];
      const memberBase = parseTypeSpecifier((token) => {
        if (token.text !== '_Alignas') {
          failure('SYNTAX_ERROR', `«${token.text}» is invalid in a member specifier list.`, token);
        }
        alignmentSpecifiers.push(parseAlignmentSpecifier());
      });
      const memberQualifiers = { ...lastSpecifierQualifiers };
      const memberConst = lastSpecifierConst;
      if (peek().text === ';') {
        const anonymousType = memberBase;
        if (!isAggregate(anonymousType)) failure('SYNTAX_ERROR', 'An anonymous member requires a complete struct or union specifier.', peek());
        const anonymousDefinition = aggregates.find(value => value.id === aggregateType(anonymousType)?.id);
        if (!anonymousDefinition?.complete || anonymousDefinition.tag !== null) failure('TYPE_ERROR', 'An anonymous member requires a complete anonymous struct or union.', peek());
        if (alignmentSpecifiers.length) failure('TYPE_ERROR', '_Alignas is not allowed on anonymous members.', peek());
        const location = consume();
        const anonymousMemberType = qualifyType(anonymousType, memberQualifiers);
        members.push({ name: '', type: anonymousMemberType, index: members.length, offset: 0, location, isConst: memberConst });
        continue;
      }
      if (memberBase === 'void' || isFunction(memberBase)) failure('TYPE_ERROR', 'An aggregate member must have an object type.', peek());
      do {
        const declarator = parseDeclarator(true);
        const memberType = declaredType(declarator, memberBase, memberQualifiers);
        if (isFunction(memberType)) failure('TYPE_ERROR', 'An aggregate member cannot be a function.', declarator.location);
        if (hasVariableLengthBound(memberType)) failure('TYPE_ERROR', 'An aggregate member cannot have a variably modified type.', declarator.location);
        let bitWidth: number | undefined;
        let unnamedBitField = false;
        if (peek().text === ':') {
          if (alignmentSpecifiers.length) failure('TYPE_ERROR', '_Alignas cannot be applied to a bit-field.', declarator.location);
          const colon = consume();
          const width = parseIntegerConstant('The bit-field width');
          if (width < 0n || width > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_ERROR', 'A bit-field width must be a representable nonnegative integer.', colon);
          bitWidth = Number(width);
          if (!isInteger(memberType)) failure('TYPE_ERROR', 'A bit-field must have an integer or enum type.', declarator.location);
          unnamedBitField = declarator.name === '';
          if (bitWidth === 0 && !unnamedBitField) failure('TYPE_ERROR', 'A zero-width bit-field must be unnamed.', declarator.location);
        } else if (!declarator.name) {
          failure('SYNTAX_ERROR', 'An unnamed member declarator requires a bit-field width.', peek());
        }
        if (declarator.name && members.some(member => member.name === declarator.name)) failure('REDECLARATION', `Member «${declarator.name}» appears more than once.`, declarator.location);
        const memberAlignment = alignmentSpecifiers.filter((value) => value !== 0);
        const requestedAlignment = memberAlignment.length ? Math.max(...memberAlignment) : undefined;
        if (alignmentSpecifiers.some((value) => value > 0 && value < alignOfType(memberType, aggregates, declarator.location))) {
          failure('TYPE_ERROR', '_Alignas cannot reduce a member’s natural alignment.', declarator.location);
        }
        const field: AggregateMember = {
          name: declarator.name, type: memberType, index: members.length, offset: 0, location: declarator.location,
          isConst: isConstObjectType(memberType, declarator, memberQualifiers),
          qualifiers: qualifiersOf(memberType),
          ...(alignmentSpecifiers.length ? { requestedAlignment: requestedAlignment ?? 0 } : {}),
          ...(bitWidth !== undefined ? { bitField: { width: bitWidth, storageUnitOffset: 0, storageUnitSize: 0, bitOffset: 0, signed: false } } : {}),
          ...(unnamedBitField ? { unnamedBitField: true } : {}),
          ...(arrayType(memberType)?.length === null && !arrayType(memberType)?.lengthExpression ? { flexibleArray: true } : {}),
        };
        members.push(field);
        if (peek().text !== ',') break;
        consume();
      } while (true);
      expect(';');
    }
    expect('}');
    definition.members = members;
    definition.complete = true;
    if (!members.length) failure('TYPE_ERROR', 'A struct or union must declare at least one member.', kindToken);
    layoutAggregate(definition, aggregates, kindToken);
    lastSpecifierDefinesTag = true;
    return aggregateRef(definition.id);
  };

  const parseEnumSpecifier = (): CType => {
    const enumToken = consume();
    const tag = peek().kind === 'identifier' && !reserved.has(peek().text) ? consume().text : null;
    if (peek().text !== '{') {
      if (!tag) failure('SYNTAX_ERROR', 'Expected a tag or an enum definition.', peek());
      const nearest = nearestTagKind(tag);
      if (!nearest) failure('INCOMPLETE_TYPE', `Enum «${tag}» is not defined.`, enumToken);
      if (nearest.kind !== 'enum') failure('CONFLICTING_TYPES', `Tag «${tag}» already declares an aggregate type.`, enumToken);
      if (!nearest.enumeration!.complete) failure('INCOMPLETE_TYPE', `Enum «${tag}» is still incomplete.`, enumToken);
      return enumRef(nearest.enumeration!);
    }
    if (tag !== null && tagScopes[tagScopes.length - 1].has(tag)) failure('CONFLICTING_TYPES', `Tag «${tag}» already declares an aggregate in this scope.`, enumToken);
    if (tag !== null && enumTagScopes[enumTagScopes.length - 1].has(tag)) failure('REDEFINITION', `Enum «${tag}» is already defined in this scope.`, enumToken);
    const definition: EnumDefinition = {
      id: nextEnumId++, tag, complete: false, integerType: 'int', enumerators: [], translationUnit, location: enumToken,
    };
    enums.push(definition);
    if (tag !== null) enumTagScopes[enumTagScopes.length - 1].set(tag, definition);
    consume();
    let nextValue = 0n;
    let count = 0;
    while (peek().text !== '}') {
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', 'Missing closing } for enum.', peek());
      const enumerator = identifier();
      let value = nextValue;
      if (peek().text === '=') {
        consume();
        const expression = parseExpression(2, new Set([',', '}']));
        requireIntegerConstantExpression(expression, 'The enumerator value', aggregates, resolveGenericSelection);
        const constant = constantExpression(expression, aggregates, resolveGenericSelection);
        if (!isInteger(constant.type) || typeof constant.value !== 'bigint') failure('TYPE_ERROR', 'An enumerator value must be an integer constant expression.', enumerator);
        value = constant.value;
      }
      if (value < INT_MIN || value > INT_MAX) failure('TYPE_SIZE_RANGE', 'An enumerator value must fit in int.', enumerator);
      declareEnumerator(enumerator.text, value, enumerator);
      definition.enumerators.push({ name: enumerator.text, value, location: enumerator });
      nextValue = value + 1n;
      count++;
      if (peek().text !== ',') break;
      consume();
      if (peek().text === '}') break;
    }
    if (!count) failure('SYNTAX_ERROR', 'An enum requires at least one enumerator.', enumToken);
    expect('}');
    definition.complete = true;
    lastSpecifierDefinesTag = true;
    return enumRef(definition);
  };
  const declareEnumerator = (name: string, value: bigint, location: Location): void => {
    const scope = ordinaryScopes[ordinaryScopes.length - 1];
    if (typedefScopes.at(-1)?.has(name)) failure('REDECLARATION', `Enumerator «${name}» is already a typedef name in this scope.`, location);
    if (scope.has(name)) failure('REDECLARATION', `Identifier «${name}» is already declared in this scope.`, location);
    scope.set(name, value);
  };

  const newDeclarationSpecifiers = (): DeclarationSpecifiers => ({
    static: false, extern: false, typedef: false, threadLocal: false, auto: false, register: false,
    inline: false, noreturn: false, alignments: [], storageClasses: new Set(),
  });
  const consumeDeclarationSpecifier = (state: DeclarationSpecifiers, token: Token): void => {
    if (token.text === '_Alignas') {
      state.alignments.push(parseAlignmentSpecifier());
      return;
    }
    if (token.text === '_Thread_local') {
      if (state.storageClasses.has(token.text)) failure('TYPE_ERROR', 'A storage-class specifier cannot be repeated.', token);
      state.storageClasses.add(token.text);
      consume();
      state.threadLocal = true;
      return;
    }
    if (['static', 'extern', 'typedef', 'auto', 'register'].includes(token.text)) {
      if (state.storageClasses.has(token.text)) failure('TYPE_ERROR', 'A storage-class specifier cannot be repeated.', token);
      state.storageClasses.add(token.text);
      consume();
      if (token.text === 'static') state.static = true;
      else if (token.text === 'extern') state.extern = true;
      else if (token.text === 'typedef') state.typedef = true;
      else if (token.text === 'auto') state.auto = true;
      else state.register = true;
      return;
    }
    if (token.text === 'inline') { consume(); state.inline = true; return; }
    if (token.text === '_Noreturn') { consume(); state.noreturn = true; return; }
    failure('ENGINE_INTERNAL_ERROR', `Specifier «${token.text}» cannot be collected here.`, token);
  };

  function parseTypeSpecifier(consumeDeclarationSpecifier?: DeclarationSpecifierConsumer): CType {
    lastSpecifierDefinesTag = false;
    lastSpecifierConst = false;
    lastSpecifierVolatile = false;
    lastSpecifierRestrict = false;
    lastSpecifierQualifiers = {};
    const at = peek();
    const collectDeclarationSpecifier = (): boolean => {
      const token = peek();
      if (!consumeDeclarationSpecifier || !declarationOnlySpecifiers.has(token.text)) return false;
      consumeDeclarationSpecifier(token);
      return true;
    };
    const consumeQualifier = (): boolean => {
      const qualifier = peek();
      if (!['const', 'volatile', 'restrict'].includes(qualifier.text)) return false;
      consume();
      const next = { ...lastSpecifierQualifiers, [qualifier.text]: true } as TypeQualifiers;
      lastSpecifierQualifiers = next;
      lastSpecifierConst = !!next.const;
      lastSpecifierVolatile = !!next.volatile;
      lastSpecifierRestrict = !!next.restrict;
      return true;
    };
    while (collectDeclarationSpecifier() || consumeQualifier()) { /* declaration specifiers may appear in any order */ }
    if (peek().text === 'struct' || peek().text === 'union') {
      const qualifiers = { ...lastSpecifierQualifiers };
      const type = parseAggregateSpecifier();
      lastSpecifierQualifiers = qualifiers;
      lastSpecifierConst = !!qualifiers.const; lastSpecifierVolatile = !!qualifiers.volatile; lastSpecifierRestrict = !!qualifiers.restrict;
      while (collectDeclarationSpecifier() || consumeQualifier()) { /* qualifiers and declaration specifiers may follow an aggregate specifier */ }
      return type;
    }
    if (peek().text === 'enum') {
      const qualifiers = { ...lastSpecifierQualifiers };
      const type = parseEnumSpecifier();
      lastSpecifierQualifiers = qualifiers;
      lastSpecifierConst = !!qualifiers.const; lastSpecifierVolatile = !!qualifiers.volatile; lastSpecifierRestrict = !!qualifiers.restrict;
      while (collectDeclarationSpecifier() || consumeQualifier()) { /* qualifiers and declaration specifiers may follow an enum specifier */ }
      return type;
    }
    if (unsupportedWords.has(peek().text)) unsupported(peek());
    if (peek().kind === 'identifier') {
      const alias = lookupTypedef(peek().text);
      if (alias) {
        lastSpecifierConst = lastSpecifierConst || !!alias.isConst || !!qualifiersOf(alias.type).const;
        lastSpecifierVolatile = lastSpecifierVolatile || !!qualifiersOf(alias.type).volatile;
        lastSpecifierRestrict = lastSpecifierRestrict || !!qualifiersOf(alias.type).restrict;
        consume();
        while (collectDeclarationSpecifier() || consumeQualifier()) { /* qualifiers and declaration specifiers may follow a typedef name */ }
        return alias.type;
      }
    }
    const words: string[] = [];
    while (true) {
      if (collectDeclarationSpecifier() || consumeQualifier()) continue;
      if (scalarWords.has(peek().text)) { words.push(consume().text); continue; }
      break;
    }
    if (!words.length) failure('SYNTAX_ERROR', 'Expected a type specifier.', at);
    const count = (word: string) => words.filter(value => value === word).length;
    for (const word of scalarWords) if (count(word) > (word === 'long' ? 2 : 1)) failure('TYPE_ERROR', 'Incompatible or repeated type specifiers.', at);
    const signed = count('signed'), unsigned = count('unsigned');
    if (signed && unsigned) failure('TYPE_ERROR', 'A type cannot be both signed and unsigned.', at);
    for (const special of ['void', '_Bool', 'float']) {
      if (count(special)) {
    if (words.length !== 1) failure('TYPE_ERROR', 'Incompatible type specifiers.', at);
        return special as ScalarCType;
      }
    }
    if (count('double')) {
      if (count('long') === 1 && words.length === 2) return 'long double';
    if (words.length !== 1) failure('TYPE_ERROR', 'Incompatible type specifiers.', at);
      return 'double';
    }
    if (count('char')) {
    if (count('int') || count('short') || count('long')) failure('TYPE_ERROR', 'Incompatible type specifiers.', at);
      return unsigned ? 'unsigned char' : signed ? 'signed char' : 'char';
    }
    if (count('short') && count('long')) failure('TYPE_ERROR', 'A type cannot be both short and long.', at);
    if (count('short')) return unsigned ? 'unsigned short' : 'short';
    if (count('long') === 2) return unsigned ? 'unsigned long long' : 'long long';
    if (count('long')) return unsigned ? 'unsigned long' : 'long';
    return unsigned ? 'unsigned int' : 'int';
  }

  const parseArrayBound = (): { length: number | null; expression?: Expression } => {
    if (peek().text === ']') {
      consume();
      return { length: null };
    }
    const at = peek();
    const expression = parseExpression(1, new Set([']']));
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
            const parameterSpecifiers = newDeclarationSpecifiers();
            const parameterBase = parseTypeSpecifier((token) => {
              if (token.text !== 'register') failure('TYPE_ERROR', 'register is the only storage class allowed for a parameter.', token);
              consumeDeclarationSpecifier(parameterSpecifiers, token);
            });
            const registerParameter = parameterSpecifiers.register;
            const parameterQualifiers = { ...lastSpecifierQualifiers };
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

  const decodeString = (text: string, at: Location): number[] => {
    const utf8 = text.startsWith('u8"');
    const prefixLength = utf8 ? 2 : 0;
    if ((!utf8 && !text.startsWith('"')) || !text.endsWith('"')) failure('UNTERMINATED_STRING', 'Unterminated string literal.', at);
    const result: number[] = [];
    const body = text.slice(prefixLength + 1, -1);
    for (let index = 0; index < body.length; index++) {
      let code = 0;
      const char = body[index];
      if (char !== '\\') {
        const codePoint = body.codePointAt(index)!;
        if (utf8 && codePoint >= 0xd800 && codePoint <= 0xdfff) {
          failure('INVALID_STRING_LITERAL', 'A UTF-8 string literal contains an invalid Unicode code point.', at);
        }
        if (utf8 && codePoint > 127) {
          result.push(...encodeUtf8Bytes(codePoint));
          if (codePoint > 0xffff) index++;
          continue;
        }
        if (codePoint > 127) unsupported({ ...at, text: char, kind: 'string' }, 'P3 supports ASCII string literals; Unicode support is pending.');
        code = codePoint;
      } else {
        const next = body[++index];
        if (next === undefined) failure('SYNTAX_ERROR', 'Incomplete escape in string literal.', at);
        const simple: Record<string, number> = { "'": 39, '"': 34, '?': 63, '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
        if (Object.hasOwn(simple, next)) code = simple[next];
        else if (/[0-7]/.test(next)) {
          let digits = next;
          while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) digits += body[++index];
          code = Number.parseInt(digits, 8);
        } else if (next === 'x') {
          let digits = '';
          while (/[0-9a-fA-F]/.test(body[index + 1] ?? '')) digits += body[++index];
          if (!digits) failure('SYNTAX_ERROR', 'A hexadecimal string escape requires at least one digit.', at);
          code = Number.parseInt(digits, 16);
        } else if (next === 'u' || next === 'U') unsupported({ ...at, text: `\\${next}`, kind: 'string' }, 'P3 does not implement Unicode escapes.');
    else failure('SYNTAX_ERROR', `Unknown string escape: \\${next}.`, at);
      }
      result.push(code);
    }
    return result;
  };

  const parseIntegerConstant = (context: string): bigint => {
    const at = peek();
    const expression = parseExpression(1, new Set([']', ',', ';', '}']));
    requireIntegerConstantExpression(expression, context, aggregates, resolveGenericSelection);
    const value = constantExpression(expression, aggregates, resolveGenericSelection);
    if (!isInteger(value.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', `${context} must be an integer constant expression.`, at);
    return value.value;
  };

  let parseExpression: (minPrecedence?: number, stops?: ReadonlySet<string>) => Expression;
  let resolveGenericSelection: GenericSelectionResolver | undefined;
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
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', 'Missing closing } for initializer.', peek());
      const itemAt = peek();
      const designators: InitializerDesignator[] = [];
      while (peek().text === '.' || peek().text === '[') {
        if (peek().text === '.') {
          const designator = consume(); const name = identifier();
          designators.push({ kind: 'member', name: name.text, location: designator });
        } else {
          const designator = consume();
          const index = parseIntegerConstant('The array designator');
          if (index < 0n) failure('INVALID_DESIGNATOR', 'A designator index cannot be negative.', designator);
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
    if (!list.length) failure('SYNTAX_ERROR', 'A braced initializer requires at least one element in C11.', at);
    expect('}');
    return { kind: 'list', items: list, location: at };
  };

  const typeName = (): CType => {
    const base = parseTypeSpecifier();
    const qualifiers = { ...lastSpecifierQualifiers };
    const declarator = parseDeclarator(true);
    return declaredType(declarator, base, qualifiers);
  };

  function parseAlignmentSpecifier(): number {
    const at = expect('_Alignas');
    expect('(');
    let alignment: bigint;
    if (startsType()) {
      const type = typeName();
      if (!isComplete(type, aggregates) || isFunction(type)) failure('INCOMPLETE_TYPE', '_Alignas requires a complete object type.', at);
      alignment = BigInt(alignOfType(type, aggregates, at));
    } else {
      const expression = parseExpression(1, new Set([')']));
      requireIntegerConstantExpression(expression, '_Alignas', aggregates, resolveGenericSelection);
      const value = constantExpression(expression, aggregates, resolveGenericSelection);
      if (!isInteger(value.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', '_Alignas requires an integer constant expression or a type name.', at);
      alignment = value.value;
    }
    expect(')');
    if (alignment < 0n || alignment > 65536n || alignment !== 0n && (alignment & (alignment - 1n)) !== 0n) {
      failure('TYPE_ERROR', 'The profile supports _Alignas(0) or power-of-two alignments from 1 to 65536.', at);
    }
    return Number(alignment);
  }

  parseStaticAssert = (): StaticAssertion => {
    const at = expect('_Static_assert');
    expect('(');
    const condition = parseExpression(1, new Set([',']));
    requireIntegerConstantExpression(condition, '_Static_assert', aggregates, resolveGenericSelection);
    expect(',');
    if (peek().kind !== 'string') failure('SYNTAX_ERROR', '_Static_assert requires a string literal message.', peek());
    const first = consume();
    const bytes = decodeString(first.text, first);
    while (peek().kind === 'string') bytes.push(...decodeString(consume().text, first));
    expect(')');
    expect(';');
    return { condition, message: String.fromCharCode(...bytes), location: at };
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
        failure('SYNTAX_ERROR', 'Incomplete expression.', operator?.token ?? peek());
      }
      const right = values.pop();
      if (!right) failure('SYNTAX_ERROR', 'Missing right operand.', operator.token);
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
      if (!left) failure('SYNTAX_ERROR', 'Missing left operand.', operator.token);
      if (operator.kind === 'conditional') {
        const condition = values.pop();
        if (!condition) failure('SYNTAX_ERROR', 'Missing condition in ?: expression.', operator.token);
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
      if (open === undefined) failure('SYNTAX_ERROR', `«${token.text}» has no matching opening delimiter.`, token);
      while (stack.length > open + 1) reduce();
      const marker = stack.pop()! as Marker;
      if (marker.kind !== kind) failure('SYNTAX_ERROR', `Expected closing «${marker.kind === 'group' || marker.kind === 'call' ? '(' : '['}».`, token);
      markers.pop(); questionCounts.pop(); consume();
      if (marker.kind === 'group') {
        if (values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Invalid expression inside parentheses.', token);
        expectingOperand = false;
        return;
      }
      if (marker.kind === 'call') {
        if (expectingOperand) {
          if (values.length !== marker.valueStart || marker.args.length || stack.length !== open) failure('SYNTAX_ERROR', 'Missing function-call argument.', token);
        } else {
          if (values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Invalid argument.', token);
          const argument = values.pop()!;
          marker.args.push(argument.expression); marker.maxDepth = Math.max(marker.maxDepth, argument.depth);
        }
        const depth = Math.max(marker.baseDepth, marker.maxDepth) + 1;
        pushValue({ kind: 'call', callee: marker.callee, args: marker.args, location: marker.token }, depth);
        expectingOperand = false;
        return;
      }
      if (expectingOperand || values.length !== marker.valueStart + 1) failure('SYNTAX_ERROR', 'Subscript requires an expression.', token);
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
        if (token.text === '_Alignof') {
          consume();
          expect('(');
          if (!startsType()) failure('SYNTAX_ERROR', '_Alignof requires a parenthesized type name in C11.', peek());
          const type = typeName();
          expect(')');
          if (!isComplete(type, aggregates) || isFunction(type)) failure('INCOMPLETE_TYPE', '_Alignof requires a complete object type.', token);
          const alignment = alignOfType(type, aggregates, token);
          pushValue({ kind: 'literal', value: { type: 'unsigned long', value: BigInt(alignment) }, location: token }, 1);
          expectingOperand = false;
          continue;
        }
        if (token.text === '_Generic') {
          consume();
          expect('(');
          const control = parseExpression(2, new Set([',']));
          expect(',');
          const associations: import('./internal.ts').GenericAssociation[] = [];
          let defaultSeen = false;
          while (true) {
            const associationAt = peek();
            let associationType: CType | undefined;
            if (peek().text === 'default') {
              consume();
              if (defaultSeen) failure('TYPE_ERROR', '_Generic cannot repeat the default association.', associationAt);
              defaultSeen = true;
            } else {
              if (!startsType()) failure('SYNTAX_ERROR', 'Expected a type or default in a _Generic association.', peek());
              associationType = typeName();
              if (arrayType(associationType) && arrayType(associationType)!.length === null) failure('TYPE_ERROR', 'A _Generic association cannot use an incomplete array type.', associationAt);
            }
            expect(':');
            const expression = parseExpression(2, new Set([',', ')']));
            associations.push({ ...(associationType ? { type: associationType } : {}), expression, location: associationAt });
            if (peek().text !== ',') break;
            consume();
            if (peek().text === ')') failure('SYNTAX_ERROR', 'Missing association after the comma in _Generic.', peek());
          }
          expect(')');
          if (!associations.length) failure('SYNTAX_ERROR', '_Generic requires at least one association.', token);
          const genericNode: Extract<Expression, { kind: 'generic' }> = {
            kind: 'generic', control, associations, selected: associations[0].expression, location: token,
          };
          genericNode.selected = resolveGenericSelection?.(genericNode) ?? genericNode.selected;
          const depth = associations.length + 1;
          pushValue(genericNode, depth);
          expectingOperand = false;
          continue;
        }
        if (token.text === '__builtin_offsetof') {
          consume();
          expect('(');
          const objectType = typeName();
          expect(',');
          let offset = 0;
          let currentType = objectType;
          const firstMember = identifier();
          const addMember = (name: string, at: Location): void => {
            const path = aggregateMemberPath(currentType, name, aggregates, at);
            for (const member of path) {
              if (member.bitField) failure('TYPE_ERROR', 'offsetof cannot designate a bit-field.', at);
              offset += member.offset;
              currentType = member.type;
            }
          };
          addMember(firstMember.text, firstMember);
          while (peek().text === '.' || peek().text === '[') {
            if (peek().text === '.') {
              const dot = consume();
              addMember(identifier().text, dot);
            } else {
              const bracket = consume();
              const indexExpression = parseExpression(1, new Set([']']));
              const indexValue = constantExpression(indexExpression, aggregates);
              if (!isInteger(indexValue.type) || typeof indexValue.value !== 'bigint' || indexValue.value < 0n || indexValue.value > BigInt(Number.MAX_SAFE_INTEGER)) {
                failure('TYPE_ERROR', 'An offsetof index must be a representable nonnegative integer constant.', bracket);
              }
              expect(']');
              const array = arrayType(currentType);
              if (!array) failure('TYPE_ERROR', 'An indexed offsetof designator requires an array member.', bracket);
              if (array.length !== null && indexValue.value >= BigInt(array.length)) failure('INVALID_DESIGNATOR', 'The offsetof index exceeds the array bounds.', bracket);
              offset += Number(indexValue.value) * sizeOfType(array.element, aggregates, bracket);
              currentType = array.element;
            }
          }
          expect(')');
          pushValue({ kind: 'literal', value: { type: 'unsigned long', value: BigInt(offset) }, location: token }, 1);
          expectingOperand = false;
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
            ? { kind: 'variable', name: token.text, location: token, ...(lookupOrdinaryType(token.text) ? { type: lookupOrdinaryType(token.text)! } : {}) }
            : { kind: 'literal', value: { type: 'int', value: enumerator }, location: token }, 1);
          expectingOperand = false; continue;
        }
        if (unsupportedWords.has(token.text)) unsupported(token);
        failure('SYNTAX_ERROR', 'Expected a C expression.', token);
      }

      if (token.text === ')' || token.text === ']') {
        if (open < 0) {
          if (stops.has(token.text)) break;
          failure('SYNTAX_ERROR', `«${token.text}» has no matching opening delimiter.`, token);
        }
        const marker = stack[open];
        const wanted: Marker['kind'] = token.text === ']' ? 'index' : marker.kind === 'call' ? 'call' : 'group';
        closeMarker(wanted, token); continue;
      }
      if (token.text === '[' || token.text === '(') {
        const base = values.pop();
        if (!base) failure('SYNTAX_ERROR', `Operator «${token.text}» has no base expression.`, token);
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
          failure('SYNTAX_ERROR', '«:» has no matching «?».', token);
        }
        stack.pop(); questionCounts[questionCounts.length - 1]--;
        stack.push({ kind: 'conditional', token: question.token, operator: '?:' }); consume(); expectingOperand = true; continue;
      }
      if (token.text === ',' && open >= 0 && stack[open].kind === 'call' && !pendingQuestion) {
        while (stack.length > open + 1) reduce();
        const call = stack[open] as Extract<Marker, { kind: 'call' }>;
        if (values.length !== call.valueStart + 1) failure('SYNTAX_ERROR', 'Invalid argument.', token);
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
      failure('SYNTAX_ERROR', `Missing operator before «${token.text}».`, token);
    }
    if (expectingOperand) failure('SYNTAX_ERROR', 'Missing expression or operand.', peek());
    if (markers.length) failure('SYNTAX_ERROR', 'Missing closing parenthesis or subscript bracket.', peek());
    while (stack.length) reduce();
    if (values.length !== 1) failure('SYNTAX_ERROR', 'Invalid expression.', peek());
    return values[0].expression;
  };

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
          case 'variable': case 'function': type = node.type ?? lookupOrdinaryType(node.name); break;
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

  resolveGenericSelection = (node) => {
    const controlType = inferExpressionType(node.control);
    if (!controlType) return undefined;
    const selected = selectGenericAssociation(controlType, node.associations, aggregates, node.location);
    node.selected = selected;
    return selected;
  };

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
    const baseQualifiers = { ...lastSpecifierQualifiers };
    const standaloneTag = lastSpecifierDefinesTag;
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
        fileLinkage.set(declarator.name, linkage);
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
        const priorDuration = expressionDuration;
        if (isStatic || isThreadLocal) expressionDuration = 'static';
        try { initializer = parseInitializer(); } finally { expressionDuration = priorDuration; }
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
        fileLinkage.set(declarator.name, linkage);
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

  const parseBody = (depth = 1, parameterNames: readonly { name: string; location: Location; type: CType }[] = []): Block => {
    enforceLimit('maxDepth', depth, limits.maxDepth, peek());
    const open = expect('{');
    const block: Block = { kind: 'block', statements: [], location: open, endLocation: open };
    pushTags();
    for (const parameter of parameterNames) if (parameter.name) declareOrdinary(parameter.name, parameter.location, parameter.type);
    const pending: { block: Block; depth: number }[] = [{ block, depth }];
    while (pending.length) {
      const current = pending[pending.length - 1];
      if (peek().text === '}') {
        current.block.endLocation = consume(); popTags(); pending.pop(); continue;
      }
      if (peek().kind === 'eof') failure('SYNTAX_ERROR', 'Missing closing } for block.', peek());
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
    if (token.text === '_Static_assert') {
      const assertion = parseStaticAssert();
      return { kind: 'staticAssert', ...assertion };
    }
    if (isDeclarationStart(token)) {
      if (!allowDeclaration) failure('SYNTAX_ERROR', 'A declaration must be inside a block or in a for initializer.', token);
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
    return parseDeclaration(depth, true);
  }

  const functions: FunctionIR[] = [];
  const globals: GlobalObject[] = [];
  const fileLinkage = new Map<string, 'internal' | 'external'>();
  while (peek().kind !== 'eof') {
    const at = peek();
    if (peek().text === '_Static_assert') { staticAssertions.push(parseStaticAssert()); continue; }
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
    const baseQualifiers = { ...lastSpecifierQualifiers };
    const standaloneTag = lastSpecifierDefinesTag;
    if ((isAggregate(base) || standaloneTag) && peek().text === ';') {
      if (isStatic || isExtern || isTypedef || isAuto || isRegister || isInline || isNoreturn || isThreadLocal || alignments.length) failure('TYPE_ERROR', 'Storage/alignment specifiers require a declarator.', at);
      consume(); continue;
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
        fileLinkage.set(declarator.name, linkage);
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
          if (!first || peek(1).text === ';') failure('SYNTAX_ERROR', 'A function definition must be a separate external declaration.', peek());
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
              const parameterQualifiers = { ...lastSpecifierQualifiers };
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
          const priorDuration: 'automatic' | 'static' = expressionDuration; expressionDuration = 'static';
          try { initializer = parseInitializer(); } finally { expressionDuration = priorDuration; }
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
        fileLinkage.set(declarator.name, linkage);
        const symbolKey = linkage === 'internal' ? `internal:${translationUnit}:${declarator.name}` : `external:${declarator.name}`;
        const prior = globals.find(global => global.symbolKey === symbolKey);
        if (prior) {
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
  if (cursor === 0) failure('SYNTAX_ERROR', 'The file contains no external declarations.', peek());
  for (const global of globals) {
    const array = arrayType(global.type);
    if (global.tentative && array?.length === null && isComplete(array.element, aggregates)) global.type = arrayOf(array.element, 1);
  }
  nextAggregateIdForParser = nextAggregateId;
  nextEnumIdForParser = nextEnumId;
  return { functions, aggregates, enums, globals, staticAssertions, translationUnit };
}

const requireInteger = (type: CType, location: Location) => {
  if (!isInteger(type)) failure('TYPE_ERROR', 'This operator requires integer operands.', location);
};
const requireArithmetic = (type: CType, location: Location) => {
  if (!isArithmetic(type)) failure('TYPE_ERROR', 'This operator requires an arithmetic type.', location);
};
const requireScalar = (type: CType, location: Location) => {
  if (!isScalar(type)) failure('TYPE_ERROR', 'This operator requires a scalar operand.', location);
};

function aggregateMemberPath(type: CType, name: string, aggregates: readonly AggregateDefinition[], at: Location): AggregateMember[] {
  const rootType = aggregateType(type);
  if (!rootType) failure('TYPE_ERROR', 'Member access requires a struct or union.', at);
  const root = aggregates.find(item => item.id === rootType.id);
  if (!root || !root.complete) failure('INCOMPLETE_TYPE', 'Cannot access members of an incomplete aggregate.', at);
  const matches: AggregateMember[][] = [];
  const pending: { definition: AggregateDefinition; path: AggregateMember[] }[] = [{ definition: root, path: [] }];
  while (pending.length) {
    const current = pending.pop()!;
    for (let index = current.definition.members.length - 1; index >= 0; index--) {
      const member = current.definition.members[index];
      const path = [...current.path, member];
      if (member.name === name) matches.push(path);
      else if (member.name === '') {
        const nestedType = aggregateType(member.type);
        const nested = nestedType && aggregates.find(item => item.id === nestedType.id);
        if (nested?.complete) pending.push({ definition: nested, path });
      }
    }
  }
  if (!matches.length) failure('UNKNOWN_MEMBER', `The aggregate has no member «${name}».`, at);
  if (matches.length > 1) failure('AMBIGUOUS_MEMBER', `Member «${name}» is promoted by more than one anonymous member.`, at);
  return matches[0];
}

function constantExpression(
  root: Expression,
  aggregates: readonly AggregateDefinition[],
  resolveGeneric?: GenericSelectionResolver,
): CValue {
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
        const selected = node.kind === 'generic' ? resolveGeneric?.(node) ?? node.selected : undefined;
        const children = node.kind === 'sizeof' ? [] : node.kind === 'generic' ? selected ? [selected] : [] : expressionChildren(node);
        for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], done: false });
        continue;
      }
      switch (node.kind) {
        case 'literal': types.set(node, node.value.type); break;
        case 'sizeof': types.set(node, 'unsigned long'); break;
        case 'generic': {
          const selected = resolveGeneric?.(node) ?? node.selected;
          if (!selected || !types.get(selected)) failure('NON_CONSTANT_CASE', 'Cannot determine the selected _Generic association.', node.location);
          types.set(node, types.get(selected)!);
          break;
        }
        case 'cast': types.set(node, node.targetType); break;
        case 'unary': types.set(node, node.operator === '!' ? 'int' : promote(types.get(node.operand)!)); break;
        case 'binary':
          types.set(node, node.operator === ',' ? types.get(node.right)!
            : ['&&', '||', '==', '!=', '<', '>', '<=', '>='].includes(node.operator)
              ? 'int' : node.operator === '<<' || node.operator === '>>' ? promote(types.get(node.left)!) : commonType(types.get(node.left)!, types.get(node.right)!));
          break;
        case 'conditional': types.set(node, commonType(types.get(node.then)!, types.get(node.else)!)); break;
        default: failure('NON_CONSTANT_CASE', 'case requires an integer constant expression.', node.location);
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
        if (!type) failure('NON_CONSTANT_CASE', 'sizeof requires a known type in a constant expression.', node.location);
        values.set(node, { type: 'unsigned long', value: BigInt(sizeOfType(type, aggregates, node.location)) }); continue;
      }
      if (node.kind === 'generic') {
        const selected = resolveGeneric?.(node) ?? node.selected;
        if (!selected) failure('NON_CONSTANT_CASE', 'Cannot determine the selected _Generic association.', node.location);
        values.set(node, constantExpression(selected, aggregates, resolveGeneric)); continue;
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
      failure('NON_CONSTANT_CASE', 'case requires an integer constant expression.', node.location);
    }
    if (task.kind === 'unary') {
      const operand = values.get(task.node.operand)!;
      if (task.node.kind === 'cast') {
        if (!isInteger(task.node.targetType)) failure('NON_CONSTANT_CASE', 'A constant can only be converted to an integer type.', task.node.location);
        values.set(task.node, convert(operand, task.node.targetType, task.node.location));
      } else if (task.node.operator === '!') values.set(task.node, { type: 'int', value: truth(operand) ? 0n : 1n });
      else values.set(task.node, unaryConstant(task.node.operator, operand, task.node.location));
      continue;
    }
    if (task.kind === 'binary-left') {
      const left = values.get(task.node.left)!;
      if (task.node.operator === '&&' && !truth(left)) { values.set(task.node, { type: 'int', value: 0n }); continue; }
      if (task.node.operator === '||' && truth(left)) { values.set(task.node, { type: 'int', value: 1n }); continue; }
      if (task.node.operator === ',') failure('NON_CONSTANT_CASE', 'The comma operator is not part of an evaluated integer constant expression.', task.node.location);
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
  if (!isInteger(result.type)) failure('NON_CONSTANT_CASE', 'case requires an integer constant expression.', root.location);
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
      if (!compatibleType(prior.type, global.type)) failure('CONFLICTING_TYPES', `Incompatible declarations of «${global.name}».`, global.location);
      if (prior.initializer && global.initializer) failure('REDEFINITION', `Global object «${global.name}» is already initialized.`, global.location);
      if (!prior.initializer && global.initializer) prior.initializer = global.initializer;
      continue;
    }
    globalByName.set(global.name, global);
  }
  const functionIRType = (fn: FunctionIR): CType => functionOf(fn.returnType, fn.parameters.map(parameter => parameter.type), !!fn.variadic, fn.prototype !== false);
  for (let index = 0; index < functions.length; index++) {
    const fn = functions[index];
    if (globalByName.has(fn.name)) failure('CONFLICTING_TYPES', `«${fn.name}» is declared as both an object and a function.`, fn.location);
    const prior = signatures.get(fn.name);
    if (prior && !compatibleType(functionIRType(prior.fn), functionIRType(fn))) failure('CONFLICTING_TYPES', `Incompatible declarations of «${fn.name}».`, fn.location);
    if (fn.body && prior?.definition !== undefined) failure('REDEFINITION', `Function «${fn.name}» already has a definition.`, fn.location);
    const signature = prior ?? { fn };
    if (fn.body) signature.definition = index;
    const builtin = BUILTINS[fn.name] || LIBRARY_FUNCTIONS.includes(fn.name) || fn.name.startsWith('__builtin_va_')
      ? { returnType: fn.returnType, parameters: fn.parameters.map(parameter => parameter.type) }
      : undefined;
    if (!fn.body && builtin) {
      if (!LIBRARY_FUNCTIONS.includes(fn.name) && !fn.name.startsWith('__builtin_va_') &&
          (!sameType(fn.returnType, builtin.returnType) || fn.parameters.length !== builtin.parameters.length || !fn.parameters.every((parameter, parameterIndex) => sameType(parameter.type, builtin.parameters[parameterIndex])))) {
        failure('CONFLICTING_TYPES', `Prototype for «${fn.name}» does not match its library declaration.`, fn.location);
      }
      signature.builtin = index;
    }
    if (signature.fn.prototype === false && fn.prototype !== false) signature.fn = fn;
    signatures.set(fn.name, signature);
  }
  for (const signature of signatures.values()) if (signature.definition === undefined && signature.builtin !== undefined) functions[signature.builtin].builtin = true;
  const main = signatures.get('main');
  if (!options.allowMissingMain) {
    if (!main || main.definition === undefined) failure('MISSING_MAIN', 'A definition of main with external linkage is required.', functions[0]?.location ?? globals[0]?.location ?? { file: program.translationUnit ?? 'main.c', line: 1, column: 1 });
    const argv = main.fn.parameters[1]?.type;
    const argvPointer = argv ? pointerType(argv) : undefined;
    const argvElementPointer = argvPointer ? pointerType(argvPointer.base) : undefined;
    if (unqualifiedType(main.fn.returnType) !== 'int' || main.fn.parameters.length &&
        !(main.fn.parameters.length === 2 && unqualifiedType(main.fn.parameters[0].type) === 'int' && argvPointer &&
          argvElementPointer && unqualifiedType(argvElementPointer.base) === 'char')) {
      failure('UNSUPPORTED_FEATURE', 'P4 supports int main(void) or int main(int, char **).', main.fn.location);
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
      if (scope.names.has(name)) failure('REDECLARATION', `Variable «${name}» is already declared in this scope.`, location);
      const id = fn.bindings.length;
      const binding: Binding = {
        id, name, type, location, isConst: isConst || !!qualifiersOf(type).const,
        qualifiers: qualifiersOf(type),
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
        case 'generic': return isLvalue(node.selected);
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
          type: isArray(source) && node.isConst && isPointer(decay) ? pointerTo(pointedToType(decay)!, { baseConst: true }) : decay,
        };
        return converted;
      }
      return node;
    };
    const findMemberPath = (type: CType, name: string, at: Location): AggregateMember[] => {
      if (!isAggregate(type)) failure('TYPE_ERROR', 'Member access requires a struct or union.', at);
      const rootType = aggregateType(type)!;
      const root = aggregates.find(item => item.id === rootType.id);
      if (!root || !root.complete) failure('INCOMPLETE_TYPE', 'Cannot access members of an incomplete aggregate.', at);
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
            const nestedType = aggregateType(memberType);
            const nested = nestedType && aggregates.find(item => item.id === nestedType.id);
            if (nested?.complete) pending.push({ definition: nested, path });
          }
        }
      }
      if (!matches.length) failure('UNKNOWN_MEMBER', `The aggregate has no member «${name}».`, at);
      if (matches.length > 1) failure('AMBIGUOUS_MEMBER', `Member «${name}» is promoted by more than one anonymous member.`, at);
      return matches[0];
    };

    const analyzedValue = (node: Expression): Expression => {
      const source = node.type!;
      if (isArray(source) || isFunction(source)) {
        if (isArray(source) && node.register) {
          failure('INVALID_LVALUE', 'Cannot convert an array belonging to a register object to a pointer.', node.location);
        }
        return { kind: 'decay', operand: node, location: node.location, type: decayType(source) };
      }
      // C's lvalue conversion removes only the top-level qualifiers. Pointee
      // qualifiers remain nested in the pointer type.
      node.type = unqualifiedType(source);
      return node;
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
            if (local) {
              if (local.globalBinding !== undefined) node.globalBinding = local.globalBinding;
              else node.binding = local.id;
              node.type = local.type; node.isConst = !!local.isConst; node.register = !!local.register; break;
            }
            const global = globalVisible.get(node.name);
            if (global) { node.globalBinding = global.id; node.type = global.type; node.isConst = !!global.isConst; break; }
            const signature = visibleFunctions.get(node.name);
            if (signature) {
            const functionIndex = signature.definition ?? signature.builtin;
            if (functionIndex === undefined && !options.allowUnresolved) failure('UNDEFINED_FUNCTION', `Function «${node.name}» has no definition in this program.`, node.location);
              const replacement = node as unknown as Extract<Expression, { kind: 'function' }>;
            replacement.kind = 'function'; replacement.functionIndex = functionIndex; replacement.symbolKey = signature.fn.symbolKey; replacement.type = functionIRType(signature.fn); break;
            }
            failure('UNKNOWN_IDENTIFIER', `Variable «${node.name}» is not declared in this scope.`, node.location);
          }
          case 'function': {
            const signature = visibleFunctions.get(node.name);
            if (!signature) failure('UNKNOWN_FUNCTION', `Function «${node.name}» must be declared before use.`, node.location);
            const functionIndex = signature.definition ?? signature.builtin;
            if (functionIndex === undefined && !options.allowUnresolved) failure('UNDEFINED_FUNCTION', `Function «${node.name}» has no definition in this program.`, node.location);
            node.functionIndex = functionIndex; node.symbolKey = signature.fn.symbolKey; node.type = functionIRType(signature.fn); break;
          }
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
          case 'decay': {
            const source = node.operand.type!;
            if (!isArray(source) && !isFunction(source)) failure('TYPE_ERROR', 'Invalid array/function decay conversion.', node.location);
            node.type = decayType(source); break;
          }
          case 'compoundLiteral': {
            if (isFunction(node.objectType) || node.objectType === 'void' || !isComplete(node.objectType, aggregates)) failure('INCOMPLETE_TYPE', 'A compound literal requires a complete object type.', node.location);
            node.initializer = analyzeInitializer(node.objectType, node.initializer, false);
            node.type = node.objectType; break;
          }
          case 'vaArg': {
            node.ap = analyzedValue(node.ap);
            if (!isPointer(node.ap.type!) || unqualifiedType(pointedToType(node.ap.type!)!) !== 'void') failure('TYPE_ERROR', 'va_arg requires an active va_list.', node.location);
            if (!isScalar(node.valueType) && !isAggregate(node.valueType) || !isComplete(node.valueType, aggregates)) {
              failure('TYPE_ERROR', 'The va_arg type must be a complete object type.', node.location);
            }
            node.type = node.valueType;
            break;
          }
          case 'call': {
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
            node.type = signature.returnType; break;
          }
          case 'generic': {
            node.control = analyzedValue(node.control);
            const selected = selectGenericAssociation(node.control.type!, node.associations, aggregates, node.location);
            node.selected = selected;
            node.type = selected.type!;
            node.isConst = selected.isConst;
            node.register = selected.register;
            node.bitField = selected.bitField;
            break;
          }
        }
      }
      return root.type!;
    };
    const analyzedVlaBounds = new WeakSet<object>();
    const analyzeVariableLengthBounds = (bounds: readonly ArrayCType[], at: Location): void => {
      for (const array of bounds) {
        const expression = array.lengthExpression;
        if (!expression || analyzedVlaBounds.has(expression)) continue;
        const type = analyzeExpression(expression);
        requireInteger(type, expression.location ?? at);
        analyzedVlaBounds.add(expression);
      }
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
        if (node.kind === 'call') {
          if (node.builtin === true && node.args.length === 0 && (node.name === '__c11_inf' || node.name === '__c11_nan')) continue;
          return false;
        }
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
          const array = arrayType(current.type)!;
          if (array.length === null) failure('INCOMPLETE_TYPE', 'An incomplete array cannot be initialized by subobjects.', fn.location);
          if (current.next >= array.length) { pending.pop(); continue; }
          current.next++;
          pending.push({ type: array.element, next: 0, count: 0 });
          continue;
        }
        if (isAggregate(current.type)) {
          const aggregate = aggregateType(current.type)!;
          const definition = aggregates.find(value => value.id === aggregate.id)!;
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
      if (!isComplete(type, aggregates)) failure('INCOMPLETE_TYPE', 'Initializer requires a complete object.', initializer.location);
      if (initializer.kind === 'expression') {
        const original = initializer.value;
        const sourceType = analyzeExpression(original);
        const targetArray = arrayType(type);
        if (targetArray && unqualifiedType(targetArray.element) === 'char' && original.kind === 'string') {
          const textLength = original.bytes.length - 1;
          if (targetArray.length! < textLength) failure('INITIALIZER_TOO_LARGE', 'The string does not fit in the character array.', original.location);
        } else {
          initializer.value = convertedValue(original);
          if (!canAssign(type, initializer.value.type!, initializer.value)) failure('TYPE_ERROR', `Cannot initialize ${typeName(type, aggregates)} with ${typeName(sourceType, aggregates)}.`, original.location);
        }
        if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'An object with static storage duration requires a constant initializer.', initializer.location);
        return initializer;
      }

      const targetArray = arrayType(type);
      if (targetArray && unqualifiedType(targetArray.element) === 'char' && initializer.items.length === 1 && initializer.items[0].designators.length === 0) {
        const single = initializer.items[0].initializer;
        if (single.kind === 'expression' && single.value.kind === 'string') return analyzeInitializer(type, single, fileDuration);
      }
      if ((isArray(type) || isAggregate(type)) && initializer.items.length > 0 &&
          initializer.items.every(item => item.designators.length === 0 && item.initializer.kind === 'expression') &&
          initializer.items.every(item => !isAggregate(analyzeExpression((item.initializer as Extract<Initializer, { kind: 'expression' }>).value)))) {
        const slots = scalarInitializerTypes(type);
        for (const item of initializer.items) {
          const slot = slots.next();
          if (slot.done) failure('INITIALIZER_TOO_LARGE', 'The initializer has more values than scalar subobjects.', item.location);
          analyzeInitializer(slot.value, item.initializer, fileDuration);
        }
        if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'An object with static storage duration requires a constant initializer.', initializer.location);
        return initializer;
      }
      let nextIndex = 0;
      let count = 0;
      for (const item of initializer.items) {
        if (isArray(type)) {
          const array = arrayType(type)!;
          let selected = nextIndex;
          let childType: CType = array.element;
          if (item.designators.length) {
            const first = item.designators[0];
            if (first.kind !== 'index') failure('INVALID_DESIGNATOR', 'An array requires an index designator.', first.location);
            if (first.index > BigInt(Number.MAX_SAFE_INTEGER)) failure('INVALID_DESIGNATOR', 'The designated index exceeds the representable range.', first.location);
            selected = Number(first.index);
            if (array.length !== null && selected >= array.length) failure('INVALID_DESIGNATOR', 'The designated index exceeds the array bounds.', first.location);
            nextIndex = selected + 1;
            childType = followDesignators(type, item.designators);
          } else {
            if (array.length !== null && selected >= array.length) failure('INITIALIZER_TOO_LARGE', 'There are more elements than array slots.', item.location);
            nextIndex++; childType = followDesignators(childType, []);
          }
          analyzeInitializer(childType, item.initializer, fileDuration); count++; continue;
        }
        if (isAggregate(type)) {
          const aggregate = aggregateType(type)!;
          const definition = aggregates.find(value => value.id === aggregate.id)!;
          if (definition.kind === 'union' && count > 0) failure('INITIALIZER_TOO_LARGE', 'A union can only initialize one member.', item.location);
          let member: AggregateMember;
          if (item.designators.length) {
            const first = item.designators[0];
            if (first.kind !== 'member') failure('INVALID_DESIGNATOR', 'A struct or union requires a member designator.', first.location);
            const nestedType = followDesignators(type, item.designators);
            const selected = item.designators[0];
            if (selected.kind !== 'member') failure('ENGINE_INTERNAL_ERROR', 'The member path lost its initial designator.', item.location);
            member = definition.members[selected.memberIndex ?? definition.members.findIndex(value => value.name === selected.name)];
            if (!member) failure('UNKNOWN_MEMBER', `The aggregate has no member «${first.name}».`, first.location);
            nextIndex = member.index + 1;
            analyzeInitializer(nestedType, item.initializer, fileDuration); count++; continue;
          }
          if (nextIndex >= definition.members.length) failure('INITIALIZER_TOO_LARGE', 'There are more initializers than aggregate members.', item.location);
          member = definition.members[nextIndex++];
          analyzeInitializer(member.type, item.initializer, fileDuration); count++; continue;
        }
        if (item.designators.length) failure('INVALID_DESIGNATOR', 'A scalar cannot use designators.', item.designators[0].location);
        if (count > 0) failure('INITIALIZER_TOO_LARGE', 'A scalar can only have one initializer.', item.location);
        analyzeInitializer(type, item.initializer, fileDuration); count++;
      }
      if (fileDuration && !isStaticInitializer(initializer)) failure('NON_CONSTANT_INITIALIZER', 'An object with static storage duration requires a constant initializer.', initializer.location);
      return initializer;
    };
    const followDesignators = (initial: CType, designators: InitializerDesignator[]): CType => {
      let type = initial;
      const expanded: InitializerDesignator[] = [];
      for (const designator of designators) {
        if (designator.kind === 'member') {
          if (!isAggregate(type)) failure('INVALID_DESIGNATOR', 'A member designator requires a struct or union.', designator.location);
          const aggregate = aggregateType(type)!;
          const definition = aggregates.find(value => value.id === aggregate.id)!;
          let path: AggregateMember[];
          if (designator.memberIndex !== undefined) {
            const member = definition.members[designator.memberIndex];
            if (!member || member.name !== designator.name) failure('INVALID_DESIGNATOR', 'The designated member index does not match the aggregate.', designator.location);
            path = [member];
          } else path = findMemberPath(aggregate, designator.name, designator.location);
          for (const member of path) {
            expanded.push({ kind: 'member', name: member.name, memberIndex: member.index, location: designator.location });
            type = member.type;
          }
        } else {
          const array = arrayType(type);
          if (!array) failure('INVALID_DESIGNATOR', 'An index designator requires an array.', designator.location);
          if (designator.index > BigInt(Number.MAX_SAFE_INTEGER) || array.length !== null && designator.index >= BigInt(array.length)) failure('INVALID_DESIGNATOR', 'The designated index exceeds the array bounds.', designator.location);
          expanded.push(designator);
          type = array.element;
        }
      }
      designators.splice(0, designators.length, ...expanded);
      return type;
    };

    if (!globalsAnalyzed) {
      globalsAnalyzed = true;
      for (const assertion of program.staticAssertions ?? []) {
        requireInteger(analyzeExpression(assertion.condition), assertion.location);
        requireIntegerConstantExpression(assertion.condition, '_Static_assert', aggregates);
        const value = constantExpression(assertion.condition, aggregates);
        if (!truth(value)) failure('STATIC_ASSERT_FAILED', assertion.message || '_Static_assert expression is false.', assertion.location);
      }
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
      if (!parameter.name) failure('SYNTAX_ERROR', 'Parameters in a definition must have names.', parameter.location);
      parameter.binding = declare(parameter.name, parameter.type, parameter.location, true, parameter.isConst);
      fn.bindings[parameter.binding].register = !!parameter.register;
    }
    for (const parameter of fn.parameters) analyzeVariableLengthBounds(parameter.variableLengthBounds ?? [], parameter.location);
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
        case 'typeDeclaration':
          analyzeVariableLengthBounds(variableLengthArrayTypes(node.type), node.location);
          break;
        case 'declaration': {
          analyzeVariableLengthBounds(variableLengthArrayTypes(node.type), node.location);
          if (node.extern) {
            const globalIndex = globals.findIndex((global) => global.symbolKey === node.symbolKey);
            if (globalIndex < 0) failure('ENGINE_INTERNAL_ERROR', `No global extern symbol exists for «${node.name}».`, node.location);
            const global = globals[globalIndex];
            if (!compatibleType(global.type, node.type) || !!global.threadLocal !== !!node.threadLocal) {
            failure('CONFLICTING_TYPES', `Incompatible declarations of object «${node.name}».`, node.location);
            }
            if (scopes[scopes.length - 1].names.has(node.name)) failure('REDECLARATION', `Variable «${node.name}» is already declared in this scope.`, node.location);
            const binding: Binding = {
              id: -1, name: node.name, type: node.type, location: node.location,
              isConst: !!node.const, qualifiers: qualifiersOf(node.type), linkage: global.linkage ?? 'external', symbolKey: node.symbolKey,
              globalBinding: globalIndex, storageDuration: node.threadLocal ? 'thread-local' : 'static',
              threadLocal: !!node.threadLocal, alignment: node.alignment, requestedAlignment: node.requestedAlignment,
            };
            scopes[scopes.length - 1].names.set(node.name, binding);
          } else {
            node.binding = declare(node.name, node.type, node.location, false, !!node.const, !!node.static);
            const binding = fn.bindings[node.binding];
            binding.register = !!node.register;
            binding.alignment = node.alignment;
            binding.requestedAlignment = node.requestedAlignment;
            binding.threadLocal = !!node.threadLocal;
            if (node.threadLocal) binding.storageDuration = 'thread-local';
          }
          if (node.initializer) node.initializer = analyzeInitializer(node.type, node.initializer, !!node.static);
          break;
        }
        case 'staticAssert': {
          requireInteger(analyzeExpression(node.condition), node.location);
          requireIntegerConstantExpression(node.condition, '_Static_assert', aggregates);
          const value = constantExpression(node.condition, aggregates);
          if (!truth(value)) failure('STATIC_ASSERT_FAILED', node.message || '_Static_assert expression is false.', node.location);
          break;
        }
        case 'return': {
          if (fn.returnType === 'void') {
            if (node.value) failure('TYPE_ERROR', 'A void function cannot return an expression.', node.location);
          } else {
            if (!node.value) failure('SYNTAX_ERROR', 'A non-void function requires a return value.', node.location);
            node.value = convertedValue(node.value);
            if (!canAssign(fn.returnType, node.value.type!, node.value)) failure('TYPE_ERROR', `Cannot return ${typeName(node.value.type!, aggregates)} from a function returning ${typeName(fn.returnType, aggregates)}.`, node.location);
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
          if (!context) failure('INVALID_CASE', 'case and default require an enclosing switch.', node.location);
          if (node.value) {
            requireInteger(analyzeExpression(node.value), node.value.location);
            requireIntegerConstantExpression(node.value, 'case', aggregates);
            const constant = convert(constantExpression(node.value, aggregates), context.type, node.location);
            const key = String(constant.value);
            if (context.cases.has(key)) failure('DUPLICATE_CASE', 'The switch contains two case labels with the same value.', node.location);
            context.cases.add(key); node.constant = constant;
          } else {
            if (context.hasDefault) failure('DUPLICATE_DEFAULT', 'The switch contains more than one default.', node.location);
            context.hasDefault = true;
          }
          pendingStatements.push({ node: node.statement, loops, switches });
          break;
        }
        case 'label':
          if (labels.has(node.name)) failure('DUPLICATE_LABEL', `Label «${node.name}» already exists in this function.`, node.location);
          labels.set(node.name, node.location); pendingStatements.push({ node: node.statement, loops, switches });
          break;
        case 'goto': gotos.push(node); break;
        case 'break': if (!loops && !switches.length) failure('INVALID_BREAK', 'break requires an enclosing loop or switch.', node.location); break;
        case 'continue': if (!loops) failure('INVALID_CONTINUE', 'continue requires an enclosing loop.', node.location); break;
        case 'empty': break;
      }
    }
    for (const node of gotos) if (!labels.has(node.target)) failure('UNKNOWN_LABEL', `Label «${node.target}» does not exist in this function.`, node.location);
  }
  return mainDefinition;
}

function comesBefore(left: Location, right: Location): boolean {
  return left.file !== right.file || left.line < right.line || left.line === right.line && left.column <= right.column;
}
function requirePointerArithmetic(type: CType, aggregates: readonly AggregateDefinition[], at: Location): void {
  const base = pointedToType(type);
  if (!base || unqualifiedType(base) === 'void' || isFunction(base) || !isObject(base) || !isComplete(base, aggregates)) {
    failure('INCOMPLETE_TYPE', 'Pointer arithmetic requires a complete object type other than void.', at);
  }
  if (!hasVariableLengthObjectSize(base)) sizeOfType(base, aggregates, at);
}
