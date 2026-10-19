const SECONDS_PER_DAY = 86_400n;

export interface BrokenDownTime {
  readonly second: bigint;
  readonly minute: bigint;
  readonly hour: bigint;
  readonly day: bigint;
  readonly month: bigint;
  readonly year: bigint;
  readonly weekday: bigint;
  readonly yearDay: bigint;
  readonly isDst: bigint;
}

export function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

export function positiveMod(value: bigint, divisor: bigint): bigint {
  const result = value % divisor;
  return result < 0n ? result + divisor : result;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
export function daysFromCivil(yearInput: bigint, month: bigint, day: bigint): bigint {
  const year = yearInput - (month <= 2n ? 1n : 0n);
  const era = floorDiv(year, 400n);
  const yearOfEra = year - era * 400n;
  const shiftedMonth = month + (month > 2n ? -3n : 9n);
  const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

export function civilFromDays(daysSinceEpoch: bigint): { year: bigint; month: bigint; day: bigint; yearDay: bigint } {
  const z = daysSinceEpoch + 719_468n;
  const era = floorDiv(z, 146_097n);
  const dayOfEra = z - era * 146_097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * monthPrime + 2n) / 5n + 1n;
  const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
  year += month <= 2n ? 1n : 0n;
  const yearDay = daysFromCivil(year, month, day) - daysFromCivil(year, 1n, 1n);
  return { year, month, day, yearDay };
}

export function splitTimestamp(seconds: bigint): BrokenDownTime {
  const dayNumber = floorDiv(seconds, SECONDS_PER_DAY);
  const secondsOfDay = seconds - dayNumber * SECONDS_PER_DAY;
  const civil = civilFromDays(dayNumber);
  return {
    second: secondsOfDay % 60n,
    minute: secondsOfDay / 60n % 60n,
    hour: secondsOfDay / 3600n,
    day: civil.day,
    month: civil.month - 1n,
    year: civil.year - 1900n,
    weekday: positiveMod(dayNumber + 4n, 7n),
    yearDay: civil.yearDay,
    isDst: 0n,
  };
}

export function timestampFromTm(tm: BrokenDownTime): bigint {
  const year = tm.year + 1900n;
  const monthOffset = tm.month;
  const normalizedYear = year + floorDiv(monthOffset, 12n);
  const normalizedMonth = positiveMod(monthOffset, 12n) + 1n;
  const dayNumber = daysFromCivil(normalizedYear, normalizedMonth, 1n) + tm.day - 1n;
  return dayNumber * SECONDS_PER_DAY + tm.hour * 3600n + tm.minute * 60n + tm.second;
}

export function canStoreTm(parts: BrokenDownTime): boolean {
  return parts.year >= -2_147_483_648n && parts.year <= 2_147_483_647n &&
    parts.month >= -2_147_483_648n && parts.month <= 2_147_483_647n;
}
