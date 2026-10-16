#ifndef P4_FIXTURE_CONFIG_H
#define P4_FIXTURE_CONFIG_H

#if defined(FEATURE_ON)
#if FEATURE_ON
#define FEATURE_VALUE 2
#else
#define FEATURE_VALUE 0
#endif
#elif defined(FEATURE_FALLBACK)
#define FEATURE_VALUE 1
#else
#define FEATURE_VALUE 0
#endif

#define CONFIG_VALUE 40

#endif
