export type MakefileBuildPlan = Readonly<{
  target: string;
  entry: string;
  translationUnits: readonly string[];
}>;

export type MakefileDiagnostic = Readonly<{
  file: 'Makefile';
  line: number;
  column: number;
  message: string;
}>;

export type MakefileParseResult = Readonly<{
  plan: MakefileBuildPlan | null;
  diagnostics: readonly MakefileDiagnostic[];
}>;

type Location = Readonly<{ line: number; column: number }>;
type LocatedText = Readonly<{
  text: string;
  origins: readonly Location[];
  fallback: Location;
}>;
type Variable = Readonly<{
  flavor: 'recursive' | 'simple';
  value: LocatedText;
}>;
type MakeToken = Readonly<{ text: string; location: Location }>;
type MakeRule = {
  target: string;
  targetLocation: Location;
  line: number;
  prerequisites: MakeToken[];
  recipe: LocatedText | null;
};
type CompiledRecipe = Readonly<{
  target: string;
  sources: readonly MakeToken[];
}>;

const LIMITS = Object.freeze({
  inputCharacters: 65_536,
  lines: 4_096,
  variables: 256,
  rules: 512,
  prerequisitesPerRule: 2_048,
  availableFiles: 2_048,
  expansionCharacters: 32_768,
  totalExpansionCharacters: 262_144,
  variableDepth: 32,
  dependencyDepth: 128,
  diagnostics: 128,
});

class ParseIssue extends Error {
  readonly location: Location;

  constructor(location: Location, message: string) {
    super(message);
    this.name = 'ParseIssue';
    this.location = location;
  }
}

function raise(location: Location, message: string): never {
  throw new ParseIssue(location, message);
}

function isSpace(character: string): boolean {
  return character === ' ' || character === '\t';
}

function isVariableName(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) {
    return false;
  }
  for (let index = 1; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 95)) {
      return false;
    }
  }
  return true;
}

function locationAt(value: LocatedText, index: number): Location {
  return value.origins[index] ?? value.fallback;
}

function lineText(text: string, line: number): LocatedText {
  const origins: Location[] = [];
  for (let index = 0; index < text.length; index++) {
    origins.push(Object.freeze({ line, column: index + 1 }));
  }
  return Object.freeze({
    text,
    origins: Object.freeze(origins),
    fallback: Object.freeze({ line, column: 1 }),
  });
}

function syntheticText(text: string, location: Location): LocatedText {
  const origins: Location[] = [];
  for (let index = 0; index < text.length; index++) origins.push(location);
  return Object.freeze({ text, origins: Object.freeze(origins), fallback: location });
}

function sliceText(value: LocatedText, start: number, end = value.text.length): LocatedText {
  const origins = value.origins.slice(start, end);
  return Object.freeze({
    text: value.text.slice(start, end),
    origins: Object.freeze(origins),
    fallback: origins[0] ?? locationAt(value, start),
  });
}

function trimText(value: LocatedText): LocatedText {
  let start = 0;
  let end = value.text.length;
  while (start < end && isSpace(value.text[start])) start++;
  while (end > start && isSpace(value.text[end - 1])) end--;
  return sliceText(value, start, end);
}

function splitWords(value: LocatedText): MakeToken[] {
  const words: MakeToken[] = [];
  let index = 0;
  while (index < value.text.length) {
    while (index < value.text.length && isSpace(value.text[index])) index++;
    if (index >= value.text.length) break;
    const start = index;
    while (index < value.text.length && !isSpace(value.text[index])) index++;
    words.push(Object.freeze({
      text: value.text.slice(start, index),
      location: locationAt(value, start),
    }));
  }
  return words;
}

function findTopLevel(value: LocatedText, sought: string): number {
  for (let index = 0; index < value.text.length; index++) {
    const character = value.text[index];
    if (character === '$' && value.text[index + 1] === '(') {
      const close = value.text.indexOf(')', index + 2);
      if (close < 0) return -1;
      index = close;
    } else if (character === sought) {
      return index;
    }
  }
  return -1;
}

function expressionDescription(value: LocatedText, start: number, end: number): string {
  return value.text.slice(start, end + 1);
}

