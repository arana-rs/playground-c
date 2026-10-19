import { failure } from './internal.ts';
import type {
  AggregateDefinition, EnumDefinition, FunctionIR, GlobalObject, Location, ParsedProgram, ProgramIR,
} from './internal.ts';
import { analyze } from './parser.ts';
import {
  arrayOf, compositeType, compatibleType, unqualifiedType,
  type TypeCompatibilityContext,
} from './type-system.ts';
import {
  compatibleFunctionDeclarations, createTypeRewriter, TypeUnions, unifyFunctionTypes, unifyTypes,
} from './linker-types.ts';
import {
  collectSymbolReferences, remapBindingsAndFunctions, rewriteObjectGraph, visitObjectGraph,
} from './linker-ir.ts';
import {
  groupByKey, isExternalFunctionDefinition, isModifiableInlineStaticObject, symbolKey,
} from './linker-symbols.ts';
import type { FunctionDeclaration, GlobalDeclaration, SymbolGroup, UnitWork } from './linker-symbols.ts';

/** Resolve C external and internal identifiers after each source file is parsed independently. */
export function linkTranslationUnits(units: readonly ParsedProgram[], entry: string): ProgramIR {
  if (!units.length) failure('INVALID_PROJECT', 'The program contains no translation units.', { file: entry, line: 1, column: 1 });
  const unitWork: UnitWork[] = units.map((parsed) => ({ parsed }));

  // analyze() also validates file-scope initializers. A declaration-only TU still
  // needs that pass, so give it a temporary empty body and remove it immediately.
  for (const work of unitWork) {
    if (work.parsed.functions.some((fn) => !!fn.body)) continue;
    const unit = work.parsed.translationUnit ?? entry;
    let name = '__c11_internal_initializer_analysis';
    let suffix = 0;
    while (work.parsed.functions.some((fn) => fn.name === name)) name = `__c11_internal_initializer_analysis_${++suffix}`;
    const location = { file: unit, line: 1, column: 1 };
    const synthetic: FunctionIR = {
      name, returnType: 'void', parameters: [], bindings: [], location,
      linkage: 'internal', symbolKey: `internal:${unit}:${name}`, translationUnit: unit, prototype: true,
      body: { kind: 'block', statements: [], bindings: [], location, endLocation: location },
    };
    work.parsed.functions.push(synthetic);
    work.synthetic = synthetic;
  }
  for (const work of unitWork) {
    analyze(work.parsed, { allowMissingMain: true, allowUnresolved: true });
    for (const global of work.parsed.globals) {
      const globalType = unqualifiedType(global.type);
      if (global.tentative && typeof globalType !== 'string' && globalType.kind === 'array' && globalType.length === null) {
        global.type = arrayOf(globalType.element, 1);
      }
    }
    if (work.synthetic) work.parsed.functions.pop();
  }

  const aggregateDefinitions = new Map<number, AggregateDefinition>();
  for (const { parsed } of unitWork) for (const definition of parsed.aggregates) {
    if (!aggregateDefinitions.has(definition.id)) aggregateDefinitions.set(definition.id, definition);
  }
  const enumDefinitions = new Map<number, EnumDefinition>();
  for (const { parsed } of unitWork) for (const definition of parsed.enums) {
    if (!enumDefinitions.has(definition.id)) enumDefinitions.set(definition.id, definition);
  }
  const compatibilityContext: TypeCompatibilityContext = { aggregates: aggregateDefinitions, enums: enumDefinitions };

  const functionGroups = new Map<string, SymbolGroup<FunctionDeclaration>>();
  const globalGroups = new Map<string, SymbolGroup<GlobalDeclaration>>();
  for (let unit = 0; unit < unitWork.length; unit++) {
    const parsed = unitWork[unit].parsed;
    for (const fn of parsed.functions) {
      const key = fn.symbolKey ?? symbolKey(fn.linkage, fn.translationUnit ?? parsed.translationUnit ?? entry, fn.name);
      groupByKey(functionGroups, key).declarations.push({ unit, fn });
    }
    for (const global of parsed.globals) {
      const key = global.symbolKey ?? symbolKey(global.linkage, global.translationUnit ?? parsed.translationUnit ?? entry, global.name);
      groupByKey(globalGroups, key).declarations.push({ unit, global });
    }
  }

  const localGlobalIds = unitWork.map(() => new Map<number, string>());
  for (let unit = 0; unit < unitWork.length; unit++) {
    const parsed = unitWork[unit].parsed;
    for (const global of parsed.globals) {
      const key = global.symbolKey ?? symbolKey(global.linkage, global.translationUnit ?? parsed.translationUnit ?? entry, global.name);
      localGlobalIds[unit].set(global.id, key);
    }
  }

  for (const [key, group] of functionGroups) {
    const conflictingObjects = globalGroups.get(key);
    if (conflictingObjects) {
      failure('CONFLICTING_TYPES', `«${group.declarations[0].fn.name}» is declared as both an object and a function.`, conflictingObjects.declarations[0].global.location);
    }
  }

  const inlineAggregateContext = [...aggregateDefinitions.values()];
  for (const group of functionGroups.values()) {
    for (const definition of group.declarations) {
      const { fn, unit } = definition;
      if (!fn.body || !fn.inline || fn.extern || fn.linkage === 'internal' || isExternalFunctionDefinition(definition, group)) continue;

      for (const binding of fn.bindings) {
        if (binding.globalBinding !== undefined ||
            (binding.storageDuration !== 'static' && binding.storageDuration !== 'thread-local')) continue;
        if (isModifiableInlineStaticObject(binding.type, inlineAggregateContext)) {
          failure('TYPE_ERROR', 'An inline definition with external linkage cannot define a modifiable static or _Thread_local object.', binding.location);
        }
      }

      visitObjectGraph(fn.body, (node) => {
        const value = node as Record<string, unknown>;
        if (value.kind === 'variable' && typeof value.globalBinding === 'number') {
          const referencedKey = localGlobalIds[unit].get(value.globalBinding);
          const target = referencedKey ? globalGroups.get(referencedKey) : undefined;
          if (target?.declarations.some(({ global }) => global.linkage === 'internal')) {
            failure('TYPE_ERROR', 'An inline definition with external linkage cannot refer to an identifier with internal linkage.', value.location as Location);
          }
        }
        if ((value.kind === 'function' || value.kind === 'call') && typeof value.symbolKey === 'string') {
          const referenced = functionGroups.get(value.symbolKey);
          if (referenced?.declarations.some(({ fn: target }) => target.linkage === 'internal')) {
            failure('TYPE_ERROR', 'An inline definition with external linkage cannot refer to an identifier with internal linkage.', value.location as Location);
          }
        }
      });
    }
  }

  const typeUnions = new TypeUnions();
  const enumUnions = new TypeUnions();
  for (const group of functionGroups.values()) {
    const first = group.declarations[0];
    for (const item of group.declarations.slice(1)) {
      if (!compatibleFunctionDeclarations(first.fn, item.fn, compatibilityContext)) {
        failure('CONFLICTING_TYPES', `Incompatible declarations of function «${first.fn.name}».`, item.fn.location);
      }
      unifyFunctionTypes(first.fn, item.fn, aggregateDefinitions, typeUnions, enumUnions, compatibilityContext);
    }
  }
  for (const group of globalGroups.values()) {
    const first = group.declarations[0];
    for (const item of group.declarations.slice(1)) {
      if (!!first.global.isConst !== !!item.global.isConst ||
          !!first.global.threadLocal !== !!item.global.threadLocal ||
          !compatibleType(first.global.type, item.global.type, compatibilityContext)) {
        failure('CONFLICTING_TYPES', `Incompatible declarations of object «${first.global.name}».`, item.global.location);
      }
      unifyTypes(first.global.type, item.global.type, aggregateDefinitions, typeUnions, enumUnions, compatibilityContext);
    }
  }

  const rewriteType = createTypeRewriter(typeUnions, enumUnions);

  for (const { parsed } of unitWork) {
    for (const definition of parsed.aggregates) {
      definition.id = typeUnions.find(definition.id);
      for (const member of definition.members) member.type = rewriteType(member.type);
    }
    for (const definition of parsed.enums) definition.id = enumUnions.find(definition.id);
    rewriteObjectGraph(parsed.functions, rewriteType);
    rewriteObjectGraph(parsed.globals, rewriteType);
  }

  const aggregatesById = new Map<number, AggregateDefinition>();
  for (const { parsed } of unitWork) for (const candidate of parsed.aggregates) {
    const prior = aggregatesById.get(candidate.id);
    if (!prior || !prior.complete && candidate.complete) aggregatesById.set(candidate.id, candidate);
  }
  const aggregates = [...aggregatesById.values()];
  const enumsById = new Map<number, EnumDefinition>();
  for (const { parsed } of unitWork) for (const candidate of parsed.enums) {
    if (!enumsById.has(candidate.id)) enumsById.set(candidate.id, candidate);
  }
  const enums = [...enumsById.values()];

  const { functionRefs, globalRefs } = collectSymbolReferences(unitWork, localGlobalIds);

  const functionIndexByKey = new Map<string, number>();
  const functionHasExternalDefinition = new Map<string, boolean>();
  const functions: FunctionIR[] = [];
  for (const [key, group] of functionGroups) {
    const definitions = group.declarations.filter((item) => !!item.fn.body);
    const externalDefinitions = definitions.filter((definition) => isExternalFunctionDefinition(definition, group));
    if (externalDefinitions.length > 1) {
      failure('REDEFINITION', `Function «${externalDefinitions[1].fn.name}» has more than one external definition.`, externalDefinitions[1].fn.location);
    }
    const externalDefinition = externalDefinitions[0];
    const builtin = definitions.length ? undefined : group.declarations.find((item) => !!item.fn.builtin);
    // An external-linkage inline definition may provide a body for optimization in
    // its own translation unit, but it never replaces the required external definition.
    const selected = externalDefinition ?? definitions[0] ?? builtin;
    functionHasExternalDefinition.set(key, !!externalDefinition || !!builtin);
    if (!selected) {
      const reference = functionRefs.get(key);
      if (reference) failure('UNDEFINED_FUNCTION', `Function «${group.declarations[0].fn.name}» has no definition in the program.`, reference);
      continue;
    }
    const reference = functionRefs.get(key);
    if (reference && !externalDefinition && !builtin) {
      failure('UNDEFINED_FUNCTION', `Function «${group.declarations[0].fn.name}» has no external definition in the program.`, reference);
    }
    const index = functions.length;
    functions.push({ ...selected.fn, noreturn: group.declarations.some((item) => !!item.fn.noreturn) });
    functionIndexByKey.set(key, index);
  }

  const globalIndexByKey = new Map<string, number>();
  const globals: GlobalObject[] = [];
  for (const [key, group] of globalGroups) {
    const definitions = group.declarations.filter((item) => !!item.global.initializer || !!item.global.tentative);
    if (definitions.length > 1) failure('REDEFINITION', `Object «${definitions[1].global.name}» has more than one external definition.`, definitions[1].global.location);
    const selected = definitions[0];
    if (!selected) {
      const reference = globalRefs.get(key);
      if (reference) failure('UNDEFINED_OBJECT', `External object «${group.declarations[0].global.name}» has no definition in the program.`, reference);
      continue;
    }
    let combinedType = selected.global.type;
    for (const declaration of group.declarations) {
      const composite = compositeType(combinedType, declaration.global.type, compatibilityContext);
      if (!composite) failure('CONFLICTING_TYPES', `Incompatible declarations of object «${selected.global.name}».`, declaration.global.location);
      // The composite can be created after the parsed IR has been rewritten.
      // Canonicalize it too, so an aggregate selected from a later TU cannot
      // retain an ID that TypeUnions already folded into another definition.
      combinedType = rewriteType(composite);
    }
    const index = globals.length;
    globals.push({ ...selected.global, id: index, type: combinedType, tentative: !!selected.global.tentative && !selected.global.initializer, declarationOnly: false });
    globalIndexByKey.set(key, index);
  }

  const localGlobalFinalIds = unitWork.map(() => new Map<number, number>());
  for (let unit = 0; unit < unitWork.length; unit++) for (const [localId, key] of localGlobalIds[unit]) {
    const globalId = globalIndexByKey.get(key);
    if (globalId !== undefined) localGlobalFinalIds[unit].set(localId, globalId);
  }
  for (let unit = 0; unit < unitWork.length; unit++) {
    for (const fn of unitWork[unit].parsed.functions) if (fn.body) {
      const bindingGlobals = new Map<number, number>();
      for (const binding of fn.bindings) {
        if (binding.globalBinding === undefined) continue;
        const mapped = localGlobalFinalIds[unit].get(binding.globalBinding);
        if (mapped !== undefined) {
          bindingGlobals.set(binding.id, mapped);
          binding.globalBinding = mapped;
        }
      }
      remapBindingsAndFunctions(fn.body, localGlobalFinalIds[unit], functionIndexByKey, bindingGlobals);
    }
  }
  for (const item of globalGroups.values()) {
    const selected = item.declarations.find((declaration) => declaration.global.initializer);
    if (!selected) continue;
    const target = globalIndexByKey.get(item.key);
    if (target === undefined) continue;
    remapBindingsAndFunctions(selected.global.initializer!, localGlobalFinalIds[selected.unit], functionIndexByKey);
  }

  const externalFunctions = [...functionGroups.values()].flatMap((group) => group.declarations)
    .filter(({ fn }) => fn.linkage !== 'internal' && fn.name === 'main');
  const mainKey = 'external:main';
  const mainIndex = functionIndexByKey.get(mainKey);
  if (mainIndex === undefined || !functionHasExternalDefinition.get(mainKey)) {
    const at = externalFunctions[0]?.fn.location ?? { file: entry, line: 1, column: 1 };
    failure('MISSING_MAIN', 'An external definition of main is required.', at);
  }
  const main = functions[mainIndex];
  const mainReturnType = unqualifiedType(main.returnType);
  const validNoArgs = mainReturnType === 'int' && main.parameters.length === 0 && !main.variadic && !!main.body;
  const mainArgv = main.parameters[1] ? unqualifiedType(main.parameters[1].type) : undefined;
  const mainArgvPointer = mainArgv && typeof mainArgv !== 'string' && mainArgv.kind === 'pointer' ? mainArgv : undefined;
  const mainArgvBase = mainArgvPointer ? unqualifiedType(mainArgvPointer.base) : undefined;
  const mainArgvCharPointer = mainArgvBase && typeof mainArgvBase !== 'string' && mainArgvBase.kind === 'pointer'
    ? unqualifiedType(mainArgvBase.base) : undefined;
  const validArgv = mainReturnType === 'int' && main.parameters.length === 2 && unqualifiedType(main.parameters[0].type) === 'int' &&
    !!mainArgvPointer && !!mainArgvBase && typeof mainArgvBase !== 'string' && mainArgvBase.kind === 'pointer' &&
    mainArgvCharPointer === 'char' && !main.variadic;
  if (!validNoArgs && !validArgv) failure('UNSUPPORTED_FEATURE', 'P4 supports int main(void) or int main(int, char **).', main.location);

  return { functions, globals, aggregates, enums, mainIndex, entry, translationUnit: entry, sourceChars: 0, tokenCount: 0 };
}
