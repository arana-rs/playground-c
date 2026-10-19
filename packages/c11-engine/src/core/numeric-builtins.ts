import { failure } from './internal.ts';
import type { CType, CValue, Location } from './internal.ts';
import {
  binary80Compare, binary80FromNumber, binary80FromRational, binary80FusedMultiplyAdd,
  binary80FusedMultiplyAddToNumber, binary80NaN, binary80RoundToFormat, binary80ToNumber,
} from './binary80.ts';
import type { Binary80Value } from './binary80.ts';
import { HEAP_ALLOCATOR_BUILTINS, HEAP_ALLOCATOR_SIGNATURES } from './allocator-builtins.ts';
import { callMathKernel } from './math-library.ts';
import { ERRNO_CODES } from './errno-metadata.ts';
import {
  MATH_BINARY_FUNCTIONS, MATH_CLASSIFICATION_BUILTINS, MATH_CLASSIFICATION_FUNCTIONS, MATH_COMPARISON_BUILTINS,
  MATH_FMA_FUNCTIONS, MATH_INTEGER_RETURN_TYPES, MATH_NAN_FUNCTIONS,
  MATH_OUT_UNARY_FUNCTIONS, MATH_REMQUO_FUNCTIONS, MATH_SCALING_FUNCTIONS,
  MATH_UNARY_FUNCTIONS,
} from './math-metadata.ts';
import { arithmetic, commonType, floating, int } from './numeric-integers.ts';
import { convert, isBinary80 } from './numeric-conversions.ts';
import { pointerTo, qualifyType } from './type-system.ts';

