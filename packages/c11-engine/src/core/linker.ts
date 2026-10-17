import { failure } from './internal.ts';
import type {
  AggregateDefinition, CType, FunctionCType, FunctionIR, GlobalObject, Location, ParsedProgram, ProgramIR,
} from './internal.ts';
import { analyze } from './parser.ts';
import {
  arrayOf, functionOf, isArray, isFunction, isInteger, pointerTo,
  isModifiableObject, pointedToType, pointerType, qualifyType, qualifiersOf, unqualifiedType,
} from './type-system.ts';
import { promote } from './numeric.ts';

type UnitWork = { parsed: ParsedProgram; synthetic?: FunctionIR };
type FunctionDeclaration = { unit: number; fn: FunctionIR };
type GlobalDeclaration = { unit: number; global: GlobalObject };
type SymbolGroup<T> = { key: string; declarations: T[] };

/** Resolve C external and internal identifiers after each source file is parsed independently. */
export function linkTranslationUnits(units: readonly ParsedProgram[], entry: string): ProgramIR {
  if (!units.length) failure('INVALID_PROJECT', 'El programa no contiene unidades de traducción.', { file: entry, line: 1, column: 1 });
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
      failure('CONFLICTING_TYPES', `«${group.declarations[0].fn.name}» declara tanto un objeto como una función.`, conflictingObjects.declarations[0].global.location);
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
          failure('TYPE_ERROR', 'Una definición inline con enlace externo no puede definir un objeto modificable static o _Thread_local.', binding.location);
        }
      }

      visitObjectGraph(fn.body, (node) => {
        const value = node as Record<string, unknown>;
        if (value.kind === 'variable' && typeof value.globalBinding === 'number') {
          const referencedKey = localGlobalIds[unit].get(value.globalBinding);
          const target = referencedKey ? globalGroups.get(referencedKey) : undefined;
          if (target?.declarations.some(({ global }) => global.linkage === 'internal')) {
            failure('TYPE_ERROR', 'Una definición inline con enlace externo no puede referirse a un identificador con enlace interno.', value.location as Location);
          }
        }
        if ((value.kind === 'function' || value.kind === 'call') && typeof value.symbolKey === 'string') {
          const referenced = functionGroups.get(value.symbolKey);
          if (referenced?.declarations.some(({ fn: target }) => target.linkage === 'internal')) {
            failure('TYPE_ERROR', 'Una definición inline con enlace externo no puede referirse a un identificador con enlace interno.', value.location as Location);
          }
        }
      });
    }
  }

  const typeUnions = new TypeUnions();
  for (const group of functionGroups.values()) {
    const first = group.declarations[0];
    for (const item of group.declarations.slice(1)) {
      if (!compatibleFunctionDeclarations(first.fn, item.fn, aggregateDefinitions)) {
        failure('CONFLICTING_TYPES', `Declaraciones incompatibles de la función «${first.fn.name}».`, item.fn.location);
      }
      unifyFunctionTypes(first.fn, item.fn, aggregateDefinitions, typeUnions);
    }
  }
  for (const group of globalGroups.values()) {
    const first = group.declarations[0];
    for (const item of group.declarations.slice(1)) {
      if (!!first.global.isConst !== !!item.global.isConst ||
          !!first.global.threadLocal !== !!item.global.threadLocal ||
          !compatibleAcross(first.global.type, item.global.type, aggregateDefinitions)) {
        failure('CONFLICTING_TYPES', `Declaraciones incompatibles del objeto «${first.global.name}».`, item.global.location);
      }
      unifyTypes(first.global.type, item.global.type, aggregateDefinitions, typeUnions);
    }
  }

  const typeMemo = new Map<object, CType>();
  const rewriteType = (root: CType): CType => {
    if (typeof root === 'string') return root;
    const prior = typeMemo.get(root);
    if (prior) return prior;
    const pending: { type: Exclude<CType, string>; done: boolean }[] = [{ type: root, done: false }];
    while (pending.length) {
      const work = pending.pop()!;
      const type = work.type;
      if (typeMemo.has(type)) continue;
      if (!work.done) {
        pending.push({ type, done: true });
        if (type.kind === 'qualified') {
          if (typeof type.base !== 'string') pending.push({ type: type.base, done: false });
        } else if (type.kind === 'pointer') {
          if (typeof type.base !== 'string') pending.push({ type: type.base, done: false });
        } else if (type.kind === 'array') {
          if (typeof type.element !== 'string') pending.push({ type: type.element, done: false });
        } else if (type.kind === 'function') {
          if (typeof type.returnType !== 'string') pending.push({ type: type.returnType, done: false });
          for (const parameter of type.parameters) if (typeof parameter !== 'string') pending.push({ type: parameter, done: false });
        }
        continue;
      }
      if (type.kind === 'qualified') typeMemo.set(type, qualifyType(rewriteType(type.base), type.qualifiers));
      else if (type.kind === 'aggregate') typeMemo.set(type, { kind: 'aggregate', id: typeUnions.find(type.id) });
      else if (type.kind === 'pointer') typeMemo.set(type, pointerTo(rewriteType(type.base), {
        ...(type.const === undefined ? {} : { const: type.const }),
        ...(type.volatile === undefined ? {} : { volatile: type.volatile }),
        ...(type.restrict === undefined ? {} : { restrict: type.restrict }),
        ...(type.baseConst === undefined ? {} : { baseConst: type.baseConst }),
        ...(type.baseVolatile === undefined ? {} : { baseVolatile: type.baseVolatile }),
      }));
      else if (type.kind === 'array') typeMemo.set(type, arrayOf(rewriteType(type.element), type.length));
      else typeMemo.set(type, functionOf(rewriteType(type.returnType), type.parameters.map(rewriteType), !!type.variadic, type.prototype !== false));
    }
    return typeMemo.get(root)!;
  };

  for (const { parsed } of unitWork) {
    for (const definition of parsed.aggregates) {
      definition.id = typeUnions.find(definition.id);
      for (const member of definition.members) member.type = rewriteType(member.type);
    }
    rewriteObjectGraph(parsed.functions, rewriteType);
    rewriteObjectGraph(parsed.globals, rewriteType);
  }

  const aggregatesById = new Map<number, AggregateDefinition>();
  for (const { parsed } of unitWork) for (const candidate of parsed.aggregates) {
    const prior = aggregatesById.get(candidate.id);
    if (!prior || !prior.complete && candidate.complete) aggregatesById.set(candidate.id, candidate);
  }
  const aggregates = [...aggregatesById.values()];

  const functionRefs = new Map<string, Location>();
  const globalRefs = new Map<string, Location>();
  for (let unit = 0; unit < unitWork.length; unit++) {
    const parsed = unitWork[unit].parsed;
    for (const fn of parsed.functions) if (fn.body) {
      const bindingGlobalIds = new Map<number, number>();
      for (const binding of fn.bindings) {
        if (binding.globalBinding !== undefined) bindingGlobalIds.set(binding.id, binding.globalBinding);
      }
      visitObjectGraph(fn.body, (node) => {
        const value = node as Record<string, unknown>;
        if (value.kind === 'function' && typeof value.symbolKey === 'string') {
          if (!functionRefs.has(value.symbolKey)) functionRefs.set(value.symbolKey, value.location as Location);
        } else if (value.kind === 'call' && typeof value.symbolKey === 'string') {
          if (!functionRefs.has(value.symbolKey)) functionRefs.set(value.symbolKey, value.location as Location);
        } else if (value.kind === 'variable' && typeof value.globalBinding === 'number') {
          const key = localGlobalIds[unit].get(value.globalBinding);
          if (key && !globalRefs.has(key)) globalRefs.set(key, value.location as Location);
        } else if (value.kind === 'variable' && typeof value.binding === 'number') {
          const globalBinding = bindingGlobalIds.get(value.binding);
          const key = globalBinding === undefined ? undefined : localGlobalIds[unit].get(globalBinding);
          if (key && !globalRefs.has(key)) globalRefs.set(key, value.location as Location);
        }
      });
    }
    for (const global of parsed.globals) if (global.initializer) {
      visitObjectGraph(global.initializer, (node) => {
        const value = node as Record<string, unknown>;
        if (value.kind === 'function' && typeof value.symbolKey === 'string') {
          if (!functionRefs.has(value.symbolKey)) functionRefs.set(value.symbolKey, value.location as Location);
        } else if (value.kind === 'variable' && typeof value.globalBinding === 'number') {
          const key = localGlobalIds[unit].get(value.globalBinding);
          if (key && !globalRefs.has(key)) globalRefs.set(key, value.location as Location);
        }
      });
    }
  }

  const functionIndexByKey = new Map<string, number>();
  const functionHasExternalDefinition = new Map<string, boolean>();
  const functions: FunctionIR[] = [];
  for (const [key, group] of functionGroups) {
    const definitions = group.declarations.filter((item) => !!item.fn.body);
    const externalDefinitions = definitions.filter((definition) => isExternalFunctionDefinition(definition, group));
    if (externalDefinitions.length > 1) {
      failure('REDEFINITION', `La función «${externalDefinitions[1].fn.name}» tiene más de una definición externa.`, externalDefinitions[1].fn.location);
    }
    const externalDefinition = externalDefinitions[0];
    const builtin = definitions.length ? undefined : group.declarations.find((item) => !!item.fn.builtin);
    // An external-linkage inline definition may provide a body for optimization in
    // its own translation unit, but it never replaces the required external definition.
    const selected = externalDefinition ?? definitions[0] ?? builtin;
    functionHasExternalDefinition.set(key, !!externalDefinition || !!builtin);
    if (!selected) {
      const reference = functionRefs.get(key);
      if (reference) failure('UNDEFINED_FUNCTION', `La función «${group.declarations[0].fn.name}» no tiene definición en el programa.`, reference);
      continue;
    }
    const reference = functionRefs.get(key);
    if (reference && !externalDefinition && !builtin) {
      failure('UNDEFINED_FUNCTION', `La función «${group.declarations[0].fn.name}» no tiene una definición externa en el programa.`, reference);
    }
    const index = functions.length;
    functions.push({ ...selected.fn, noreturn: group.declarations.some((item) => !!item.fn.noreturn) });
    functionIndexByKey.set(key, index);
  }

  const globalIndexByKey = new Map<string, number>();
  const globals: GlobalObject[] = [];
  for (const [key, group] of globalGroups) {
    const definitions = group.declarations.filter((item) => !!item.global.initializer || !!item.global.tentative);
    if (definitions.length > 1) failure('REDEFINITION', `El objeto «${definitions[1].global.name}» tiene más de una definición externa.`, definitions[1].global.location);
    const selected = definitions[0];
    if (!selected) {
      const reference = globalRefs.get(key);
      if (reference) failure('UNDEFINED_OBJECT', `El objeto externo «${group.declarations[0].global.name}» no tiene definición en el programa.`, reference);
      continue;
    }
    let combinedType = selected.global.type;
    for (const declaration of group.declarations) {
      const composite = compositeCompatibleType(combinedType, declaration.global.type);
      if (!composite) failure('CONFLICTING_TYPES', `Declaraciones incompatibles del objeto «${selected.global.name}».`, declaration.global.location);
      combinedType = composite;
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
    failure('MISSING_MAIN', 'Se requiere una definición externa de main.', at);
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
  if (!validNoArgs && !validArgv) failure('UNSUPPORTED_FEATURE', 'P4 admite int main(void) o int main(int, char **).', main.location);

  return { functions, globals, aggregates, mainIndex, entry, translationUnit: entry, sourceChars: 0, tokenCount: 0 };
}

function symbolKey(linkage: FunctionIR['linkage'] | GlobalObject['linkage'], unit: string, name: string): string {
  return linkage === 'internal' ? `internal:${unit}:${name}` : `external:${name}`;
}

function isExternalFunctionDefinition(
  definition: FunctionDeclaration,
  group: SymbolGroup<FunctionDeclaration>,
): boolean {
  if (definition.fn.linkage === 'internal') return true;
  const declarationsInUnit = group.declarations.filter((item) => item.unit === definition.unit);
  const isInlineDefinition = declarationsInUnit.length > 0 && declarationsInUnit.every(({ fn }) => fn.inline && !fn.extern);
  return !isInlineDefinition;
}

function isModifiableInlineStaticObject(type: CType, aggregates: readonly AggregateDefinition[]): boolean {
  if (qualifiersOf(type).const) return false;
  const base = unqualifiedType(type);
  if (typeof base !== 'string' && base.kind === 'array') {
    return isModifiableInlineStaticObject(base.element, aggregates);
  }
  if (typeof base !== 'string' && base.kind === 'aggregate') {
    const definition = aggregates.find((candidate) => candidate.id === base.id);
    return !!definition?.complete && definition.members.some((member) => isModifiableInlineStaticObject(member.type, aggregates));
  }
  return isModifiableObject(type, aggregates);
}

function groupByKey<T>(groups: Map<string, SymbolGroup<T>>, key: string): SymbolGroup<T> {
  let group = groups.get(key);
  if (!group) { group = { key, declarations: [] }; groups.set(key, group); }
  return group;
}

function functionType(fn: FunctionIR): FunctionCType {
  return functionOf(fn.returnType, fn.parameters.map((parameter) => parameter.type), !!fn.variadic, fn.prototype !== false);
}

function compatibleFunctionDeclarations(left: FunctionIR, right: FunctionIR, definitions: ReadonlyMap<number, AggregateDefinition>): boolean {
  if (!compatibleAcross(functionType(left), functionType(right), definitions)) return false;
  for (const definition of [left, right]) {
    if (!definition.oldStyle || !definition.body) continue;
    const prototype = definition === left ? right : left;
    if (prototype.prototype === false) continue;
    if (definition.parameters.length !== prototype.parameters.length || prototype.variadic) return false;
    for (let index = 0; index < definition.parameters.length; index++) {
      const promoted = defaultArgumentType(definition.parameters[index].type);
      if (!compatibleAcross(unqualifiedParameter(promoted), unqualifiedParameter(prototype.parameters[index].type), definitions)) return false;
    }
  }
  return true;
}

function compatibleAcross(left: CType, right: CType, definitions: ReadonlyMap<number, AggregateDefinition>, seen = new Set<string>()): boolean {
  if (!sameQualifiers(qualifiersOf(left), qualifiersOf(right))) return false;
  left = unqualifiedType(left);
  right = unqualifiedType(right);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'pointer' && right.kind === 'pointer') {
    const leftBase = pointedToType(left) ?? left.base;
    const rightBase = pointedToType(right) ?? right.base;
    return compatibleAcross(leftBase, rightBase, definitions, seen);
  }
  if (left.kind === 'array' && right.kind === 'array') return (left.length === null || right.length === null || left.length === right.length) &&
    compatibleAcross(left.element, right.element, definitions, seen);
  if (left.kind === 'aggregate' && right.kind === 'aggregate') {
    if (left.id === right.id) return true;
    const key = `${left.id}:${right.id}`;
    if (seen.has(key)) return true;
    const a = definitions.get(left.id), b = definitions.get(right.id);
    if (!a || !b || a.kind !== b.kind || !a.tag || a.tag !== b.tag) return false;
    if (!a.complete || !b.complete) return true;
    if (a.members.length !== b.members.length) return false;
    seen.add(key);
    return a.members.every((member, index) => {
      const other = b.members[index];
      return member.name === other.name && !!member.isConst === !!other.isConst &&
        !!member.flexibleArray === !!other.flexibleArray && !!member.unnamedBitField === !!other.unnamedBitField &&
        (member.bitField?.width ?? null) === (other.bitField?.width ?? null) &&
        compatibleAcross(member.type, other.type, definitions, seen);
    });
  }
  if (left.kind === 'function' && right.kind === 'function') {
    if (!compatibleAcross(left.returnType, right.returnType, definitions, seen)) return false;
    if (left.prototype !== false && right.prototype !== false) {
      return left.variadic === right.variadic && left.parameters.length === right.parameters.length &&
        left.parameters.every((parameter, index) => compatibleAcross(unqualifiedParameter(parameter), unqualifiedParameter(right.parameters[index]), definitions, seen));
    }
    if (left.prototype === false && right.prototype === false) return true;
    const prototype = left.prototype === false ? right : left;
    return !prototype.variadic && prototype.parameters.every((parameter) => stableAfterDefaultPromotion(parameter));
  }
  return false;
}

