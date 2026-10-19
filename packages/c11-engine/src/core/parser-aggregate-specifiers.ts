import type { CType, AggregateDefinition, AggregateMember, EnumDefinition, Location, Token } from './internal.ts';
import { INT_MAX, INT_MIN, failure } from './internal.ts';
import {
  aggregateRef, aggregateType, alignOfType, arrayType, enumRef, hasVariableLengthBound, isAggregate,
  isFunction, isInteger, layoutAggregate, qualifyType, qualifiersOf,
} from './type-system.ts';
import { constantExpression, requireIntegerConstantExpression } from './parser-constant-expressions.ts';
import type { ParserContext, TypeSpecifierGrammar } from './parser-context-types.ts';
import { C_KEYWORDS } from '../syntax.ts';

const reserved = new Set(C_KEYWORDS);

export function createAggregateSpecifierGrammar(context: ParserContext): Pick<TypeSpecifierGrammar, 'parseAggregateSpecifier' | 'parseEnumSpecifier'> {
  const { aggregates, enums, staticAssertions, translationUnit, recovery, parserCheckpoints, tagScopes, enumTagScopes, ordinaryScopes, typedefScopes } = context;
  const peek = (offset = 0): Token => context.peek(offset);
  const consume = (): Token => context.consume();
  const expect = (text: string): Token => context.expect(text);
  const identifier = (): Token => context.identifier();
  const relatedFragment = (opening: Location, boundary: Location, message: string) => context.relatedFragment(opening, boundary, message);
  const syntaxFailureWithRelated = (message: string, location: Location, related?: import('./types.ts').RelatedDiagnosticLocation): never => context.syntaxFailureWithRelated(message, location, related);
  const setParserMap = <K, V>(map: Map<K, V>, key: K, value: V): void => context.setParserMap(map, key, value);
  const nearestTagKind = (tag: string) => context.nearestTagKind(tag);
  const currentTag = (tag: string) => context.currentTag(tag);
  const parseIntegerConstant = (value: string) => context.initializers.parseIntegerConstant(value);
  const parseAlignmentSpecifier = () => context.initializers.parseAlignmentSpecifier();
  const parseStaticAssert = () => context.initializers.parseStaticAssert();

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
      definition = { id: context.nextAggregateId++, kind, tag, complete: false, members: [], location: kindToken };
      aggregates.push(definition); setParserMap(tagScopes[tagScopes.length - 1], tag, definition);
    } else if (definition.kind !== kind) failure('CONFLICTING_TYPES', `Tag «${tag}» already declares a different aggregate type.`, kindToken);
    return aggregateRef(definition.id);
  }

  const existing = tag === null ? undefined : currentTag(tag);
  if (tag !== null && enumTagScopes[enumTagScopes.length - 1].has(tag)) failure('CONFLICTING_TYPES', `Tag «${tag}» already declares an enum in this scope.`, kindToken);
  if (existing?.complete) failure('REDEFINITION', `Type ${kind} ${tag} is already defined in this scope.`, kindToken);
  const definition: AggregateDefinition = existing ?? { id: context.nextAggregateId++, kind, tag, complete: false, members: [], location: kindToken };
  if (!existing) {
    aggregates.push(definition);
    if (tag !== null) setParserMap(tagScopes[tagScopes.length - 1], tag, definition);
  }
  const openBrace = consume();
  const members: AggregateMember[] = [];
  while (peek().text !== '}') {
    if (peek().kind === 'eof') {
      const message = `Missing closing } for ${kind}.`;
      syntaxFailureWithRelated(message, peek(), relatedFragment(openBrace, peek(), `Unclosed ${kind} definition starts here.`));
    }
    if (peek().text === ';') failure('SYNTAX_ERROR', 'An aggregate requires member declarations.', peek());
    if (peek().text === '_Static_assert') { staticAssertions.push(parseStaticAssert()); continue; }
    const alignmentSpecifiers: number[] = [];
    const memberBase = context.typeSpecifiers.parseTypeSpecifier((token) => {
      if (token.text !== '_Alignas') {
        failure('SYNTAX_ERROR', `«${token.text}» is invalid in a member specifier list.`, token);
      }
      alignmentSpecifiers.push(parseAlignmentSpecifier());
    });
    const memberQualifiers = { ...context.lastSpecifierQualifiers };
    const memberConst = context.lastSpecifierConst;
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
      const declarator = context.declarators.parseDeclarator(true);
      const memberType = context.declarators.declaredType(declarator, memberBase, memberQualifiers);
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
        isConst: context.declarators.isConstObjectType(memberType, declarator, memberQualifiers),
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
  if (recovery) {
    for (const checkpoint of parserCheckpoints) {
      if (!checkpoint.aggregateSnapshots.has(definition)) {
        checkpoint.aggregateSnapshots.set(definition, {
          ...definition,
          members: definition.members.map((member) => ({
            ...member,
            ...(member.bitField ? { bitField: { ...member.bitField } } : {}),
          })),
        });
      }
    }
  }
  definition.members = members;
  definition.complete = true;
  if (!members.length) failure('TYPE_ERROR', 'A struct or union must declare at least one member.', kindToken);
  layoutAggregate(definition, aggregates, kindToken);
  context.lastSpecifierDefinesTag = true;
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
    id: context.nextEnumId++, tag, complete: false, integerType: 'int', enumerators: [], translationUnit, location: enumToken,
  };
  enums.push(definition);
  if (tag !== null) setParserMap(enumTagScopes[enumTagScopes.length - 1], tag, definition);
  const openBrace = consume();
  let nextValue = 0n;
  let count = 0;
  while (peek().text !== '}') {
    if (peek().kind === 'eof') {
      const message = 'Missing closing } for enum.';
      syntaxFailureWithRelated(message, peek(), relatedFragment(openBrace, peek(), 'Unclosed enum definition starts here.'));
    }
    const enumerator = identifier();
    let value = nextValue;
    if (peek().text === '=') {
      consume();
      const expression = context.expressions.parseExpression(2, new Set([',', '}']));
      requireIntegerConstantExpression(expression, 'The enumerator value', aggregates, context.expressions.resolveGenericSelection);
      const constant = constantExpression(expression, aggregates, context.expressions.resolveGenericSelection);
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
  context.lastSpecifierDefinesTag = true;
  return enumRef(definition);
};
const declareEnumerator = (name: string, value: bigint, location: Location): void => {
  const scope = ordinaryScopes[ordinaryScopes.length - 1];
  if (typedefScopes.at(-1)?.has(name)) failure('REDECLARATION', `Enumerator «${name}» is already a typedef name in this scope.`, location);
  if (scope.has(name)) failure('REDECLARATION', `Identifier «${name}» is already declared in this scope.`, location);
  setParserMap(scope, name, value);
};
  return { parseAggregateSpecifier, parseEnumSpecifier };
}
