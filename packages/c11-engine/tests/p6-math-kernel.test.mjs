import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const source = `
#include <errno.h>
#include <float.h>
#include <math.h>

static int within_binary80_error(long double actual, long double expected)
{
    return fabsl(actual - expected) <= fabsl(expected) * 0x1p-60L;
}

int main(void)
{
    volatile long double inexact_subnormal = 3.0L * LDBL_TRUE_MIN;
    static const long double gamma_inputs[] = { 0.1L, 0.5L, -0.5L, 1.1L, 10.25L };
    static const long double gamma_expected[] = {
        0x9.83753d9406c3da4p+0L,
        0xe.2dfc48da77b553dp-3L,
        -0xe.2dfc48da77b553dp-2L,
        0xf.38bb95b9a46c907p-4L,
        0x9.c10099499e4bd82p+16L
    };
    static const long double log_gamma_expected[] = {
        0x9.02c71af9ef76f9p-2L,
        0x9.28682473d0de85fp-4L,
        0xa.1fc4d1f876eb106p-3L,
        -0xc.c470b82ec4f21bdp-8L,
        0xd.5e36cca124ba3f1p+0L
    };
    static const long double tail_inputs[] = { 2.0L, 4.0L, 8.0L, 64.0L, 100.0L };
    static const long double erfc_expected[] = {
        0x9.947af61a873346cp-11L,
        0x8.46ee89de9af353dp-29L,
        0xe.3a7e2090befdbb7p-100L,
        0xe.e0fa797f5840417p-5920L,
        0xb.f54533bddd43963p-14438L
    };

    errno = EINVAL;
    if (ldexpl(inexact_subnormal, -1) != 2.0L * LDBL_TRUE_MIN || errno != ERANGE) return 0;
    errno = EINVAL;
    if (ldexpl(LDBL_TRUE_MIN, 1) != 2.0L * LDBL_TRUE_MIN || errno != EINVAL) return 0;

    for (unsigned index = 0; index < sizeof gamma_inputs / sizeof gamma_inputs[0]; ++index) {
        if (!within_binary80_error(tgammal(gamma_inputs[index]), gamma_expected[index]) ||
            !within_binary80_error(lgammal(gamma_inputs[index]), log_gamma_expected[index])) return 0;
    }
    for (unsigned index = 0; index < sizeof tail_inputs / sizeof tail_inputs[0]; ++index) {
        if (!within_binary80_error(erfcl(tail_inputs[index]), erfc_expected[index])) return 0;
    }
    return 1;
}
`;

test('binary80 gamma and complementary error tails retain extended precision', () => {
  const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));

  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);
});