export interface BuiltinSignature { returnType: CType; parameters: CType[] }
const signView = new DataView(new ArrayBuffer(8));
const isNegative = (value: number) => { signView.setFloat64(0, value); return (signView.getUint8(0) & 0x80) !== 0; };
const classification = new Set<string>(MATH_CLASSIFICATION_FUNCTIONS);
const comparisonBuiltins = new Set<string>(MATH_COMPARISON_BUILTINS);
const nanFunctions = new Set<string>(MATH_NAN_FUNCTIONS);
const classificationBuiltins = new Set<string>(MATH_CLASSIFICATION_BUILTINS);
export function isFloatingClassificationBuiltin(name: string): boolean { return classification.has(name) || classificationBuiltins.has(name); }
export function isFloatingMathBuiltin(name: string): boolean {
  return classification.has(name) || classificationBuiltins.has(name) || comparisonBuiltins.has(name);
}
export const BUILTINS: Record<string, BuiltinSignature> = Object.create(null) as Record<string, BuiltinSignature>;
for (const [names, count] of [[MATH_UNARY_FUNCTIONS, 1], [MATH_BINARY_FUNCTIONS, 2]] as const) {
  for (const name of names) {
    BUILTINS[name] = { returnType: 'double', parameters: Array<CType>(count).fill('double') };
    BUILTINS[`${name}f`] = { returnType: 'float', parameters: Array<CType>(count).fill('float') };
    BUILTINS[`${name}l`] = { returnType: 'long double', parameters: Array<CType>(count).fill('long double') };
  }
}
for (const name of MATH_SCALING_FUNCTIONS) {
  BUILTINS[name] = { returnType: 'double', parameters: ['double', name === 'scalbln' ? 'long' : 'int'] };
  BUILTINS[`${name}f`] = { returnType: 'float', parameters: ['float', name === 'scalbln' ? 'long' : 'int'] };
  BUILTINS[`${name}l`] = { returnType: 'long double', parameters: ['long double', name === 'scalbln' ? 'long' : 'int'] };
}
for (const name of MATH_OUT_UNARY_FUNCTIONS) {
  BUILTINS[name] = { returnType: 'double', parameters: ['double', pointerTo(name === 'frexp' ? 'int' : 'double')] };
  BUILTINS[`${name}f`] = { returnType: 'float', parameters: ['float', pointerTo(name === 'frexp' ? 'int' : 'float')] };
  BUILTINS[`${name}l`] = { returnType: 'long double', parameters: ['long double', pointerTo(name === 'frexp' ? 'int' : 'long double')] };
}
for (const name of MATH_REMQUO_FUNCTIONS) {
  const suffix = name.endsWith('f') ? 'f' : name.endsWith('l') ? 'l' : '';
  const type: CType = suffix === 'f' ? 'float' : suffix === 'l' ? 'long double' : 'double';
  BUILTINS[name] = { returnType: type, parameters: [type, type, pointerTo('int')] };
}
for (const name of ['nexttoward', 'nexttowardf', 'nexttowardl']) {
  const type: CType = name.endsWith('f') ? 'float' : name.endsWith('l') ? 'long double' : 'double';
  BUILTINS[name] = { returnType: type, parameters: [type, 'long double'] };
}
for (const [base, returnType] of Object.entries(MATH_INTEGER_RETURN_TYPES)) {
  for (const [suffix, argumentType] of [['', 'double'], ['f', 'float'], ['l', 'long double']] as const) {
    BUILTINS[`${base}${suffix}`] = { returnType, parameters: [argumentType] };
  }
}
for (const [name, suffix] of [['nan', ''], ['nanf', 'f'], ['nanl', 'l']] as const) {
  const returnType: CType = suffix === 'f' ? 'float' : suffix === 'l' ? 'long double' : 'double';
  BUILTINS[name] = { returnType, parameters: [pointerTo(qualifyType('char', { const: true }))] };
}
BUILTINS.fma = { returnType: 'double', parameters: ['double', 'double', 'double'] };
BUILTINS.fmaf = { returnType: 'float', parameters: ['float', 'float', 'float'] };
BUILTINS.fmal = { returnType: 'long double', parameters: ['long double', 'long double', 'long double'] };
// Classification macros retain their argument's original floating type. Their
// double signature validates scalar calls; callBuiltin handles them before casts.
for (const name of MATH_CLASSIFICATION_FUNCTIONS) BUILTINS[name] = { returnType: 'int', parameters: ['double'] };
for (const name of MATH_CLASSIFICATION_BUILTINS) BUILTINS[name] = { returnType: 'int', parameters: ['double'] };
for (const name of MATH_COMPARISON_BUILTINS) BUILTINS[name] = { returnType: 'int', parameters: ['double', 'double'] };
BUILTINS.__c11_nan = { returnType: 'float', parameters: [] };
BUILTINS.__c11_inf = { returnType: 'float', parameters: [] };
for (const name of HEAP_ALLOCATOR_BUILTINS) {
  const signature = HEAP_ALLOCATOR_SIGNATURES[name];
  BUILTINS[name] = { returnType: signature.returnType, parameters: [...signature.parameters] };
}
BUILTINS.free = { returnType: 'void', parameters: [pointerTo('void')] };
export interface BuiltinCallContext {
  readonly writeOutput?: (argumentIndex: number, value: CValue) => void;
  readonly setErrno?: (value: number) => void;
}

function asBinary80(value: CValue, location: Location): Binary80Value {
  arithmetic(value, location);
  if (isBinary80(value.value)) return value.value;
  if (typeof value.value === 'number') return binary80FromNumber(value.value);
  if (typeof value.value === 'bigint') {
    return binary80FromRational(value.value < 0n ? -value.value : value.value, 1n, { negative: value.value < 0n });
  }
  failure('INVALID_OPERAND_TYPE', 'Math functions require arithmetic operands.', location);
}

function binaryFormat(type: CType): 'binary32' | 'binary64' | 'binary80' {
  return type === 'float' ? 'binary32' : type === 'long double' ? 'binary80' : 'binary64';
}

