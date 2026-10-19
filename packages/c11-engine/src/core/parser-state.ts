import type { PrepareLimits, RelatedDiagnosticLocation } from './types.ts';
import { EngineFailure, failure } from './internal.ts';
import type {
  AggregateDefinition, CType, EnumDefinition, FunctionIR, GlobalObject, Location, StaticAssertion, Token, TypeQualifiers,
} from './internal.ts';
import type {
  ParserCheckpoint, ParserRecoveryOptions, ParserScopeFrame, TagScope, TypedefBinding,
} from './parser-context-types.ts';
import { sameType } from './type-system.ts';
import { C_KEYWORDS } from '../syntax.ts';

const reserved = new Set(C_KEYWORDS);
const scalarWords = new Set(['char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'void', '_Bool']);
const declarationWords = new Set([...scalarWords, 'struct', 'union', 'enum', 'static', 'extern', 'typedef', 'auto', 'register', 'inline', '_Noreturn', 'const', 'volatile', 'restrict', '_Thread_local', '_Alignas']);
const unsupportedWords = new Set(['_Atomic', '_Complex', '_Imaginary']);

let nextAggregateIdForParser = 0;
let nextEnumIdForParser = 0;

export class ParserState {
  readonly parserCheckpoints: ParserCheckpoint[] = [];
  readonly aggregates: AggregateDefinition[] = [];
  readonly enums: EnumDefinition[] = [];
  readonly staticAssertions: StaticAssertion[] = [];
  readonly typedefScopes: Map<string, TypedefBinding>[] = [new Map()];
  readonly tagScopes: TagScope[] = [new Map()];
  readonly enumTagScopes: Map<string, EnumDefinition>[] = [new Map()];
  readonly ordinaryScopes: Map<string, bigint | null>[] = [new Map()];
  readonly ordinaryTypeScopes: Map<string, CType>[] = [new Map()];
  readonly functions: FunctionIR[] = [];
  readonly globals: GlobalObject[] = [];
  readonly fileLinkage = new Map<string, 'internal' | 'external'>();
  cursor = 0;
  nextAggregateId: number;
  nextEnumId: number;
  expressionDuration: 'automatic' | 'static' = 'automatic';
  lastSpecifierDefinesTag = false;
  lastSpecifierConst = false;
  lastSpecifierVolatile = false;
  lastSpecifierRestrict = false;
  lastSpecifierQualifiers: TypeQualifiers = {};

  constructor(
    readonly tokens: Token[],
    readonly limits: PrepareLimits,
    readonly translationUnit: string,
    readonly recovery?: ParserRecoveryOptions,
  ) {
    this.nextAggregateId = nextAggregateIdForParser;
    this.nextEnumId = nextEnumIdForParser;
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.cursor + offset, this.tokens.length - 1)];
  }

  consume(): Token {
    return this.tokens[this.cursor++];
  }

  unsupported(token: Token, message?: string): never {
    return failure('UNSUPPORTED_FEATURE', message ?? `P3 does not yet implement «${token.text}» in this context.`, token);
  }

  expect(text: string): Token {
    const token = this.peek();
    if (token.text !== text) {
      if (unsupportedWords.has(token.text)) this.unsupported(token);
      failure('SYNTAX_ERROR', `Expected «${text}»; found ${token.kind === 'eof' ? 'end of file' : `«${token.text}»`}.`, token);
    }
    return this.consume();
  }

  identifier(): Token {
    const token = this.peek();
    if (reserved.has(token.text)) failure('SYNTAX_ERROR', `«${token.text}» is a reserved word and cannot be a name.`, token);
    if (token.kind !== 'identifier') failure('SYNTAX_ERROR', 'Expected an identifier.', token);
    return this.consume();
  }

  relatedFragment(opening: Location, boundary: Location, message: string): RelatedDiagnosticLocation | undefined {
    const openingSpan = opening.sourceSpan;
    const boundarySpan = boundary.sourceSpan;
    if (!opening.endLine || !opening.endColumn || !openingSpan || !boundarySpan) return undefined;
    if (opening.file !== openingSpan.physicalFile || boundary.file !== boundarySpan.physicalFile ||
        openingSpan.logicalLineOffset !== 0 || boundarySpan.logicalLineOffset !== 0) return undefined;
    if (opening.file !== boundary.file || openingSpan.physicalFile !== boundarySpan.physicalFile ||
        openingSpan.logicalLineOffset !== boundarySpan.logicalLineOffset || boundarySpan.startOffset < openingSpan.startOffset) return undefined;
    return {
      message,
      file: opening.file,
      line: opening.line,
      column: opening.column,
      endLine: boundary.line,
      endColumn: boundary.column,
    };
  }

  syntaxFailureWithRelated(message: string, location: Location, related?: RelatedDiagnosticLocation): never {
    const error = new EngineFailure('SYNTAX_ERROR', message, location);
    if (related) error.diagnostic = { ...error.diagnostic, related: [related] };
    throw error;
  }

  setParserMap<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (this.recovery) {
      const recordMap = map as unknown as Map<unknown, unknown>;
      for (const checkpoint of this.parserCheckpoints) {
        checkpoint.mapMutations.push({ map: recordMap, key, existed: map.has(key), value: map.get(key) });
      }
    }
    map.set(key, value);
  }

  pushTags(): ParserScopeFrame {
    const frame: ParserScopeFrame = {
      tags: new Map(), enumTags: new Map(), ordinary: new Map(), ordinaryTypes: new Map(), typedefs: new Map(),
    };
    this.tagScopes.push(frame.tags);
    this.enumTagScopes.push(frame.enumTags);
    this.ordinaryScopes.push(frame.ordinary);
    this.ordinaryTypeScopes.push(frame.ordinaryTypes);
    this.typedefScopes.push(frame.typedefs);
    return frame;
  }

  popTags(): ParserScopeFrame | undefined {
    if (this.tagScopes.length <= 1) return undefined;
    return {
      tags: this.tagScopes.pop()!,
      enumTags: this.enumTagScopes.pop()!,
      ordinary: this.ordinaryScopes.pop()!,
      ordinaryTypes: this.ordinaryTypeScopes.pop()!,
      typedefs: this.typedefScopes.pop()!,
    };
  }

  restoreTags(frame: ParserScopeFrame): void {
    this.tagScopes.push(frame.tags);
    this.enumTagScopes.push(frame.enumTags);
    this.ordinaryScopes.push(frame.ordinary);
    this.ordinaryTypeScopes.push(frame.ordinaryTypes);
    this.typedefScopes.push(frame.typedefs);
  }

  lookupTypedef(name: string): TypedefBinding | undefined {
    for (let index = this.typedefScopes.length - 1; index >= 0; index--) {
      if (this.ordinaryScopes[index]?.has(name)) return undefined;
      const found = this.typedefScopes[index].get(name);
      if (found) return found;
    }
    return undefined;
  }

  startsType(token = this.peek()): boolean {
    return scalarWords.has(token.text) || token.text === 'struct' || token.text === 'union' || token.text === 'enum' ||
      ['const', 'volatile', 'restrict'].includes(token.text) || !!this.lookupTypedef(token.text);
  }

  lookupEnumTag(tag: string): { index: number; definition: EnumDefinition; location: Location } | undefined {
    for (let index = this.enumTagScopes.length - 1; index >= 0; index--) {
      const definition = this.enumTagScopes[index].get(tag);
      if (definition) return { index, definition, location: definition.location };
    }
    return undefined;
  }

  nearestTagKind(tag: string): { kind: 'aggregate' | 'enum'; index: number; aggregate?: AggregateDefinition; enumeration?: EnumDefinition; location: Location } | undefined {
    const aggregateIndex = this.tagScopes.map(scope => scope.has(tag)).lastIndexOf(true);
    const enumTag = this.lookupEnumTag(tag);
    if (enumTag && enumTag.index > aggregateIndex) return { kind: 'enum', index: enumTag.index, enumeration: enumTag.definition, location: enumTag.location };
    const aggregate = this.lookupTag(tag);
    if (aggregate) return { kind: 'aggregate', index: aggregateIndex, aggregate, location: aggregate.location };
    if (enumTag) return { kind: 'enum', index: enumTag.index, enumeration: enumTag.definition, location: enumTag.location };
    return undefined;
  }

  lookupEnumerator(name: string): bigint | undefined {
    for (let index = this.ordinaryScopes.length - 1; index >= 0; index--) {
      if (this.ordinaryScopes[index].has(name)) return this.ordinaryScopes[index].get(name) ?? undefined;
    }
    return undefined;
  }

  declareOrdinary(name: string, location: Location, type?: CType): void {
    const scope = this.ordinaryScopes[this.ordinaryScopes.length - 1];
    if (this.typedefScopes.at(-1)?.has(name)) failure('REDECLARATION', `Identifier «${name}» is already a typedef name in this scope.`, location);
    if (typeof scope.get(name) === 'bigint') failure('REDECLARATION', `Enumerator «${name}» is already declared in this scope.`, location);
    this.setParserMap(scope, name, null);
    if (type) this.setParserMap(this.ordinaryTypeScopes.at(-1)!, name, type);
  }

  setOrdinaryType(name: string, type: CType): void {
    this.setParserMap(this.ordinaryTypeScopes.at(-1)!, name, type);
  }

  lookupOrdinaryType(name: string): CType | undefined {
    for (let index = this.ordinaryScopes.length - 1; index >= 0; index--) {
      if (this.ordinaryScopes[index].has(name)) return this.ordinaryTypeScopes[index].get(name);
    }
    return undefined;
  }

  declareTypedef(name: string, type: CType, isConst: boolean, location: Location): void {
    if (this.ordinaryScopes.at(-1)?.has(name)) failure('REDECLARATION', `Identifier «${name}» is already declared in this scope.`, location);
    const prior = this.typedefScopes.at(-1)?.get(name);
    if (prior) {
      if (sameType(prior.type, type)) return;
      failure('CONFLICTING_TYPES', `Redeclaration of typedef «${name}» has an incompatible type.`, location);
    }
    this.setParserMap(this.typedefScopes.at(-1)!, name, { type, isConst });
  }

  isDeclarationStart(token = this.peek()): boolean {
    return declarationWords.has(token.text) || !!this.lookupTypedef(token.text);
  }

  lookupTag(tag: string): AggregateDefinition | undefined {
    for (let index = this.tagScopes.length - 1; index >= 0; index--) {
      const found = this.tagScopes[index].get(tag);
      if (found) return found;
    }
    return undefined;
  }

  currentTag(tag: string): AggregateDefinition | undefined {
    return this.tagScopes[this.tagScopes.length - 1].get(tag);
  }

  declareEnumerator(name: string, value: bigint, location: Location): void {
    const scope = this.ordinaryScopes[this.ordinaryScopes.length - 1];
    if (this.typedefScopes.at(-1)?.has(name)) failure('REDECLARATION', `Enumerator «${name}» is already a typedef name in this scope.`, location);
    if (scope.has(name)) failure('REDECLARATION', `Identifier «${name}» is already declared in this scope.`, location);
    this.setParserMap(scope, name, value);
  }

  captureGlobalState(value: GlobalObject): void {
    if (!this.recovery) return;
    for (const checkpoint of this.parserCheckpoints) {
      if (!checkpoint.globalSnapshots.has(value)) checkpoint.globalSnapshots.set(value, { ...value });
    }
  }

  commitParserIds(): void {
    nextAggregateIdForParser = this.nextAggregateId;
    nextEnumIdForParser = this.nextEnumId;
  }
}
