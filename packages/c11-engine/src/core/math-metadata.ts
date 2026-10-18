export const MATH_UNARY_FUNCTIONS = Object.freeze([
  'sqrt', 'fabs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'asinh', 'acosh', 'atanh', 'exp', 'exp2', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'floor', 'ceil', 'trunc', 'round', 'nearbyint', 'rint', 'logb', 'cbrt',
  'erf', 'erfc', 'lgamma', 'tgamma',
] as const);

export const MATH_BINARY_FUNCTIONS = Object.freeze([
  'fmod', 'remainder', 'nextafter', 'pow', 'atan2', 'hypot', 'fmin', 'fmax', 'fdim', 'copysign',
] as const);

export const MATH_SCALING_FUNCTIONS = Object.freeze(['ldexp', 'scalbn', 'scalbln'] as const);
export const MATH_OUT_UNARY_FUNCTIONS = Object.freeze(['frexp', 'modf'] as const);
export const MATH_REMQUO_FUNCTIONS = Object.freeze(['remquo', 'remquof', 'remquol'] as const);
export const MATH_NEXTTOWARD_FUNCTIONS = Object.freeze(['nexttoward', 'nexttowardf', 'nexttowardl'] as const);
export const MATH_NAN_FUNCTIONS = Object.freeze(['nan', 'nanf', 'nanl'] as const);

export const MATH_INTEGER_RETURN_TYPES = Object.freeze({
  ilogb: 'int',
  lrint: 'long', llrint: 'long long', lround: 'long', llround: 'long long',
} as const);
export const MATH_INTEGER_RETURN_FUNCTIONS = Object.freeze(Object.keys(MATH_INTEGER_RETURN_TYPES));

export const MATH_CLASSIFICATION_FUNCTIONS = Object.freeze([
  'isnan', 'isinf', 'isfinite', 'isnormal', 'signbit', 'fpclassify',
] as const);
export const MATH_CLASSIFICATION_BUILTINS = Object.freeze(MATH_CLASSIFICATION_FUNCTIONS.map((name) => `__c11_${name}`));

export const MATH_COMPARISON_MACROS = Object.freeze([
  'isgreater', 'isgreaterequal', 'isless', 'islessequal', 'islessgreater', 'isunordered',
] as const);
export const MATH_COMPARISON_BUILTINS = Object.freeze(MATH_COMPARISON_MACROS.map((name) => `__c11_${name}`));

export const MATH_FMA_FUNCTIONS = Object.freeze(['fma', 'fmaf', 'fmal'] as const);

export const MATH_LONG_DOUBLE_FUNCTIONS: readonly string[] = Object.freeze([
  ...MATH_UNARY_FUNCTIONS.map((name) => `${name}l`),
  ...MATH_BINARY_FUNCTIONS.map((name) => `${name}l`),
  ...MATH_SCALING_FUNCTIONS.map((name) => `${name}l`),
  ...MATH_OUT_UNARY_FUNCTIONS.map((name) => `${name}l`),
  ...MATH_INTEGER_RETURN_FUNCTIONS.map((name) => `${name}l`),
  'remquol', 'nexttowardl',
]);

export const MATH_FUNCTIONS = Object.freeze([
  ...MATH_UNARY_FUNCTIONS.flatMap((name) => [name, `${name}f`, `${name}l`]),
  ...MATH_BINARY_FUNCTIONS.flatMap((name) => [name, `${name}f`, `${name}l`]),
  ...MATH_SCALING_FUNCTIONS.flatMap((name) => [name, `${name}f`, `${name}l`]),
  ...MATH_OUT_UNARY_FUNCTIONS.flatMap((name) => [name, `${name}f`, `${name}l`]),
  ...MATH_INTEGER_RETURN_FUNCTIONS.flatMap((name) => [name, `${name}f`, `${name}l`]),
  ...MATH_REMQUO_FUNCTIONS,
  ...MATH_NEXTTOWARD_FUNCTIONS,
  ...MATH_NAN_FUNCTIONS,
  ...MATH_FMA_FUNCTIONS,
  ...MATH_CLASSIFICATION_FUNCTIONS,
  ...MATH_COMPARISON_MACROS,
]);