function stableAfterDefaultPromotion(type: CType): boolean {
  type = unqualifiedParameter(type);
  if (type === 'float') return false;
  if (isInteger(type)) return promote(type) === type;
  return !isArray(type) && !isFunction(type);
}

function defaultArgumentType(type: CType): CType {
  type = unqualifiedParameter(type);
  if (type === 'float') return 'double';
  if (isInteger(type)) return promote(type);
  return type;
}

function unqualifiedParameter(type: CType): CType {
  type = unqualifiedType(type);
  const pointer = pointerType(type);
  return pointer ? pointerTo(pointedToType(pointer) ?? pointer.base) : type;
}

function compositeCompatibleType(left: CType, right: CType): CType | undefined {
  const leftQualifiers = qualifiersOf(left);
  if (!sameQualifiers(leftQualifiers, qualifiersOf(right))) return undefined;
  const qualified = (type: CType | undefined): CType | undefined =>
    type === undefined ? undefined : qualifyType(type, leftQualifiers);
  const leftBase = unqualifiedType(left);
  const rightBase = unqualifiedType(right);
  if (typeof leftBase === 'string' || typeof rightBase === 'string') {
    return leftBase === rightBase ? qualified(leftBase) : undefined;
  }
  if (leftBase.kind !== rightBase.kind) return undefined;
  if (leftBase.kind === 'aggregate' && rightBase.kind === 'aggregate') {
    return leftBase.id === rightBase.id ? qualified(leftBase) : undefined;
  }
  if (leftBase.kind === 'array' && rightBase.kind === 'array') {
    if (leftBase.length !== null && rightBase.length !== null && leftBase.length !== rightBase.length) return undefined;
    const element = compositeCompatibleType(leftBase.element, rightBase.element);
    return qualified(element ? arrayOf(element, leftBase.length ?? rightBase.length) : undefined);
  }
  if (leftBase.kind === 'pointer' && rightBase.kind === 'pointer') {
    const base = compositeCompatibleType(pointedToType(leftBase) ?? leftBase.base, pointedToType(rightBase) ?? rightBase.base);
    return qualified(base ? pointerTo(base) : undefined);
  }
  if (leftBase.kind === 'function' && rightBase.kind === 'function') {
    if (leftBase.prototype === false || rightBase.prototype === false) {
      const preferred = leftBase.prototype === false ? rightBase : leftBase;
      return qualified(functionOf(preferred.returnType, preferred.parameters, !!preferred.variadic, preferred.prototype !== false));
    }
    if (leftBase.variadic !== rightBase.variadic || leftBase.parameters.length !== rightBase.parameters.length) return undefined;
    const returnType = compositeCompatibleType(leftBase.returnType, rightBase.returnType);
    if (!returnType) return undefined;
    const parameters: CType[] = [];
    for (let index = 0; index < leftBase.parameters.length; index++) {
      const parameter = compositeCompatibleType(unqualifiedParameter(leftBase.parameters[index]), unqualifiedParameter(rightBase.parameters[index]));
      if (!parameter) return undefined;
      parameters.push(parameter);
    }
    return qualified(functionOf(returnType, parameters, !!leftBase.variadic, true));
  }
  return undefined;
}

