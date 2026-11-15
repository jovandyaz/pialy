export const BUSINESS_TIME_ZONE = 'America/Mexico_City';
const LOCALE = 'es-MX';
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

const PART = {
  weekdayShort: { weekday: 'short' },
  monthShort: { month: 'short' },
  day: { day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  long: { weekday: 'long', day: 'numeric', month: 'long' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

function format(instant: string | Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: BUSINESS_TIME_ZONE, ...options }).format(new Date(instant));
}

const stripDot = (value: string): string => value.replace(/\.$/, '');
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

export function formatTime(instant: string | Date): string {
  return format(instant, PART.time);
}

export function isoDateOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE }).format(instant);
}

export function nextDays(count: number, now: Date = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => isoDateOf(new Date(now.getTime() + i * MS_PER_DAY)));
}

// 18:00 UTC is midday in Mexico City, so it always lands on the same calendar date.
function middayOf(isoDate: string): Date {
  return new Date(`${isoDate}T18:00:00Z`);
}

export function weekdayShort(isoDate: string): string {
  return stripDot(format(middayOf(isoDate), PART.weekdayShort));
}

export function dayOfMonth(isoDate: string): string {
  return format(middayOf(isoDate), PART.day);
}

/** `Sáb 15 nov` */
export function shortDateLabel(instant: string | Date): string {
  const weekday = stripDot(format(instant, PART.weekdayShort));
  const month = stripDot(format(instant, PART.monthShort));
  return `${capitalize(weekday)} ${format(instant, PART.day)} ${month}`;
}

/** `Sábado 15 de noviembre` */
export function longDateLabel(instant: string | Date): string {
  return capitalize(format(instant, PART.long).replace(',', ''));
}

/** `sáb 15` */
export function boardDayLabel(isoDate: string): string {
  return `${weekdayShort(isoDate)} ${dayOfMonth(isoDate)}`;
}

export function minutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / MS_PER_MINUTE);
}
