import {
  binary80Compare, binary80FromRational, binary80NaN, binary80NextAfter,
  binary80Subtract, binary80Zero,
} from './binary80.ts';
import type { Binary80Value, BinaryFloatFormat } from './binary80.ts';
import {
  MATH_BINARY_FUNCTIONS, MATH_INTEGER_RETURN_FUNCTIONS, MATH_OUT_UNARY_FUNCTIONS,
  MATH_SCALING_FUNCTIONS, MATH_UNARY_FUNCTIONS,
} from './math-metadata.ts';
import {
  absolute, exactInteger, isZero, roundedIntegral, roundedInteger, signed,
} from './math-library-primitives.ts';
import {
  acosHyperbolic, asinHyperbolic, atanhHyperbolic, exp2Binary80, expBinary80,
  expm1Binary80, log1pBinary80, logBinary80Result, sinhCoshTanh,
} from './math-library-exponential.ts';
import {
  acosBinary80, asinBinary80, atan2Binary80, atanBinary80, trigBinary80,
} from './math-library-trigonometric.ts';
import {
  cbrtBinary80, fmodBinary80, frexpBinary80, hypotBinary80, ilogbBinary80,
  logbBinary80, minimumMaximum, modfBinary80, powBinary80, remainderBinary80,
  scalePowerOfTwo, sqrtBinary80,
} from './math-library-arithmetic.ts';
import { erfSeries, erfcBinary80, gammaBinary80 } from './math-library-special.ts';
import type { MathError, MathKernelOptions, MathKernelResult } from './math-library-types.ts';

function unaryMath(name: string, value: Binary80Value): Binary80Value | undefined {
  switch (name) {
    case 'sqrt': return sqrtBinary80(value);
    case 'fabs': return absolute(value);
    case 'sin': case 'cos': case 'tan': return trigBinary80(name, value);
    case 'asin': return asinBinary80(value);
    case 'acos': return acosBinary80(value);
    case 'atan': return atanBinary80(value);
    case 'sinh': case 'cosh': case 'tanh': return sinhCoshTanh(value, name);
    case 'asinh': return asinHyperbolic(value);
    case 'acosh': return acosHyperbolic(value);
    case 'atanh': return atanhHyperbolic(value);
    case 'exp': return expBinary80(value);
    case 'exp2': return exp2Binary80(value);
    case 'expm1': return expm1Binary80(value);
    case 'log': case 'log2': case 'log10': return logBinary80Result(value, name);
    case 'log1p': return log1pBinary80(value);
    case 'floor': case 'ceil': case 'trunc': case 'round': return roundedIntegral(value, name);
    case 'nearbyint': case 'rint': return roundedIntegral(value, 'nearestEven');
    case 'logb': return logbBinary80(value);
    case 'erf': return erfSeries(value);
    case 'erfc': return erfcBinary80(value);
    case 'lgamma': return gammaBinary80(value, true);
    case 'tgamma': return gammaBinary80(value, false);
    case 'cbrt': return cbrtBinary80(value);
    default: return undefined;
  }
}

function binaryMath(
  name: string,
  left: Binary80Value,
  right: Binary80Value,
  format: BinaryFloatFormat = 'binary80',
): Binary80Value | undefined {
  switch (name) {
    case 'fmod': return fmodBinary80(left, right);
    case 'remainder': return remainderBinary80(left, right).value;
    case 'nextafter': return binary80NextAfter(left, right, format);
    case 'pow': return powBinary80(left, right);
    case 'atan2': return atan2Binary80(left, right);
    case 'hypot': return hypotBinary80(left, right);
    case 'fmin': return minimumMaximum(left, right, false);
    case 'fmax': return minimumMaximum(left, right, true);
    case 'fdim': {
      if (left.classification === 'nan' || right.classification === 'nan') return binary80NaN();
      return binary80Compare(left, right) === 1 ? binary80Subtract(left, right) : binary80Zero();
    }
    case 'copysign': return signed(absolute(left), right.negative);
    default: return undefined;
  }
}

function variant(name: string, bases: readonly string[]): { base: string; format: BinaryFloatFormat } | undefined {
  for (const base of bases) {
    if (name === base) return { base, format: 'binary64' };
    if (name === `${base}f`) return { base, format: 'binary32' };
    if (name === `${base}l`) return { base, format: 'binary80' };
  }
  return undefined;
}