function validateVariableSyntax(value: LocatedText): void {
  for (let index = 0; index < value.text.length; index++) {
    if (value.text[index] !== '$') continue;
    const location = locationAt(value, index);
    const next = value.text[index + 1];
    if (next === '@') {
      index++;
      continue;
    }
    if (next === '^') {
      raise(location, 'The automatic variable $^ is unsupported; list .c sources explicitly in the compiler recipe.');
    }
    if (next === '$') {
      raise(location, 'Escaped dollar signs and shell variable references are unsupported.');
    }
    if (next !== '(') {
      raise(location, 'Use $(NAME) for variables; only the automatic variable $@ is supported.');
    }

    let close = -1;
    let nested = -1;
    for (let cursor = index + 2; cursor < value.text.length; cursor++) {
      if (value.text[cursor] === '$' && value.text[cursor + 1] === '(') {
        nested = cursor;
        break;
      }
      if (value.text[cursor] === ')') {
        close = cursor;
        break;
      }
    }

    if (nested >= 0) {
      const prefix = value.text.slice(index + 2, nested).trim();
      const functionName = prefix.split(/[\s,]/, 1)[0];
      const detail = functionName.length > 0
        ? `Make functions and nested references such as '${functionName}' are unsupported.`
        : 'Nested or computed variable references are unsupported.';
      raise(location, detail);
    }
    if (close < 0) raise(location, 'Unterminated variable reference; expected $(NAME).');
    const name = value.text.slice(index + 2, close);
    if (!isVariableName(name)) {
      const expression = expressionDescription(value, index, close);
      raise(location, `Make functions, substitutions, and computed references are unsupported: ${expression}.`);
    }
    index = close;
  }
}

function isLogicalName(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('-')) return false;
  let segmentStart = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index < value.length && value[index] !== '/') {
      const code = value.charCodeAt(index);
      const allowed = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57) || code === 95 || code === 45 || code === 46;
      if (!allowed) return false;
      continue;
    }
    const segment = value.slice(segmentStart, index);
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
    segmentStart = index + 1;
  }
  return true;
}

function hasPatternCharacter(value: string): boolean {
  return value.includes('%') || value.includes('*') || value.includes('?')
    || value.includes('[') || value.includes(']');
}

function addToBuilder(
  pieces: string[],
  origins: Location[],
  value: LocatedText,
  location: Location,
): number {
  const currentLength = origins.length;
  if (currentLength + value.text.length > LIMITS.expansionCharacters) {
    raise(location, `Variable expansion exceeds the ${LIMITS.expansionCharacters}-character limit.`);
  }
  if (value.text.length === 0) return currentLength;
  pieces.push(value.text);
  for (let index = 0; index < value.text.length; index++) {
    origins.push(value.origins[index] ?? value.fallback);
  }
  return currentLength + value.text.length;
}

function expandText(
  value: LocatedText,
  variables: ReadonlyMap<string, Variable>,
  stack: readonly string[],
  target: string | null,
): LocatedText {
  const pieces: string[] = [];
  const origins: Location[] = [];
  let literalStart = 0;
  let index = 0;

  const append = (part: LocatedText, location: Location): void => {
    addToBuilder(pieces, origins, part, location);
  };

  while (index < value.text.length) {
    if (value.text[index] !== '$') {
      index++;
      continue;
    }

    const referenceLocation = locationAt(value, index);
    append(sliceText(value, literalStart, index), referenceLocation);
    const next = value.text[index + 1];
    if (next === '@') {
      if (target !== null) append(syntheticText(target, referenceLocation), referenceLocation);
      index += 2;
      literalStart = index;
      continue;
    }
    if (next !== '(') {
      if (next === '^') {
        raise(referenceLocation, 'The automatic variable $^ is unsupported; list .c sources explicitly in the compiler recipe.');
      }
      if (next === '$') raise(referenceLocation, 'Escaped dollar signs and shell variable references are unsupported.');
      raise(referenceLocation, 'Use $(NAME) for variables; only the automatic variable $@ is supported.');
    }

    const close = value.text.indexOf(')', index + 2);
    if (close < 0) raise(referenceLocation, 'Unterminated variable reference; expected $(NAME).');
    const name = value.text.slice(index + 2, close);
    if (!isVariableName(name)) {
      raise(referenceLocation, `Make functions, substitutions, and computed references are unsupported: ${expressionDescription(value, index, close)}.`);
    }
    const variable = variables.get(name);
    if (variable) {
      if (variable.flavor === 'simple') {
        append(variable.value, referenceLocation);
      } else {
        const cycleStart = stack.indexOf(name);
        if (cycleStart >= 0) {
          const cycle = [...stack.slice(cycleStart), name].join(' -> ');
          raise(referenceLocation, `Variable expansion cycle detected: ${cycle}.`);
        }
        if (stack.length >= LIMITS.variableDepth) {
          raise(referenceLocation, `Variable expansion depth exceeds the ${LIMITS.variableDepth}-variable limit.`);
        }
        append(expandText(variable.value, variables, [...stack, name], target), referenceLocation);
      }
    }
    index = close + 1;
    literalStart = index;
  }

  append(sliceText(value, literalStart), locationAt(value, literalStart));
  return Object.freeze({
    text: pieces.join(''),
    origins: Object.freeze(origins),
    fallback: value.fallback,
  });
}

