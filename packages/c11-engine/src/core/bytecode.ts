import { failure } from './internal.ts';
import type { Binding, CValue, Expression, FunctionIR, Initializer, Location, Statement } from './internal.ts';

export interface Scope { id: number; bindings: Binding[]; location: Location; name: string }
export type Instruction = { location: Location; path: Scope[] } & (
  | { op: 'enter'; scope: Scope }
  | { op: 'leave' }
  | { op: 'tick' }
  | { op: 'declaration'; binding: number; initializer?: Initializer }
  | { op: 'expression'; value: Expression }
  | { op: 'return'; value?: Expression }
  | { op: 'branch'; condition: Expression; target: number }
  | { op: 'jump'; target: number }
  | { op: 'switch'; value: Expression; cases: { value: CValue; target: number }[]; target: number }
);
export interface CompiledFunction { fn: FunctionIR; code: Instruction[] }

/** Explicit work stack: compiling deeply nested valid C never recurses in JS. */
export function compile(fn: FunctionIR): CompiledFunction {
  const code: Instruction[] = [];
  let path: Scope[] = [];
  let nextScope = 0;
  const work: (() => void)[] = [];
  const labels = new Map<string, number>();
  const gotos: { instruction: Extract<Instruction, { op: 'jump' }>; target: string }[] = [];
  type Control = { kind: 'loop' | 'switch'; breaks: Extract<Instruction, { op: 'jump' }>[]; continues: Extract<Instruction, { op: 'jump' }>[]; dispatch?: Extract<Instruction, { op: 'switch' }>; hasDefault?: boolean };
  const controls: Control[] = [];
  const emit = <T extends Instruction['op']>(op: T, location: Location, extra: Omit<Extract<Instruction, { op: T }>, 'op' | 'location' | 'path'>) => {
    const instruction = { op, location, path: path.slice(), ...extra } as Extract<Instruction, { op: T }>;
    code.push(instruction);
    return instruction;
  };
  const jump = (at: Location) => emit('jump', at, { target: -1 });
  const enter = (ids: number[], at: Location, name: string) => {
    const scope = { id: nextScope++, bindings: ids.map(id => fn.bindings[id]), location: at, name };
    emit('enter', at, { scope }); path.push(scope);
  };
  const leave = (at: Location) => { emit('leave', at, {}); path.pop(); };
  const scheduleScoped = (node: Statement, name: string): void => {
    // A compound substatement is already the C block for this branch/body.
    // Reuse it as one scope instead of wrapping it in a second empty scope.
    if (node.kind === 'block') { schedule(node, name); return; }
    // Keep the existing per-visit runtime lifetime for unbraced substatements.
    enter([], node.location, name);
    work.push(() => leave(node.location));
    work.push(() => schedule(node));
  };
  const schedule = (node: Statement, scopeName?: string): void => {
    if (node.kind === 'block') {
      const ids = node === fn.body ? [...new Set([...fn.parameters.map(parameter => parameter.binding!), ...(node.bindings ?? [])])] : node.bindings ?? [];
      enter(ids, node.location, node === fn.body ? fn.name : scopeName ?? 'bloque');
      work.push(() => leave(node.endLocation));
      for (let index = node.statements.length - 1; index >= 0; index--) work.push(() => schedule(node.statements[index]));
    } else if (node.kind === 'sequence') {
      for (let index = node.statements.length - 1; index >= 0; index--) work.push(() => schedule(node.statements[index]));
    } else if (node.kind === 'declaration') {
      emit('declaration', node.location, { binding: node.binding!, initializer: node.initializer });
    } else if (node.kind === 'expression' || node.kind === 'return') {
      if (node.kind === 'expression') emit('expression', node.location, { value: node.value });
      else emit('return', node.location, { value: node.value });
    } else if (node.kind === 'if') {
      const branch = emit('branch', node.location, { condition: node.condition, target: -1 });
      work.push(() => {
        if (node.else) {
          const done = jump(node.location);
          branch.target = code.length;
          work.push(() => { done.target = code.length; });
          work.push(() => scheduleScoped(node.else!, 'else'));
        } else branch.target = code.length;
      });
      work.push(() => scheduleScoped(node.then, node.scopeName));
    } else if (node.kind === 'while' || node.kind === 'do' || node.kind === 'for') {
      const control: Control = { kind: 'loop', breaks: [], continues: [] };
      if (node.kind === 'for') enter(node.bindings ?? [], node.location, node.scopeName);
      controls.push(control);
      const startLoop = () => {
        const start = code.length;
        const branch = node.kind === 'while' || (node.kind === 'for' && node.condition)
          ? emit('branch', node.location, { condition: node.condition!, target: -1 }) : undefined;
        work.push(() => {
          const continueTarget = node.kind === 'while' ? start : code.length;
          if (node.kind === 'for' && node.increment) emit('expression', node.increment.location, { value: node.increment });
          if (node.kind === 'do') {
            const end = emit('branch', node.location, { condition: node.condition, target: -1 });
            const repeat = jump(node.location); repeat.target = start; end.target = code.length;
          } else { const repeat = jump(node.location); repeat.target = start; }
          const end = code.length;
          if (branch) branch.target = end;
          for (const instruction of control.breaks) instruction.target = end;
          for (const instruction of control.continues) instruction.target = continueTarget;
          controls.pop();
          if (node.kind === 'for') leave(node.location);
        });
        work.push(() => scheduleScoped(node.body, node.kind === 'for' ? 'bloque de for' : node.scopeName));
      };
      if (node.kind === 'for' && node.initializer) { work.push(startLoop); work.push(() => schedule(node.initializer!)); }
      else startLoop();
    } else if (node.kind === 'switch') {
      const dispatch = emit('switch', node.location, { value: node.value, cases: [], target: -1 });
      const control: Control = { kind: 'switch', breaks: [], continues: [], dispatch };
      controls.push(control);
      work.push(() => {
        const end = code.length;
        if (!control.hasDefault) dispatch.target = end;
        for (const instruction of control.breaks) instruction.target = end;
        controls.pop();
      });
      work.push(() => scheduleScoped(node.body, node.scopeName));
    } else if (node.kind === 'case') {
      const control = [...controls].reverse().find(item => item.kind === 'switch');
      if (!control?.dispatch) failure('INVALID_CONTROL_FLOW', 'case/default requiere un switch.', node.location);
      if (node.value) control.dispatch.cases.push({ value: node.constant!, target: code.length });
      else { control.hasDefault = true; control.dispatch.target = code.length; }
      emit('tick', node.location, {});
      work.push(() => schedule(node.statement));
    } else if (node.kind === 'label') {
      labels.set(node.name, code.length); emit('tick', node.location, {});
      work.push(() => schedule(node.statement));
    } else if (node.kind === 'goto') {
      gotos.push({ instruction: jump(node.location), target: node.target });
    } else if (node.kind === 'break' || node.kind === 'continue') {
      const control = node.kind === 'break' ? controls.at(-1) : [...controls].reverse().find(item => item.kind === 'loop');
      if (!control) failure('INVALID_CONTROL_FLOW', `«${node.kind}» fuera de su contexto.`, node.location);
      (node.kind === 'break' ? control.breaks : control.continues).push(jump(node.location));
    } else emit('tick', node.location, {});
  };
  if (fn.body) schedule(fn.body);
  while (work.length) work.pop()!();
  for (const item of gotos) {
    const target = labels.get(item.target);
    if (target === undefined) failure('UNKNOWN_LABEL', `No existe la etiqueta «${item.target}».`, item.instruction.location);
    item.instruction.target = target;
  }
  return { fn, code };
}
