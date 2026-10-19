import type { CType, ScalarCType, Token, TypeQualifiers } from './internal.ts';
import { failure } from './internal.ts';
import { qualifiersOf } from './type-system.ts';
import type { DeclarationSpecifierConsumer, DeclarationSpecifiers, ParserContext, TypeSpecifierGrammar } from './parser-context-types.ts';

const scalarWords = new Set(['char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'void', '_Bool']);
const unsupportedWords = new Set(['_Atomic', '_Complex', '_Imaginary']);
const declarationOnlySpecifiers = new Set(['static', 'extern', 'typedef', 'auto', 'register', 'inline', '_Noreturn', '_Thread_local', '_Alignas']);

export function createTypeSpecifierGrammar(context: ParserContext): Pick<TypeSpecifierGrammar, 'newDeclarationSpecifiers' | 'consumeDeclarationSpecifier' | 'parseTypeSpecifier'> {
  const peek = (offset = 0): Token => context.peek(offset);
  const consume = (): Token => context.consume();
  const unsupported = (token: Token, message?: string): never => context.unsupported(token, message);
  const lookupTypedef = (name: string) => context.lookupTypedef(name);
  const parseAlignmentSpecifier = () => context.initializers.parseAlignmentSpecifier();

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
  context.lastSpecifierDefinesTag = false;
  context.lastSpecifierConst = false;
  context.lastSpecifierVolatile = false;
  context.lastSpecifierRestrict = false;
  context.lastSpecifierQualifiers = {};
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
    const next = { ...context.lastSpecifierQualifiers, [qualifier.text]: true } as TypeQualifiers;
    context.lastSpecifierQualifiers = next;
    context.lastSpecifierConst = !!next.const;
    context.lastSpecifierVolatile = !!next.volatile;
    context.lastSpecifierRestrict = !!next.restrict;
    return true;
  };
  while (collectDeclarationSpecifier() || consumeQualifier()) { /* declaration specifiers may appear in any order */ }
  if (peek().text === 'struct' || peek().text === 'union') {
    const qualifiers = { ...context.lastSpecifierQualifiers };
    const type = context.typeSpecifiers.parseAggregateSpecifier();
    context.lastSpecifierQualifiers = qualifiers;
    context.lastSpecifierConst = !!qualifiers.const; context.lastSpecifierVolatile = !!qualifiers.volatile; context.lastSpecifierRestrict = !!qualifiers.restrict;
    while (collectDeclarationSpecifier() || consumeQualifier()) { /* qualifiers and declaration specifiers may follow an aggregate specifier */ }
    return type;
  }
  if (peek().text === 'enum') {
    const qualifiers = { ...context.lastSpecifierQualifiers };
    const type = context.typeSpecifiers.parseEnumSpecifier();
    context.lastSpecifierQualifiers = qualifiers;
    context.lastSpecifierConst = !!qualifiers.const; context.lastSpecifierVolatile = !!qualifiers.volatile; context.lastSpecifierRestrict = !!qualifiers.restrict;
    while (collectDeclarationSpecifier() || consumeQualifier()) { /* qualifiers and declaration specifiers may follow an enum specifier */ }
    return type;
  }
  if (unsupportedWords.has(peek().text)) unsupported(peek());
  if (peek().kind === 'identifier') {
    const alias = lookupTypedef(peek().text);
    if (alias) {
      context.lastSpecifierConst = context.lastSpecifierConst || !!alias.isConst || !!qualifiersOf(alias.type).const;
      context.lastSpecifierVolatile = context.lastSpecifierVolatile || !!qualifiersOf(alias.type).volatile;
      context.lastSpecifierRestrict = context.lastSpecifierRestrict || !!qualifiersOf(alias.type).restrict;
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
  return { newDeclarationSpecifiers, consumeDeclarationSpecifier, parseTypeSpecifier };
}
