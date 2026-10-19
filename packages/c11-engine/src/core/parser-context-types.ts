import type { Diagnostic, PrepareLimits, RelatedDiagnosticLocation } from './types.ts';
import type {
  AggregateDefinition, AggregateMember, Binding, CType, EnumDefinition, Expression, FunctionIR, GlobalObject,
  Initializer, Location, Parameter, Statement, StaticAssertion, Token,
  TypeQualifiers, VariablyModifiedIdentifier,
} from './internal.ts';

export type Block = Extract<Statement, { kind: 'block' }>;
export type TagScope = Map<string, AggregateDefinition>;
export type TypedefBinding = { type: CType; isConst?: boolean };
export type ParameterScopeContext = { retainFirst: boolean; frame?: ParserScopeFrame };
export type ParserMapMutation = { map: Map<unknown, unknown>; key: unknown; existed: boolean; value: unknown };
export type AggregateCheckpointState = Omit<AggregateDefinition, 'members'> & { members: AggregateMember[] };
export type ParserCheckpoint = {
  typedefScopes: Map<string, TypedefBinding>[];
  tagScopes: TagScope[];
  enumTagScopes: Map<string, EnumDefinition>[];
  ordinaryScopes: Map<string, bigint | null>[];
  ordinaryTypeScopes: Map<string, CType>[];
  mapMutations: ParserMapMutation[];
  aggregateSnapshots: Map<AggregateDefinition, AggregateCheckpointState>;
  globalSnapshots: Map<GlobalObject, GlobalObject>;
  aggregatesLength: number;
  enumsLength: number;
  staticAssertionsLength: number;
  functionsLength: number;
  globalsLength: number;
  lastSpecifierDefinesTag: boolean;
  lastSpecifierConst: boolean;
  lastSpecifierVolatile: boolean;
  lastSpecifierRestrict: boolean;
  lastSpecifierQualifiers: TypeQualifiers;
  nextAggregateId: number;
  nextEnumId: number;
  expressionDuration: 'automatic' | 'static';
};
export interface ParserRecoveryActions {
  captureParserCheckpoint(): ParserCheckpoint;
  finishParserCheckpoint(checkpoint: ParserCheckpoint): void;
  restoreParserCheckpoint(checkpoint: ParserCheckpoint): void;
  recordRecovery(error: unknown, checkpoint: ParserCheckpoint, start: number, boundary: 'statement' | 'external'): boolean;
}
export type ParserScopeFrame = {
  tags: TagScope;
  enumTags: Map<string, EnumDefinition>;
  ordinary: Map<string, bigint | null>;
  ordinaryTypes: Map<string, CType>;
  typedefs: Map<string, TypedefBinding>;
};
export type Scope = {
  names: Map<string, Binding>;
  variablyModifiedIdentifiers: VariablyModifiedIdentifier[];
  owner?: Block | Extract<Statement, { kind: 'for' }>;
};
export type Declarator = {
  name: string;
  location: Location;
  apply: (base: CType) => CType;
  parameters?: Parameter[];
  prototype?: boolean;
  variadic?: boolean;
  oldStyle?: boolean;
  pointerQualifiers?: TypeQualifiers[];
  parameterArrayQualifiers?: TypeQualifiers;
  minimumArrayBound?: number;
  prototypeVariableLengthBound?: boolean;
  parameterScope?: ParserScopeFrame;
};
export type DeclarationSpecifiers = {
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
export type DeclarationSpecifierConsumer = (token: Token) => void;
export type GenericSelectionResolver = (node: Extract<Expression, { kind: 'generic' }>) => Expression | undefined;

export interface ParserRecoveryOptions {
  readonly diagnostics: Diagnostic[];
  readonly maxDiagnostics: number;
  readonly truncated: { value: boolean };
}

export interface TypeSpecifierGrammar {
  parseAggregateSpecifier(): CType;
  parseEnumSpecifier(): CType;
  parseTypeSpecifier(consumeDeclarationSpecifier?: DeclarationSpecifierConsumer): CType;
  newDeclarationSpecifiers(): DeclarationSpecifiers;
  consumeDeclarationSpecifier(state: DeclarationSpecifiers, token: Token): void;
}

export interface DeclaratorGrammar {
  parseDeclarator(abstractAllowed: boolean, parameterDeclarator?: boolean, parameterScopeContext?: ParameterScopeContext): Declarator;
  applyPointers(base: CType, qualifiers: TypeQualifiers[]): CType;
  validateDeclaratorTypeConstraints(type: CType, at: Location, visited?: Set<CType>): void;
  declaredType(declarator: Declarator, base: CType, specifiers?: TypeQualifiers | boolean): CType;
  isConstObjectType(type: CType, declarator?: Declarator, baseConst?: boolean | TypeQualifiers): boolean;
  validateRestrictType(type: CType, at: Location): void;
}

export interface InitializerGrammar {
  decodeString(text: string, at: Location): number[];
  parseIntegerConstant(context: string): bigint;
  parseInitializer(): Initializer;
  typeName(): CType;
  parseAlignmentSpecifier(): number;
  parseStaticAssert(): StaticAssertion;
}

export interface ExpressionGrammar {
  parseExpression(minPrecedence?: number, stops?: ReadonlySet<string>): Expression;
  inferExpressionType(root: Expression): CType | undefined;
  resolveGenericSelection?: GenericSelectionResolver;
}

export interface DeclarationGrammar {
  inferArrayType(type: CType, initializer: Initializer | undefined): CType;
  parseDeclaration(depth: number, local: boolean): Statement;
}

export interface StatementGrammar {
  parseBody(depth?: number, parameterNames?: readonly { name: string; location: Location; type: CType }[]): Block;
  parseStatement(depth: number, allowDeclaration: boolean): Statement;
  parseForDeclaration(depth: number): Statement;
}

export interface ParserContext {
  readonly tokens: Token[];
  readonly limits: PrepareLimits;
  readonly translationUnit: string;
  readonly recovery?: ParserRecoveryOptions;
  readonly parserCheckpoints: ParserCheckpoint[];
  readonly recoveryActions: ParserRecoveryActions;
  readonly aggregates: AggregateDefinition[];
  readonly enums: EnumDefinition[];
  readonly staticAssertions: StaticAssertion[];
  readonly typedefScopes: Map<string, TypedefBinding>[];
  readonly tagScopes: TagScope[];
  readonly enumTagScopes: Map<string, EnumDefinition>[];
  readonly ordinaryScopes: Map<string, bigint | null>[];
  readonly ordinaryTypeScopes: Map<string, CType>[];
  readonly functions: FunctionIR[];
  readonly globals: GlobalObject[];
  readonly fileLinkage: Map<string, 'internal' | 'external'>;
  readonly typeSpecifiers: TypeSpecifierGrammar;
  readonly declarators: DeclaratorGrammar;
  readonly initializers: InitializerGrammar;
  readonly expressions: ExpressionGrammar;
  readonly declarations: DeclarationGrammar;
  readonly statements: StatementGrammar;
  cursor: number;
  nextAggregateId: number;
  nextEnumId: number;
  expressionDuration: 'automatic' | 'static';
  lastSpecifierDefinesTag: boolean;
  lastSpecifierConst: boolean;
  lastSpecifierVolatile: boolean;
  lastSpecifierRestrict: boolean;
  lastSpecifierQualifiers: TypeQualifiers;
  peek(offset?: number): Token;
  consume(): Token;
  unsupported(token: Token, message?: string): never;
  expect(text: string): Token;
  identifier(): Token;
  relatedFragment(opening: Location, boundary: Location, message: string): RelatedDiagnosticLocation | undefined;
  syntaxFailureWithRelated(message: string, location: Location, related?: RelatedDiagnosticLocation): never;
  setParserMap<K, V>(map: Map<K, V>, key: K, value: V): void;
  pushTags(): ParserScopeFrame;
  popTags(): ParserScopeFrame | undefined;
  restoreTags(frame: ParserScopeFrame): void;
  lookupTypedef(name: string): TypedefBinding | undefined;
  startsType(token?: Token): boolean;
  lookupEnumTag(tag: string): { index: number; definition: EnumDefinition; location: Location } | undefined;
  nearestTagKind(tag: string): { kind: 'aggregate' | 'enum'; index: number; aggregate?: AggregateDefinition; enumeration?: EnumDefinition; location: Location } | undefined;
  lookupEnumerator(name: string): bigint | undefined;
  declareOrdinary(name: string, location: Location, type?: CType): void;
  setOrdinaryType(name: string, type: CType): void;
  lookupOrdinaryType(name: string): CType | undefined;
  declareTypedef(name: string, type: CType, isConst: boolean, location: Location): void;
  isDeclarationStart(token?: Token): boolean;
  lookupTag(tag: string): AggregateDefinition | undefined;
  currentTag(tag: string): AggregateDefinition | undefined;
  declareEnumerator(name: string, value: bigint, location: Location): void;
  captureGlobalState(value: GlobalObject): void;
  commitParserIds(): void;
}
