import type { Location } from './internal.ts';
import type { StdlibTimeRuntimeContext } from './stdlib-time-context.ts';
import { civilFromDays, daysFromCivil, floorDiv, positiveMod } from './time-library-calendar.ts';
import type { BrokenDownTime } from './time-library-calendar.ts';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

function formattedNumber(value: bigint, width: number, fill = '0'): string {
  const raw = value.toString();
  if (raw.startsWith('-')) return `-${raw.slice(1).padStart(Math.max(0, width - 1), fill)}`;
  return raw.padStart(width, fill);
}

function yearText(year: bigint): string {
  return year < 0n ? `-${(-year).toString().padStart(4, '0')}` : year.toString().padStart(4, '0');
}

function validTmIndex(value: bigint, minimum: bigint, maximum: bigint): number | null {
  return value < minimum || value > maximum ? null : Number(value);
}

function mondayIndex(weekday: bigint): bigint { return positiveMod(weekday + 6n, 7n); }

function isoWeek(parts: BrokenDownTime): { year: bigint; week: bigint } {
  const calendarYear = parts.year + 1900n;
  const dayNumber = daysFromCivil(calendarYear, parts.month + 1n, parts.day);
  const thursday = dayNumber + (3n - positiveMod(parts.weekday + 6n, 7n));
  const isoYear = civilFromDays(thursday).year;
  const jan4 = daysFromCivil(isoYear, 1n, 4n);
  const firstMonday = jan4 - mondayIndex(positiveMod(jan4 + 4n, 7n));
  return { year: isoYear, week: (dayNumber - firstMonday) / 7n + 1n };
}

function formatDirective(conversion: string, tm: BrokenDownTime): string | undefined {
  const weekday = validTmIndex(tm.weekday, 0n, 6n);
  const month = validTmIndex(tm.month, 0n, 11n);
  const year = tm.year + 1900n;
  const hour12 = tm.hour % 12n || 12n;
  const weekU = (tm.yearDay + 7n - positiveMod(tm.weekday, 7n)) / 7n;
  const weekW = (tm.yearDay + 7n - mondayIndex(tm.weekday)) / 7n;
  const iso = isoWeek(tm);
  switch (conversion) {
    case 'a': return weekday === null ? undefined : DAY_SHORT[weekday];
    case 'A': return weekday === null ? undefined : DAY_LONG[weekday];
    case 'b': case 'h': return month === null ? undefined : MONTH_SHORT[month];
    case 'B': return month === null ? undefined : MONTH_LONG[month];
    case 'c': return formatDirective('a', tm)! + ' ' + formatDirective('b', tm)! + ' ' + formattedNumber(tm.day, 2, ' ') + ` ${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)} ${yearText(year)}`;
    case 'C': return formattedNumber(floorDiv(year, 100n), 2);
    case 'd': return formattedNumber(tm.day, 2);
    case 'D': return `${formattedNumber(tm.month + 1n, 2)}/${formattedNumber(tm.day, 2)}/${formattedNumber(positiveMod(year, 100n), 2)}`;
    case 'e': return formattedNumber(tm.day, 2, ' ');
    case 'F': return `${yearText(year)}-${formattedNumber(tm.month + 1n, 2)}-${formattedNumber(tm.day, 2)}`;
    case 'g': return formattedNumber(positiveMod(iso.year, 100n), 2);
    case 'G': return yearText(iso.year);
    case 'H': return formattedNumber(tm.hour, 2);
    case 'I': return formattedNumber(hour12, 2);
    case 'j': return formattedNumber(tm.yearDay + 1n, 3);
    case 'm': return formattedNumber(tm.month + 1n, 2);
    case 'M': return formattedNumber(tm.minute, 2);
    case 'n': return '\n';
    case 'p': return tm.hour < 12n ? 'AM' : 'PM';
    case 'r': return `${formattedNumber(hour12, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)} ${tm.hour < 12n ? 'AM' : 'PM'}`;
    case 'R': return `${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}`;
    case 'S': return formattedNumber(tm.second, 2);
    case 't': return '\t';
    case 'T': return `${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)}`;
    case 'u': return String(Number(mondayIndex(tm.weekday) + 1n));
    case 'U': return formattedNumber(weekU, 2);
    case 'V': return formattedNumber(iso.week, 2);
    case 'w': return weekday === null ? undefined : String(weekday);
    case 'W': return formattedNumber(weekW, 2);
    case 'x': return `${formattedNumber(tm.month + 1n, 2)}/${formattedNumber(tm.day, 2)}/${formattedNumber(positiveMod(year, 100n), 2)}`;
    case 'X': return `${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)}`;
    case 'y': return formattedNumber(positiveMod(year, 100n), 2);
    case 'Y': return yearText(year);
    case 'z': return '+0000';
    case 'Z': return 'UTC';
    case '%': return '%';
    default: return undefined;
  }
}

const E_MODIFIERS = new Set(['c', 'C', 'x', 'X', 'y', 'Y']);
const O_MODIFIERS = new Set(['d', 'e', 'H', 'I', 'm', 'M', 'S', 'u', 'U', 'V', 'w', 'W', 'y']);

export function formatTm(
  format: Uint8Array,
  tm: BrokenDownTime,
  context: Pick<StdlibTimeRuntimeContext, 'fail' | 'chargeWork'>,
  at: Location,
): string {
  const output: number[] = [];
  for (let index = 0; index < format.length; index++) {
    const byte = format[index];
    if (byte !== 37) { output.push(byte); continue; }
    const first = format[++index];
    if (first === undefined) break;
    if (first === 37) { output.push(37); continue; }
    let modifier = '';
    let conversionByte = first;
    if (first === 69 || first === 79) {
      modifier = String.fromCharCode(first);
      conversionByte = format[++index] ?? 0;
    }
    const conversion = String.fromCharCode(conversionByte);
    if (modifier === 'E' && !E_MODIFIERS.has(conversion) || modifier === 'O' && !O_MODIFIERS.has(conversion)) {
      context.fail('LIBRARY_ARGUMENT', `Invalid strftime modifier %${modifier}${conversion} for the C locale.`, at);
    }
    const piece = formatDirective(conversion, tm);
    if (piece === undefined) context.fail('LIBRARY_ARGUMENT', `Invalid strftime conversion «%${modifier}${conversion}» or out-of-range tm fields.`, at);
    output.push(...new TextEncoder().encode(piece));
    context.chargeWork(1, at);
  }
  return new TextDecoder().decode(Uint8Array.from(output));
}

export function asctimeText(tm: BrokenDownTime): string | undefined {
  const weekday = validTmIndex(tm.weekday, 0n, 6n), month = validTmIndex(tm.month, 0n, 11n);
  if (weekday === null || month === null || tm.hour < 0n || tm.hour > 23n || tm.minute < 0n || tm.minute > 59n || tm.second < 0n || tm.second > 60n || tm.day < 1n || tm.day > 31n) return undefined;
  return `${DAY_SHORT[weekday]} ${MONTH_SHORT[month]} ${formattedNumber(tm.day, 2, ' ')} ${formattedNumber(tm.hour, 2)}:${formattedNumber(tm.minute, 2)}:${formattedNumber(tm.second, 2)} ${yearText(tm.year + 1900n)}\n`;
}