function sameQualifiers(left: ReturnType<typeof qualifiersOf>, right: ReturnType<typeof qualifiersOf>): boolean {
  return !!left.const === !!right.const && !!left.volatile === !!right.volatile && !!left.restrict === !!right.restrict;
}

function unifyFunctionTypes(left: FunctionIR, right: FunctionIR, definitions: ReadonlyMap<number, AggregateDefinition>, unions: TypeUnions): void {
  unifyTypes(left.returnType, right.returnType, definitions, unions);
  if (left.prototype !== false && right.prototype !== false) {
    left.parameters.forEach((parameter, index) => unifyTypes(unqualifiedParameter(parameter.type), unqualifiedParameter(right.parameters[index].type), definitions, unions));
  } else {
    const oldStyle = left.oldStyle && left.body ? left : right.oldStyle && right.body ? right : undefined;
    const prototype = left.prototype !== false ? left : right.prototype !== false ? right : undefined;
    if (oldStyle && prototype && oldStyle.parameters.length === prototype.parameters.length) {
      oldStyle.parameters.forEach((parameter, index) => unifyTypes(defaultArgumentType(parameter.type), prototype.parameters[index].type, definitions, unions));
    }
  }
}

function unifyTypes(left: CType, right: CType, definitions: ReadonlyMap<number, AggregateDefinition>, unions: TypeUnions, seen = new Set<string>()): void {
  if (!sameQualifiers(qualifiersOf(left), qualifiersOf(right))) return;
  left = unqualifiedType(left);
  right = unqualifiedType(right);
  if (typeof left === 'string' || typeof right === 'string' || left.kind !== right.kind) return;
  const pair = `${typeKey(left)}:${typeKey(right)}`;
  if (seen.has(pair)) return;
  seen.add(pair);
  if (left.kind === 'pointer' && right.kind === 'pointer') unifyTypes(left.base, right.base, definitions, unions, seen);
  else if (left.kind === 'array' && right.kind === 'array') unifyTypes(left.element, right.element, definitions, unions, seen);
  else if (left.kind === 'aggregate' && right.kind === 'aggregate') {
    if (left.id === right.id || !compatibleAcross(left, right, definitions)) return;
    unions.union(left.id, right.id);
    const a = definitions.get(left.id), b = definitions.get(right.id);
    if (a?.complete && b?.complete) a.members.forEach((member, index) => unifyTypes(member.type, b.members[index].type, definitions, unions, seen));
  } else if (left.kind === 'function' && right.kind === 'function') {
    unifyTypes(left.returnType, right.returnType, definitions, unions, seen);
    if (left.parameters.length === right.parameters.length) left.parameters.forEach((parameter, index) => unifyTypes(parameter, right.parameters[index], definitions, unions, seen));
  }
}

