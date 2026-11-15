export const DEFAULT_TIME_ZONE = 'America/Mexico_City';

/** Opening hours as local wall-clock times, `HH:MM`. */
export interface BusinessHours {
  readonly open: string;
  readonly close: string;
}

export interface BusinessConfig {
  /** Distance between two slot starts. */
  readonly slotMinutes: number;
  /** Length of one appointment: a slot ends this long after it starts. */
  readonly serviceMinutes: number;
  readonly hours: BusinessHours;
}

/** Half-open `[start, end)`, as stored in `bookings.during`. */
export interface Slot {
  readonly start: Date;
  readonly end: Date;
}

export class InvalidDateError extends Error {
  override readonly name = 'InvalidDateError';

  constructor() {
    super('date must be a calendar date written YYYY-MM-DD');
  }
}

/** The instant is not the start of a slot the business offers, or it already started. */
export class SlotNotOfferedError extends Error {
  override readonly name = 'SlotNotOfferedError';

  constructor() {
    super('the business does not offer a slot starting at that time');
  }
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const GMT_OFFSET = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/;

/**
 * Slots of one local calendar day: the first starts at opening time, each next one `slotMinutes`
 * later, and the last one starts before closing time. Local times become instants through the time
 * zone database, so a change of UTC offset is honored.
 */
export function generateSlots(date: string, business: BusinessConfig, tz: string = DEFAULT_TIME_ZONE): Slot[] {
  const day = parseIsoDate(date);
  const open = parseWallTime(business.hours.open);
  const close = parseWallTime(business.hours.close);
  assertPositiveMinutes(business.slotMinutes, 'slotMinutes');
  assertPositiveMinutes(business.serviceMinutes, 'serviceMinutes');

  const slots: Slot[] = [];
  for (let minute = open; minute < close; minute += business.slotMinutes) {
    const start = zonedWallTimeToInstant(day, minute, tz);
    slots.push({ start, end: new Date(start.getTime() + business.serviceMinutes * MS_PER_MINUTE) });
  }
  return slots;
}

/** The slot that starts at `start`, if the business offers it and it has not started by `now`. */
export function bookableSlot(start: Date, business: BusinessConfig, tz: string, now: Date): Slot {
  if (Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) throw new SlotNotOfferedError();
  const slot = generateSlots(localDateOf(start, tz), business, tz).find((s) => s.start.getTime() === start.getTime());
  if (slot === undefined) throw new SlotNotOfferedError();
  return slot;
}

/** The `YYYY-MM-DD` calendar date of an instant in a time zone. */
export function localDateOf(instant: Date, tz: string): string {
  const parts = partsOf(dateFormatter(tz), instant);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Throws {@link InvalidDateError} unless `date` is a real `YYYY-MM-DD` calendar date. */
export function assertIsoDate(date: string): void {
  parseIsoDate(date);
}

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseIsoDate(date: string): CalendarDay {
  const match = ISO_DATE.exec(date);
  if (match === null) throw new InvalidDateError();
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new InvalidDateError();
  }
  return { year, month, day };
}

function parseWallTime(time: string): number {
  const match = WALL_TIME.exec(time);
  if (match === null) throw new Error(`business hours must be HH:MM, got ${time}`);
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}

function assertPositiveMinutes(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`);
}

/**
 * Two passes: the offset at the naive UTC reading of the wall time can differ from the offset at
 * the real instant when a transition falls between them.
 */
function zonedWallTimeToInstant(day: CalendarDay, minuteOfDay: number, tz: string): Date {
  const wallAsUtc = Date.UTC(day.year, day.month - 1, day.day, 0, minuteOfDay);
  const firstGuess = wallAsUtc - offsetMinutes(tz, new Date(wallAsUtc)) * MS_PER_MINUTE;
  const corrected = wallAsUtc - offsetMinutes(tz, new Date(firstGuess)) * MS_PER_MINUTE;
  return new Date(corrected);
}

function offsetMinutes(tz: string, instant: Date): number {
  const name = partsOf(offsetFormatter(tz), instant).timeZoneName ?? '';
  const match = GMT_OFFSET.exec(name);
  if (match === null) throw new Error(`unexpected UTC offset "${name}" for time zone ${tz}`);
  if (match[1] === undefined) return 0;
  const minutes = Number(match[2]) * MINUTES_PER_HOUR + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(tz: string): Intl.DateTimeFormat {
  return cached(dateFormatters, tz, () =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }),
  );
}

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  return cached(offsetFormatters, tz, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }));
}

function cached(store: Map<string, Intl.DateTimeFormat>, tz: string, create: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const existing = store.get(tz);
  if (existing !== undefined) return existing;
  const created = create();
  store.set(tz, created);
  return created;
}

function partsOf(formatter: Intl.DateTimeFormat, instant: Date): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  return Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
}
