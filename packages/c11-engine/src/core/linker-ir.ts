import type { CType, Location, ParsedProgram } from './internal.ts';

function isTypeDescriptor(value: unknown): value is Exclude<CType, string> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'qualified' && 'base' in candidate || candidate.kind === 'pointer' && 'base' in candidate || candidate.kind === 'array' && 'element' in candidate ||
    candidate.kind === 'aggregate' && typeof candidate.id === 'number' || candidate.kind === 'enum' && typeof candidate.id === 'number' || candidate.kind === 'function' && 'returnType' in candidate;
}

export function rewriteObjectGraph(root: object, rewriteType: (type: CType) => CType): void {
  visitObjectGraph(root, (_node, parent, key) => {
    if (!parent || key === undefined) return;
    const value = (parent as Record<string, unknown>)[key];
    if (isTypeDescriptor(value)) (parent as Record<string, unknown>)[key] = rewriteType(value);
  });
}

export function visitObjectGraph(root: object, visit: (value: object, parent?: object, key?: string | number) => void): void {
  const seen = new Set<object>();
  const pending: { value: object; parent?: object; key?: string | number }[] = [{ value: root }];
  while (pending.length) {
    const current = pending.pop()!;
    const typeDescriptor = isTypeDescriptor(current.value);
    // A shared descriptor may be referenced by several fields. Each field
    // needs replacement, even though the descriptor itself is a visited leaf.
    if (seen.has(current.value) && !typeDescriptor) continue;
    if (!typeDescriptor) seen.add(current.value);
    visit(current.value, current.parent, current.key);
    // Type descriptors are replaceable leaves: callers that rewrite them must
    // see the descriptor as a child, while rewriteType handles its own graph.
    if (typeDescriptor) continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        const child = current.value[index];
        if (child && typeof child === 'object') pending.push({ value: child, parent: current.value, key: index });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (child && typeof child === 'object') pending.push({ value: child, parent: current.value, key });
    }
  }
}

export function collectSymbolReferences(
  unitWork: readonly { parsed: ParsedProgram }[],
  localGlobalIds: readonly ReadonlyMap<number, string>[],
): { functionRefs: Map<string, Location>; globalRefs: Map<string, Location> } {
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

  return { functionRefs, globalRefs };
}

export function remapBindingsAndFunctions(
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