function typeKey(type: CType): string {
  const qualifiers = qualifiersOf(type);
  const qualifierKey = `${qualifiers.const ? 'c' : ''}${qualifiers.volatile ? 'v' : ''}${qualifiers.restrict ? 'r' : ''}`;
  type = unqualifiedType(type);
  const prefix = qualifierKey ? `q${qualifierKey}:` : '';
  if (typeof type === 'string') return `${prefix}${type}`;
  if (type.kind === 'aggregate') return `${prefix}a${type.id}`;
  if (type.kind === 'pointer') return `${prefix}p${type.baseConst ? 'b' : ''}${type.baseVolatile ? 'v' : ''}${typeKey(type.base)}`;
  if (type.kind === 'array') return `${prefix}y${type.length ?? ''}:${typeKey(type.element)}`;
  if (type.kind === 'function') return `${prefix}f${type.prototype === false ? 'n' : 'p'}${type.variadic ? 'v' : ''}:${typeKey(type.returnType)}:${type.parameters.map(typeKey).join(',')}`;
  return `${prefix}q${typeKey(type.base)}`;
}

class TypeUnions {
  private readonly parents = new Map<number, number>();
  find(value: number): number {
    const parent = this.parents.get(value);
    if (parent === undefined) { this.parents.set(value, value); return value; }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents.set(value, root);
    return root;
  }
  union(left: number, right: number): void {
    const a = this.find(left), b = this.find(right);
    if (a === b) return;
    const canonical = Math.min(a, b), other = Math.max(a, b);
    this.parents.set(other, canonical);
  }
}