function stripComment(value: LocatedText): LocatedText {
  const comment = value.text.indexOf('#');
  return comment < 0 ? value : sliceText(value, 0, comment);
}

function directiveName(value: LocatedText): string {
  let end = 0;
  while (end < value.text.length && !isSpace(value.text[end]) && value.text[end] !== ':') end++;
  return value.text.slice(0, end);
}

function makeResult(
  plan: MakefileBuildPlan | null,
  diagnostics: readonly MakefileDiagnostic[],
): MakefileParseResult {
  const frozenDiagnostics = Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic })));
  const frozenPlan = plan === null ? null : Object.freeze({
    target: plan.target,
    entry: plan.entry,
    translationUnits: Object.freeze([...plan.translationUnits]),
  });
  return Object.freeze({ plan: frozenPlan, diagnostics: frozenDiagnostics });
}

/** Parse the supported Makefile subset into an immutable logical build plan. */
export function parseMakefile(
  source: string,
  availableFileNames: readonly string[],
): MakefileParseResult {
  const diagnostics: MakefileDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  let diagnosticLimitReported = false;
  let expansionCharactersUsed = 0;

  const addDiagnostic = (location: Location, message: string): void => {
    const key = `${location.line}:${location.column}:${message}`;
    if (diagnosticKeys.has(key)) return;
    if (diagnostics.length >= LIMITS.diagnostics) {
      if (!diagnosticLimitReported) {
        diagnosticLimitReported = true;
        const last = diagnostics[LIMITS.diagnostics - 1];
        diagnostics[LIMITS.diagnostics - 1] = Object.freeze({
          file: 'Makefile',
          line: last?.line ?? location.line,
          column: last?.column ?? location.column,
          message: `Further diagnostics were omitted after the ${LIMITS.diagnostics}-diagnostic limit.`,
        });
      }
      return;
    }
    diagnosticKeys.add(key);
    diagnostics.push(Object.freeze({ file: 'Makefile', line: location.line, column: location.column, message }));
  };

  const addIssue = (error: unknown, fallback: Location): void => {
    if (error instanceof ParseIssue) addDiagnostic(error.location, error.message);
    else addDiagnostic(fallback, 'The Makefile could not be parsed because of an unexpected input condition.');
  };

  const expandForUse = (
    value: LocatedText,
    variables: ReadonlyMap<string, Variable>,
    target: string | null,
  ): LocatedText => {
    validateVariableSyntax(value);
    const expanded = expandText(value, variables, [], target);
    expansionCharactersUsed += expanded.text.length;
    if (expansionCharactersUsed > LIMITS.totalExpansionCharacters) {
      raise(value.fallback, `Cumulative variable expansion exceeds the ${LIMITS.totalExpansionCharacters}-character limit.`);
    }
    return expanded;
  };

  if (typeof source !== 'string') {
    addDiagnostic(Object.freeze({ line: 1, column: 1 }), 'Makefile source must be a string.');
    return makeResult(null, diagnostics);
  }
  if (source.length > LIMITS.inputCharacters) {
    addDiagnostic(Object.freeze({ line: 1, column: 1 }), `Makefile exceeds the ${LIMITS.inputCharacters}-character input limit.`);
    return makeResult(null, diagnostics);
  }
  if (!Array.isArray(availableFileNames)) {
    addDiagnostic(Object.freeze({ line: 1, column: 1 }), 'Available file names must be provided as an array.');
    return makeResult(null, diagnostics);
  }
  if (availableFileNames.length > LIMITS.availableFiles) {
    addDiagnostic(Object.freeze({ line: 1, column: 1 }), `Available file list exceeds the ${LIMITS.availableFiles}-file limit.`);
    return makeResult(null, diagnostics);
  }

  const availableFiles = new Set<string>();
  for (let index = 0; index < availableFileNames.length; index++) {
    const name = availableFileNames[index];
    if (typeof name !== 'string') {
      addDiagnostic(Object.freeze({ line: 1, column: 1 }), 'Available file names must all be strings.');
      continue;
    }
    availableFiles.add(name);
  }

  const lines = source.split('\n');
  if (lines.length > LIMITS.lines) {
    addDiagnostic(Object.freeze({ line: LIMITS.lines + 1, column: 1 }), `Makefile exceeds the ${LIMITS.lines}-line input limit.`);
    return makeResult(null, diagnostics);
  }

  const variables = new Map<string, Variable>();
  variables.set('CC', Object.freeze({
    flavor: 'simple',
    value: syntheticText('cc', Object.freeze({ line: 1, column: 1 })),
  }));
  const definedVariables = new Set<string>();
  const rules = new Map<string, MakeRule>();
  const phonyTargets = new Set<string>();
  let activeRule: MakeRule | null = null;
  let normalRuleCount = 0;

  const parseAssignment = (value: LocatedText, equals: number): boolean => {
    const left = sliceText(value, 0, equals);
    const operatorCharacter = left.text[left.text.length - 1];
    let flavor: 'recursive' | 'simple' = 'recursive';
    let nameEnd = left.text.length;
    if (operatorCharacter === ':') {
      let colonStart = nameEnd - 1;
      while (colonStart > 0 && left.text[colonStart - 1] === ':') colonStart--;
      if (nameEnd - colonStart > 1) {
        const operator = `${':'.repeat(nameEnd - colonStart)}=`;
        raise(locationAt(left, colonStart), `The ${operator} assignment operator is unsupported; use = or :=.`);
      }
      flavor = 'simple';
      nameEnd--;
    } else if (operatorCharacter === '+' || operatorCharacter === '?' || operatorCharacter === '!') {
      raise(locationAt(left, nameEnd - 1), `The ${operatorCharacter}= assignment operator is unsupported; use = or :=.`);
    }

    const nameText = trimText(sliceText(left, 0, nameEnd));
    if (nameText.text.includes(':')) {
      raise(locationAt(nameText, nameText.text.indexOf(':')), 'Target-specific variable assignments are unsupported.');
    }
    if (nameText.text.startsWith('.')) {
      raise(nameText.fallback, `Special Make variables such as '${nameText.text}' are unsupported.`);
    }
    if (!isVariableName(nameText.text)) {
      if (value.text.slice(0, equals).includes(':')) return false;
      raise(nameText.fallback, 'Variable names must use letters, digits, and underscores and start with a letter or underscore.');
    }
    if (definedVariables.has(nameText.text)) {
      raise(nameText.fallback, `Variable '${nameText.text}' is defined more than once; duplicate definitions are unsupported.`);
    }
    if (definedVariables.size >= LIMITS.variables) {
      raise(nameText.fallback, `Makefile exceeds the ${LIMITS.variables}-variable limit.`);
    }

    let valueStart = equals + 1;
    while (valueStart < value.text.length && isSpace(value.text[valueStart])) valueStart++;
    const variableValue = sliceText(value, valueStart);
    validateVariableSyntax(variableValue);
    if (flavor === 'simple') {
      const expanded = expandForUse(variableValue, variables, null);
      variables.set(nameText.text, Object.freeze({ flavor, value: expanded }));
    } else {
      variables.set(nameText.text, Object.freeze({ flavor, value: variableValue }));
    }
    definedVariables.add(nameText.text);
    return true;
  };

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const lineNumber = index + 1;
    const locatedLine = stripComment(lineText(line, lineNumber));
    const trimmed = trimText(locatedLine);
    if (trimmed.text.length === 0) continue;

    try {
      for (let charIndex = 0; charIndex < locatedLine.text.length; charIndex++) {
        const character = locatedLine.text[charIndex];
        if (character === '\\') raise(locationAt(locatedLine, charIndex), 'Backslashes and line continuations are unsupported.');
        if (character === '"' || character === "'") raise(locationAt(locatedLine, charIndex), 'Quoting is unsupported in the Makefile subset.');
        const code = locatedLine.text.charCodeAt(charIndex);
        if (code < 32 && character !== '\t') {
          raise(locationAt(locatedLine, charIndex), 'Control characters are unsupported in Makefile lines.');
        }
      }

      if (line[0] === '\t') {
        if (activeRule === null) raise(locationAt(locatedLine, 0), 'Recipe line has no preceding target rule.');
        if (activeRule.recipe !== null) {
          raise(locationAt(locatedLine, 0), 'Multiple recipe lines for one target are unsupported.');
        }
        const recipe = sliceText(locatedLine, Math.min(1, locatedLine.text.length));
        validateVariableSyntax(recipe);
        activeRule.recipe = recipe;
        continue;
      }

      activeRule = null;
      const directive = directiveName(trimmed);
      if (directive === 'include' || directive === '-include' || directive === 'sinclude') {
        raise(trimmed.fallback, 'Included Makefiles are unsupported.');
      }
      if (directive === 'vpath' || directive === 'define' || directive === 'endef'
        || directive === 'ifeq' || directive === 'ifneq' || directive === 'ifdef'
        || directive === 'ifndef' || directive === 'else' || directive === 'endif'
        || directive === 'export' || directive === 'unexport' || directive === 'override'
        || directive === 'undefine' || directive === 'load') {
        raise(trimmed.fallback, `The '${directive}' directive is unsupported.`);
      }

      const equals = findTopLevel(locatedLine, '=');
      if (equals >= 0) {
        if (parseAssignment(locatedLine, equals)) continue;
      }

      const colon = findTopLevel(locatedLine, ':');
      if (colon < 0) {
        raise(trimmed.fallback, 'Expected a variable assignment or target rule; recipes must begin with a literal TAB.');
      }
      if (locatedLine.text[colon + 1] === ':') {
        raise(locationAt(locatedLine, colon), 'Double-colon rules are unsupported.');
      }
      const rawHead = trimText(sliceText(locatedLine, 0, colon));
      const rawPrerequisites = sliceText(locatedLine, colon + 1);
      if (rawPrerequisites.text.includes(';')) {
        raise(locationAt(rawPrerequisites, rawPrerequisites.text.indexOf(';')), 'Inline recipes are unsupported; put the compiler command on a TAB-prefixed line.');
      }
      if (rawHead.text === '.PHONY') {
        const expanded = expandForUse(rawPrerequisites, variables, null);
        const names = splitWords(expanded);
        for (const name of names) {
          if (!isLogicalName(name.text)) {
            raise(name.location, 'The .PHONY directive accepts only simple logical target names.');
          }
          phonyTargets.add(name.text);
        }
        continue;
      }
      if (rawHead.text.startsWith('.')) {
        raise(rawHead.fallback, `Special target or directive '${rawHead.text}' is unsupported.`);
      }

      const expandedHead = expandForUse(rawHead, variables, null);
      const targets = splitWords(expandedHead);
      if (targets.length !== 1) {
        raise(rawHead.fallback, targets.length === 0
          ? 'A target rule must name exactly one target.'
          : 'Multiple targets in one rule are unsupported; use one target per rule.');
      }
      const target = targets[0].text;
      if (hasPatternCharacter(target)) raise(targets[0].location, 'Pattern rules and wildcards are unsupported.');
      if (!isLogicalName(target)) raise(targets[0].location, `Target '${target}' is not a supported logical filename.`);
      if (target.endsWith('.o')) raise(targets[0].location, 'Object-file targets (.o) are unsupported.');

      const expandedPrerequisites = expandForUse(rawPrerequisites, variables, target);
      const prerequisites = splitWords(expandedPrerequisites);
      if (prerequisites.length > LIMITS.prerequisitesPerRule) {
        raise(rawPrerequisites.fallback, `Rule exceeds the ${LIMITS.prerequisitesPerRule}-prerequisite limit.`);
      }
      for (const prerequisite of prerequisites) {
        if (prerequisite.text === '|') raise(prerequisite.location, 'Order-only prerequisites are unsupported.');
        if (hasPatternCharacter(prerequisite.text)) raise(prerequisite.location, 'Pattern rules and wildcards are unsupported.');
        if (!isLogicalName(prerequisite.text)) {
          raise(prerequisite.location, `Prerequisite '${prerequisite.text}' is not a supported logical filename.`);
        }
        if (prerequisite.text.endsWith('.o')) {
          raise(prerequisite.location, 'Object-file prerequisites (.o) are unsupported.');
        }
      }
      if (rules.has(target)) {
        raise(targets[0].location, `Target '${target}' has more than one rule; duplicate rules are unsupported.`);
      }
      if (rules.size >= LIMITS.rules) raise(targets[0].location, `Makefile exceeds the ${LIMITS.rules}-rule limit.`);

      const rule: MakeRule = {
        target,
        targetLocation: targets[0].location,
        line: lineNumber,
        prerequisites,
        recipe: null,
      };
      rules.set(target, rule);
      normalRuleCount++;
      activeRule = rule;
    } catch (error) {
      addIssue(error, trimmed.fallback);
      activeRule = null;
    }
  }

  if (normalRuleCount === 0) {
    addDiagnostic(Object.freeze({ line: 1, column: 1 }), 'No normal target rule was found; a program build rule is required.');
    return makeResult(null, diagnostics);
  }

  const compiledRecipes = new Map<string, CompiledRecipe>();
  for (const rule of rules.values()) {
    if (rule.recipe === null) continue;
    try {
      const expanded = expandForUse(rule.recipe, variables, rule.target);
      const tokens = splitWords(expanded);
      if (tokens.length === 0) {
        raise(rule.recipe.fallback, 'Compiler recipe is empty; expected cc, gcc, or clang with .c sources and -o target.');
      }
      const compiler = tokens[0].text;
      if (compiler !== 'cc' && compiler !== 'gcc' && compiler !== 'clang') {
        raise(tokens[0].location, `Recipe must start with cc, gcc, or clang (or a CC variable expanding to one); found '${compiler}'.`);
      }

      const sources: MakeToken[] = [];
      let outputTarget: MakeToken | null = null;
      for (let tokenIndex = 1; tokenIndex < tokens.length; tokenIndex++) {
        const token = tokens[tokenIndex];
        if (/[;|&<>]/.test(token.text)) {
          raise(token.location, 'Shell operators and redirections are unsupported in compiler recipes.');
        }
        if (token.text === '-o') {
          if (outputTarget !== null) raise(token.location, 'A compiler recipe must contain exactly one -o target.');
          const output = tokens[tokenIndex + 1];
          if (!output) raise(token.location, "The -o option must be followed by the rule's logical target.");
          if (output.text.startsWith('-') || !isLogicalName(output.text)) {
            raise(output.location, "The -o option must be followed by a simple logical target name.");
          }
          if (output.text.endsWith('.o')) raise(output.location, 'Object-file outputs (.o) are unsupported.');
          outputTarget = output;
          tokenIndex++;
          continue;
        }
        if (token.text.startsWith('-')) {
          raise(token.location, `Compiler flag '${token.text}' is unsupported; only '-o <target>' is accepted.`);
        }
        if (token.text.endsWith('.h')) {
          raise(token.location, 'Header files are prerequisites or include sources, not compiler operands.');
        }
        if (token.text.endsWith('.o')) {
          raise(token.location, 'Object-file operands (.o) are unsupported; list .c translation units directly.');
        }
        if (!token.text.endsWith('.c')) {
          raise(token.location, `Compiler operands must be .c sources or '-o <target>'; found '${token.text}'.`);
        }
        if (!isLogicalName(token.text)) raise(token.location, `Source '${token.text}' is not a supported logical filename.`);
        if (!availableFiles.has(token.text)) {
          raise(token.location, `Source '${token.text}' is not available in the current workspace.`);
        }
        sources.push(token);
      }

      if (outputTarget === null) raise(rule.recipe.fallback, "Compiler recipe must include '-o' followed by its logical target.");
      if (outputTarget.text !== rule.target) {
        raise(outputTarget.location, `Compiler output '${outputTarget.text}' must match rule target '${rule.target}'.`);
      }
      if (sources.length === 0) raise(rule.recipe.fallback, 'Compiler recipe must include at least one available .c source.');
      compiledRecipes.set(rule.target, Object.freeze({ target: rule.target, sources: Object.freeze([...sources]) }));
    } catch (error) {
      addIssue(error, rule.recipe.fallback);
    }
  }

  const defaultRule = rules.values().next().value as MakeRule | undefined;
  if (!defaultRule) {
    addDiagnostic(Object.freeze({ line: 1, column: 1 }), 'No normal target rule was found; a program build rule is required.');
    return makeResult(null, diagnostics);
  }

  const resolution = new Map<string, ReadonlySet<string>>();
  const visiting: string[] = [];
  const reachableRules = new Set<string>();
  const resolveTarget = (target: string, incoming: Location, depth: number): ReadonlySet<string> => {
    const cached = resolution.get(target);
    if (cached) return cached;
    if (depth > LIMITS.dependencyDepth) {
      addDiagnostic(incoming, `Dependency depth exceeds the ${LIMITS.dependencyDepth}-rule limit.`);
      return new Set();
    }
    const cycleStart = visiting.indexOf(target);
    if (cycleStart >= 0) {
      const cycle = [...visiting.slice(cycleStart), target].join(' -> ');
      addDiagnostic(incoming, `Dependency cycle detected: ${cycle}.`);
      return new Set();
    }

    const rule = rules.get(target);
    if (!rule) return new Set();
    reachableRules.add(target);
    visiting.push(target);
    const programs = new Set<string>();
    if (rule.recipe !== null) programs.add(rule.target);
    for (const prerequisite of rule.prerequisites) {
      if (rules.has(prerequisite.text)) {
        for (const program of resolveTarget(prerequisite.text, prerequisite.location, depth + 1)) {
          programs.add(program);
        }
      } else if (!availableFiles.has(prerequisite.text) && !phonyTargets.has(prerequisite.text)) {
        addDiagnostic(prerequisite.location, `Prerequisite '${prerequisite.text}' is not available and has no target rule.`);
      }
    }
    visiting.pop();
    const result = new Set(programs);
    resolution.set(target, result);
    return result;
  };

  const programs = resolveTarget(defaultRule.target, defaultRule.targetLocation, 0);
  for (const target of reachableRules) {
    const rule = rules.get(target);
    if (!rule || rule.recipe !== null) continue;
    const resolved = resolution.get(target) ?? new Set<string>();
    if (resolved.size === 0) {
      addDiagnostic(rule.targetLocation, `Aggregation target '${target}' does not resolve to a compiler target.`);
    } else if (resolved.size > 1) {
      addDiagnostic(rule.targetLocation, `Aggregation target '${target}' resolves to multiple programs; exactly one is supported.`);
    }
  }

  if (programs.size === 0) {
    addDiagnostic(defaultRule.targetLocation, `Default target '${defaultRule.target}' does not resolve to a compiler recipe.`);
  } else if (programs.size > 1) {
    addDiagnostic(defaultRule.targetLocation, `Default target '${defaultRule.target}' reaches multiple programs; only one program is supported.`);
  }

  if (diagnostics.length > 0 || programs.size !== 1) {
    return makeResult(null, diagnostics.sort((left, right) => left.line - right.line || left.column - right.column));
  }

  const target = programs.values().next().value as string;
  const recipe = compiledRecipes.get(target);
  if (!recipe) return makeResult(null, diagnostics);
  const translationUnits = recipe.sources.map(sourceToken => sourceToken.text);
  const plan: MakefileBuildPlan = {
    target,
    entry: translationUnits[0],
    translationUnits,
  };
  return makeResult(plan, diagnostics);
}