function mathError(
  base: string,
  args: readonly Binary80Value[],
  result: Binary80Value | undefined,
): MathError | undefined {
  const x = args[0];
  const y = args[1];
  const one = binary80FromRational(1n);
  const absX = x ? absolute(x) : undefined;
  const absCmp = absX ? binary80Compare(absX, one) : undefined;
  const negativeX = !!x && x.classification !== 'nan' && x.negative && !isZero(x);
  const xIsInteger = x ? exactInteger(x) !== undefined : false;

  if (base === 'sqrt' && negativeX ||
      (base === 'asin' || base === 'acos') && absCmp === 1 ||
      base === 'acosh' && x && x.classification !== 'nan' && binary80Compare(x, one) === -1 ||
      base === 'atanh' && absCmp === 1 ||
      (base === 'log' || base === 'log2' || base === 'log10') && negativeX ||
      base === 'log1p' && x && x.classification !== 'nan' && binary80Compare(x, binary80FromRational(1n, 1n, { negative: true })) === -1 ||
      (base === 'fmod' || base === 'remainder') && y && isZero(y) ||
      base === 'pow' && x && y && x.classification === 'finite' && y.classification === 'finite' && x.negative && !xIsInteger) {
    return 'domain';
  }
  if ((base === 'log' || base === 'log2' || base === 'log10') && x && isZero(x) ||
      base === 'log1p' && x && binary80Compare(x, binary80FromRational(1n, 1n, { negative: true })) === 0 ||
      base === 'atanh' && absCmp === 0 ||
      base === 'pow' && x && y && isZero(x) && y.negative && !isZero(y) ||
      (base === 'lgamma' || base === 'tgamma') && x && (isZero(x) || x.negative && xIsInteger)) {
    return 'range';
  }
  if (base === 'ilogb' && x && (isZero(x) || x.classification === 'nan')) return 'domain';

  const rangeSensitive = new Set([
    'exp', 'exp2', 'expm1', 'sinh', 'cosh', 'pow', 'hypot', 'ldexp', 'scalbn', 'scalbln',
    'nextafter', 'nexttoward', 'erfc', 'tgamma',
  ]);
  if (rangeSensitive.has(base) && result && args.every((argument) => argument.classification === 'finite')) {
    if (result.classification === 'infinity') return 'range';
    if (base !== 'nextafter' && base !== 'nexttoward' && isZero(result) && args.some((argument) => !isZero(argument)) &&
        (base !== 'pow' || !x || !isZero(x))) return 'range';
  }
  return undefined;
}

function floatingError(base: string, args: readonly Binary80Value[], result: Binary80Value): MathError | undefined {
  return mathError(base, args, result);
}

export function callMathKernel(
  name: string,
  args: readonly Binary80Value[],
  options: MathKernelOptions,
): MathKernelResult | undefined {
  const unary = variant(name, MATH_UNARY_FUNCTIONS);
  if (unary) {
    const value = unaryMath(unary.base, args[0]);
    return value ? { value, error: floatingError(unary.base, args, value) } : undefined;
  }
  const binary = variant(name, MATH_BINARY_FUNCTIONS);
  if (binary) {
    const value = binaryMath(binary.base, args[0], args[1], options.format);
    return value ? { value, error: floatingError(binary.base, args, value) } : undefined;
  }
  const scaling = variant(name, MATH_SCALING_FUNCTIONS);
  if (scaling) {
    const exponent = options.integerArgument ?? 0n;
    const result = scalePowerOfTwo(args[0], exponent);
    return { value: result.value, error: result.error ?? floatingError(scaling.base, [args[0]], result.value) };
  }
  const outputUnary = variant(name, MATH_OUT_UNARY_FUNCTIONS);
  if (outputUnary) {
    if (outputUnary.base === 'frexp') {
      const result = frexpBinary80(args[0]);
      return { value: result.value, output: { argumentIndex: 1, value: result.exponent } };
    }
    const result = modfBinary80(args[0]);
    return { value: result.value, output: { argumentIndex: 1, value: result.integral } };
  }
  const remquo = variant(name, ['remquo']);
  if (remquo) {
    const result = remainderBinary80(args[0], args[1]);
    const quotient = result.quotient < 0n ? -( (-result.quotient) % 8n ) : result.quotient % 8n;
    return {
      value: result.value,
      output: { argumentIndex: 2, value: quotient },
      error: floatingError('remainder', args.slice(0, 2), result.value),
    };
  }
  const nexttoward = variant(name, ['nexttoward']);
  if (nexttoward) {
    const value = binary80NextAfter(args[0], args[1], options.format);
    return { value, error: floatingError('nexttoward', args, value) };
  }
  const integerReturn = variant(name, MATH_INTEGER_RETURN_FUNCTIONS);
  if (integerReturn) {
    if (integerReturn.base === 'ilogb') return { integerValue: ilogbBinary80(args[0]), error: mathError('ilogb', args, undefined) };
    const ties = integerReturn.base === 'lround' || integerReturn.base === 'llround' ? 'away' : 'even';
    if (args[0].classification !== 'finite') {
      const minimum = integerReturn.base.startsWith('ll') ? -(1n << 63n) : -(1n << 63n);
      return { integerValue: minimum, error: 'range' };
    }
    return { integerValue: roundedInteger(args[0], ties) };
  }
  return undefined;
}

export function callLongDoubleMath(name: string, args: readonly Binary80Value[]): Binary80Value | undefined {
  if (!name.endsWith('l')) return undefined;
  const result = callMathKernel(name, args, { format: 'binary80' });
  return result?.value;
}