export function callBuiltin(name: string, args: CValue[], location: Location, context: BuiltinCallContext = {}): CValue {
  const signature = BUILTINS[name];
  if (!signature) failure('UNSUPPORTED_FEATURE', `Function «${name}» is not part of the published math and P2 library profile.`, location);
  if ((HEAP_ALLOCATOR_BUILTINS as readonly string[]).includes(name) || name === 'free') failure('ENGINE_INTERNAL_ERROR', `Function «${name}» must run with the virtual store.`, location);
  if (args.length !== signature.parameters.length) failure('ARGUMENT_COUNT', `«${name}» requires ${signature.parameters.length} arguments.`, location);
  if (name === '__c11_nan') return { type: 'float', value: NaN };
  if (name === '__c11_inf') return { type: 'float', value: Infinity };
  if (nanFunctions.has(name)) {
    if (signature.returnType === 'long double') return { type: 'long double', value: binary80NaN() };
    return floating(NaN, signature.returnType as 'float' | 'double');
  }
  if (classification.has(name) || classificationBuiltins.has(name)) {
    const operation = name.startsWith('__c11_') ? name.slice('__c11_'.length) : name;
    arithmetic(args[0], location);
    if (isBinary80(args[0].value)) {
      const value = args[0].value;
      const finite = value.classification === 'finite';
      const zero = finite && value.significand === 0n;
      const subnormal = finite && value.significand > 0n && value.significand < (1n << 63n);
      if (operation === 'isnan') return int(value.classification === 'nan');
      if (operation === 'isinf') return int(value.classification === 'infinity');
      if (operation === 'isfinite') return int(finite);
      if (operation === 'isnormal') return int(finite && !zero && !subnormal);
      if (operation === 'signbit') return int(value.negative);
      return int(value.classification === 'nan' ? 0 : value.classification === 'infinity' ? 1 : zero ? 2 : subnormal ? 3 : 4);
    }
    const value = Number(args[0].value);
    const absolute = Math.abs(value);
    const subnormal = absolute > 0 && absolute < (args[0].type === 'float' ? 2 ** -126 : 2 ** -1022);
    if (operation === 'isnan') return int(Number.isNaN(value));
    if (operation === 'isinf') return int(!Number.isFinite(value) && !Number.isNaN(value));
    if (operation === 'isfinite') return int(Number.isFinite(value));
    if (operation === 'isnormal') return int(Number.isFinite(value) && value !== 0 && !subnormal);
    if (operation === 'signbit') return int(isNegative(value));
    return int(Number.isNaN(value) ? 0 : !Number.isFinite(value) ? 1 : value === 0 ? 2 : subnormal ? 3 : 4);
  }
  if (comparisonBuiltins.has(name)) {
    const operation = name.slice('__c11_'.length);
    const type = commonType(args[0].type, args[1].type);
    const left = asBinary80(convert(args[0], type, location), location);
    const right = asBinary80(convert(args[1], type, location), location);
    const unordered = left.classification === 'nan' || right.classification === 'nan';
    const order = binary80Compare(left, right);
    if (operation === 'isunordered') return int(unordered);
    if (unordered) return int(false);
    if (operation === 'isgreater') return int(order === 1);
    if (operation === 'isgreaterequal') return int(order === 1 || order === 0);
    if (operation === 'isless') return int(order === -1);
    if (operation === 'islessequal') return int(order === -1 || order === 0);
    return int(order !== 0);
  }
  if ((MATH_FMA_FUNCTIONS as readonly string[]).includes(name)) {
    const type = signature.parameters[0];
    const values = args.map((argument) => convert(argument, type, location));
    const binary80Values = values.map((argument) => {
      if (isBinary80(argument.value)) return argument.value;
      if (typeof argument.value !== 'number') failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» received a non-floating value.`, location);
      return binary80FromNumber(argument.value);
    });
    if (signature.returnType === 'double' || signature.returnType === 'float') {
      const format = signature.returnType === 'float' ? 'binary32' : 'binary64';
      const exact = binary80FusedMultiplyAdd(binary80Values[0], binary80Values[1], binary80Values[2]);
      const result = binary80FusedMultiplyAddToNumber(binary80Values[0], binary80Values[1], binary80Values[2], format);
      if (binary80Values.every((value) => value.classification === 'finite') && exact.classification === 'finite' &&
          (!Number.isFinite(result) || result === 0 && exact.significand !== 0n)) context.setErrno?.(ERRNO_CODES.ERANGE);
      return floating(result, signature.returnType);
    }
    const result = binary80FusedMultiplyAdd(binary80Values[0], binary80Values[1], binary80Values[2]);
    if (binary80Values.every((value) => value.classification === 'finite') && result.classification === 'infinity') {
      context.setErrno?.(ERRNO_CODES.ERANGE);
    }
    return { type: 'long double', value: result };
  }
  const floatingFormat = binaryFormat(signature.parameters[0]);
  const isScaling = MATH_SCALING_FUNCTIONS.some((base) => name === base || name === `${base}f` || name === `${base}l`);
  const isOutputUnary = MATH_OUT_UNARY_FUNCTIONS.some((base) => name === base || name === `${base}f` || name === `${base}l`);
  const isRemquo = MATH_REMQUO_FUNCTIONS.includes(name as typeof MATH_REMQUO_FUNCTIONS[number]);
  const floatingArgumentCount = isScaling || isOutputUnary ? 1 : isRemquo ? 2 : args.length;
  const values = args.slice(0, floatingArgumentCount).map((argument, index) => {
    const converted = convert(argument, signature.parameters[index], location);
    return asBinary80(converted, location);
  });
  let integerArgument: bigint | undefined;
  if (isScaling) {
    const exponent = convert(args[1], signature.parameters[1], location).value;
    if (typeof exponent !== 'bigint') failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» lost its integer exponent.`, location);
    integerArgument = exponent;
  }
  const kernel = callMathKernel(name, values, { format: floatingFormat, integerArgument });
  if (!kernel) failure('UNSUPPORTED_FEATURE', `Math function «${name}» is outside the published math profile.`, location);
  let mathError = kernel.error;
  if (kernel.value && values.every((value) => value.classification === 'finite')) {
    const rounded = binary80RoundToFormat(kernel.value, floatingFormat);
    if (rounded.classification === 'infinity' && kernel.value.classification === 'finite' ||
        rounded.classification === 'finite' && rounded.significand === 0n && kernel.value.classification === 'finite' && kernel.value.significand !== 0n) {
      mathError = 'range';
    }
    const minimumNormalExponent = floatingFormat === 'binary32' ? -126 : floatingFormat === 'binary64' ? -1022 : -16382;
    if (rounded.classification === 'finite' && rounded.significand !== 0n &&
        rounded.exponent + rounded.significand.toString(2).length - 1 < minimumNormalExponent &&
        binary80Compare(rounded, kernel.value) !== 0) {
      mathError = 'range';
    }
  }
  if (mathError) context.setErrno?.(mathError === 'domain' ? ERRNO_CODES.EDOM : ERRNO_CODES.ERANGE);
  if (kernel.output && context.writeOutput && mathError !== 'domain') {
    const output = typeof kernel.output.value === 'bigint'
      ? { type: 'int' as CType, value: kernel.output.value }
      : { type: signature.returnType, value: kernel.output.value };
    context.writeOutput(kernel.output.argumentIndex, output);
  }
  if (kernel.integerValue !== undefined) return { type: signature.returnType, value: kernel.integerValue };
  if (kernel.value) {
    if (signature.returnType === 'long double') return { type: 'long double', value: binary80RoundToFormat(kernel.value, 'binary80') };
    const rounded = binary80ToNumber(kernel.value, floatingFormat as 'binary32' | 'binary64');
    return floating(rounded, signature.returnType as 'float' | 'double');
  }
  failure('ENGINE_INTERNAL_ERROR', `Math function «${name}» did not produce a result.`, location);
}
