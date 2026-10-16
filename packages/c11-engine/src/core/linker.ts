import { failure } from './internal.ts';
import type {
  AggregateDefinition, CType, FunctionCType, FunctionIR, GlobalObject, Location, ParsedProgram, ProgramIR,
} from './internal.ts';
import { analyze } from './parser.ts';
import { arrayOf, functionOf, isArray, isFunction, isInteger, isPointer, pointerTo } from './type-system.ts';
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
      if (global.tentative && isArray(global.type) && global.type.length === null) {
        global.type = arrayOf(global.type.element, 1);
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

  for (const [key, group] of functionGroups) {
    const conflictingObjects = globalGroups.get(key);
    if (conflictingObjects) {
      failure('CONFLICTING_TYPES', `«${group.declarations[0].fn.name}» declara tanto un objeto como una función.`, conflictingObjects.declarations[0].global.location);
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
        if (type.kind === 'pointer') {
          if (typeof type.base !== 'string') pending.push({ type: type.base, done: false });
        } else if (type.kind === 'array') {
          if (typeof type.element !== 'string') pending.push({ type: type.element, done: false });
        } else if (type.kind === 'function') {
          if (typeof type.returnType !== 'string') pending.push({ type: type.returnType, done: false });
          for (const parameter of type.parameters) if (typeof parameter !== 'string') pending.push({ type: parameter, done: false });
        }
        continue;
      }
      if (type.kind === 'aggregate') typeMemo.set(type, { kind: 'aggregate', id: typeUnions.find(type.id) });
      else if (type.kind === 'pointer') typeMemo.set(type, pointerTo(rewriteType(type.base), {
        ...(type.const === undefined ? {} : { const: type.const }),
        ...(type.restrict === undefined ? {} : { restrict: type.restrict }),
        ...(type.baseConst === undefined ? {} : { baseConst: type.baseConst }),
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
  const localGlobalIds = unitWork.map(() => new Map<number, string>());
  for (let unit = 0; unit < unitWork.length; unit++) {
    const parsed = unitWork[unit].parsed;
    for (const global of parsed.globals) {
      const key = global.symbolKey ?? symbolKey(global.linkage, global.translationUnit ?? parsed.translationUnit ?? entry, global.name);
      localGlobalIds[unit].set(global.id, key);
    }
    for (const fn of parsed.functions) if (fn.body) {
      visitObjectGraph(fn.body, (node) => {
        const value = node as Record<string, unknown>;
        if (value.kind === 'function' && typeof value.symbolKey === 'string') {
          if (!functionRefs.has(value.symbolKey)) functionRefs.set(value.symbolKey, value.location as Location);
        } else if (value.kind === 'call' && typeof value.symbolKey === 'string') {
          if (!functionRefs.has(value.symbolKey)) functionRefs.set(value.symbolKey, value.location as Location);
        } else if (value.kind === 'variable' && typeof value.globalBinding === 'number') {
          const key = localGlobalIds[unit].get(value.globalBinding);
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
  const functions: FunctionIR[] = [];
  for (const [key, group] of functionGroups) {
    const definitions = group.declarations.filter((item) => !!item.fn.body);
    if (definitions.length > 1) failure('REDEFINITION', `La función «${definitions[1].fn.name}» tiene más de una definición externa.`, definitions[1].fn.location);
    const definition = definitions[0];
    const builtin = definition ? undefined : group.declarations.find((item) => !!item.fn.builtin);
    const selected = definition ?? builtin;
    if (!selected) {
      const reference = functionRefs.get(key);
      if (reference) failure('UNDEFINED_FUNCTION', `La función «${group.declarations[0].fn.name}» no tiene definición en el programa.`, reference);
      continue;
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
      remapBindingsAndFunctions(fn.body, localGlobalFinalIds[unit], functionIndexByKey);
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
  if (mainIndex === undefined) {
    const at = externalFunctions[0]?.fn.location ?? { file: entry, line: 1, column: 1 };
    failure('MISSING_MAIN', 'Se requiere una definición externa de main.', at);
  }
  const main = functions[mainIndex];
  const validNoArgs = main.returnType === 'int' && main.parameters.length === 0 && !main.variadic && !!main.body;
  const validArgv = main.returnType === 'int' && main.parameters.length === 2 && main.parameters[0].type === 'int' &&
    isPointer(main.parameters[1].type) && isPointer(main.parameters[1].type.base) && main.parameters[1].type.base.base === 'char' && !main.variadic;
  if (!validNoArgs && !validArgv) failure('UNSUPPORTED_FEATURE', 'P4 admite int main(void) o int main(int, char **).', main.location);

  return { functions, globals, aggregates, mainIndex, entry, translationUnit: entry, sourceChars: 0, tokenCount: 0 };
}

function symbolKey(linkage: FunctionIR['linkage'] | GlobalObject['linkage'], unit: string, name: string): string {
  return linkage === 'internal' ? `internal:${unit}:${name}` : `external:${name}`;
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
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'pointer' && right.kind === 'pointer') return !!left.const === !!right.const && !!left.restrict === !!right.restrict &&
    !!left.baseConst === !!right.baseConst && compatibleAcross(left.base, right.base, definitions, seen);
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
      return member.name === other.name && !!member.isConst === !!other.isConst && compatibleAcross(member.type, other.type, definitions, seen);
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
  if (type === 'float') return false;
  if (isInteger(type)) return promote(type) === type;
  return !isArray(type) && !isFunction(type);
}

function defaultArgumentType(type: CType): CType {
  if (type === 'float') return 'double';
  if (isInteger(type)) return promote(type);
  return unqualifiedParameter(type);
}

function unqualifiedParameter(type: CType): CType {
  return isPointer(type) ? pointerTo(type.base, { baseConst: type.baseConst }) : type;
}

function compositeCompatibleType(left: CType, right: CType): CType | undefined {
  if (typeof left === 'string' || typeof right === 'string') return left === right ? left : undefined;
  if (left.kind !== right.kind) return undefined;
  if (left.kind === 'aggregate' && right.kind === 'aggregate') return left.id === right.id ? left : undefined;
  if (left.kind === 'array' && right.kind === 'array') {
    if (left.length !== null && right.length !== null && left.length !== right.length) return undefined;
    const element = compositeCompatibleType(left.element, right.element);
    return element ? arrayOf(element, left.length ?? right.length) : undefined;
  }
  if (left.kind === 'pointer' && right.kind === 'pointer') {
    if (!!left.const !== !!right.const || !!left.restrict !== !!right.restrict || !!left.baseConst !== !!right.baseConst) return undefined;
    const base = compositeCompatibleType(left.base, right.base);
    return base ? pointerTo(base, {
      ...(left.const === undefined ? {} : { const: left.const }),
      ...(left.restrict === undefined ? {} : { restrict: left.restrict }),
      ...(left.baseConst === undefined ? {} : { baseConst: left.baseConst }),
    }) : undefined;
  }
  if (left.kind === 'function' && right.kind === 'function') {
    if (left.prototype === false || right.prototype === false) {
      const preferred = left.prototype === false ? right : left;
      return functionOf(preferred.returnType, preferred.parameters, !!preferred.variadic, preferred.prototype !== false);
    }
    if (left.variadic !== right.variadic || left.parameters.length !== right.parameters.length) return undefined;
    const returnType = compositeCompatibleType(left.returnType, right.returnType);
    if (!returnType) return undefined;
    const parameters: CType[] = [];
    for (let index = 0; index < left.parameters.length; index++) {
      const parameter = compositeCompatibleType(unqualifiedParameter(left.parameters[index]), unqualifiedParameter(right.parameters[index]));
      if (!parameter) return undefined;
      parameters.push(parameter);
    }
    return functionOf(returnType, parameters, !!left.variadic, true);
  }
  return undefined;
}

function unifyFunctionTypes(left: FunctionIR, right: FunctionIR, definitions: ReadonlyMap<number, AggregateDefinition>, unions: TypeUnions): void {
  unifyTypes(left.returnType, right.returnType, definitions, unions);
  if (left.prototype !== false && right.prototype !== false) {
    left.parameters.forEach((parameter, index) => unifyTypes(parameter.type, right.parameters[index].type, definitions, unions));
  } else {
    const oldStyle = left.oldStyle && left.body ? left : right.oldStyle && right.body ? right : undefined;
    const prototype = left.prototype !== false ? left : right.prototype !== false ? right : undefined;
    if (oldStyle && prototype && oldStyle.parameters.length === prototype.parameters.length) {
      oldStyle.parameters.forEach((parameter, index) => unifyTypes(defaultArgumentType(parameter.type), prototype.parameters[index].type, definitions, unions));
    }
  }
}

function unifyTypes(left: CType, right: CType, definitions: ReadonlyMap<number, AggregateDefinition>, unions: TypeUnions, seen = new Set<string>()): void {
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
  if (typeof type === 'string') return type;
  if (type.kind === 'aggregate') return `a${type.id}`;
  if (type.kind === 'pointer') return `p${type.const ? 'c' : ''}${type.baseConst ? 'b' : ''}${type.restrict ? 'r' : ''}${typeKey(type.base)}`;
  if (type.kind === 'array') return `y${type.length ?? ''}:${typeKey(type.element)}`;
  return `f${type.prototype === false ? 'n' : 'p'}${type.variadic ? 'v' : ''}:${typeKey(type.returnType)}:${type.parameters.map(typeKey).join(',')}`;
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
  return candidate.kind === 'pointer' && 'base' in candidate || candidate.kind === 'array' && 'element' in candidate ||
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

function remapBindingsAndFunctions(root: object, globalIds: ReadonlyMap<number, number>, functionIndices: ReadonlyMap<string, number>): void {
  visitObjectGraph(root, (node) => {
    const value = node as Record<string, unknown>;
    if (value.kind === 'variable' && typeof value.globalBinding === 'number') {
      const mapped = globalIds.get(value.globalBinding);
      if (mapped !== undefined) value.globalBinding = mapped;
    }
    if ((value.kind === 'function' || value.kind === 'call') && typeof value.symbolKey === 'string') {
      const mapped = functionIndices.get(value.symbolKey);
      if (mapped !== undefined) value.functionIndex = mapped;
    }
  });
}