function isTypeDescriptor(value: unknown): value is Exclude<CType, string> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'qualified' && 'base' in candidate || candidate.kind === 'pointer' && 'base' in candidate || candidate.kind === 'array' && 'element' in candidate ||
    candidate.kind === 'aggregate' && typeof candidate.id === 'number' || candidate.kind === 'function' && 'returnType' in candidate;
}

function rewriteObjectGraph(root: object, rewriteType: (type: CType) => CType): void {
  visitObjectGraph(root, (_node, parent, key) => {
    if (!parent || key === undefined) return;
    const value = (parent as Record<string, unknown>)[key];
    if (isTypeDescriptor(value)) (parent as Record<string, unknown>)[key] = rewriteType(value);
  });
}

function visitObjectGraph(root: object, visit: (value: object, parent?: object, key?: string | number) => void): void {
  const seen = new Set<object>();
  const pending: { value: object; parent?: object; key?: string | number }[] = [{ value: root }];
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    visit(current.value, current.parent, current.key);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        const child = current.value[index];
        if (child && typeof child === 'object' && !isTypeDescriptor(child)) pending.push({ value: child, parent: current.value, key: index });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (child && typeof child === 'object' && !isTypeDescriptor(child)) pending.push({ value: child, parent: current.value, key });
    }
  }
}

function remapBindingsAndFunctions(
  root: object,
  globalIds: ReadonlyMap<number, number>,
  functionIndices: ReadonlyMap<string, number>,
  bindingGlobals: ReadonlyMap<number, number> = new Map(),
): void {
  visitObjectGraph(root, (node) => {
    const value = node as Record<string, unknown>;
    if (value.kind === 'variable') {
      let mappedLocalExtern = false;
      if (typeof value.binding === 'number') {
        const mappedBinding = bindingGlobals.get(value.binding);
        if (mappedBinding !== undefined) {
          value.globalBinding = mappedBinding;
          delete value.binding;
          mappedLocalExtern = true;
        }
      }
      if (!mappedLocalExtern && typeof value.globalBinding === 'number') {
        const mapped = globalIds.get(value.globalBinding);
        if (mapped !== undefined) value.globalBinding = mapped;
      }
    }
    if ((value.kind === 'function' || value.kind === 'call') && typeof value.symbolKey === 'string') {
      const mapped = functionIndices.get(value.symbolKey);
      if (mapped !== undefined) value.functionIndex = mapped;
    }
  });
}
