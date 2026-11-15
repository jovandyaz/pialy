import { describe, expect, it } from 'vitest';
import { decideOnPayment, type BookingStatus } from '../src/modules/booking/domain/booking.js';
import { InvalidPhoneError, normalizeMxPhone } from '../src/modules/booking/domain/phone.js';
import {
  InvalidDateError,
  SlotNotOfferedError,
  bookableSlot,
  generateSlots,
  localDateOf,
  type BusinessConfig,
} from '../src/modules/booking/domain/slots.js';

const demo: BusinessConfig = { slotMinutes: 45, serviceMinutes: 45, hours: { open: '09:00', close: '19:00' } };
const TZ = 'America/Mexico_City';
const MINUTE_MS = 60_000;
const SEVEN_PM_LOCAL = Date.parse('2026-11-16T01:00:00.000Z');

describe('normalizeMxPhone (RF4)', () => {
  it.each([
    '55 1234 5678',
    '+52 5512345678',
    '045 55 1234 5678',
    '044 55 1234 5678',
    '5512345678',
    '52 55 1234 5678',
    '+52 55-1234-5678',
    '(55) 1234-5678',
  ])('normalizes %s to 10 digits', (input) => {
    expect(normalizeMxPhone(input)).toBe('5512345678');
  });

  it.each([
    '12345',
    '',
    '551234567',
    '55123456789',
    '+1 555 123 4567',
    '+52 551234567',
    '+5255123456789',
    '0551234567',
    '1551234567',
    '55 1234 567a',
    '046 55 1234 5678',
    '53 55 1234 5678',
  ])('rejects %j', (input) => {
    expect(() => normalizeMxPhone(input)).toThrow(InvalidPhoneError);
  });

  it('never echoes the number in the error message', () => {
    expect(() => normalizeMxPhone('55 1234 567')).toThrow(expect.objectContaining({ message: expect.not.stringContaining('1234') }));
  });
});

describe('generateSlots (RF5)', () => {
  it('starts at 09:00 local, spaces slots 45 minutes and starts the last one before 19:00 local', () => {
    const slots = generateSlots('2026-11-15', demo);

    expect(slots[0]?.start.toISOString()).toBe('2026-11-15T15:00:00.000Z');
    expect(slots[0]?.end.toISOString()).toBe('2026-11-15T15:45:00.000Z');
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.start.getTime() - slots[i - 1]!.start.getTime()).toBe(45 * MINUTE_MS);
    }
    const last = slots.at(-1)!;
    expect(last.start.toISOString()).toBe('2026-11-16T00:45:00.000Z');
    expect(last.start.getTime()).toBeLessThan(SEVEN_PM_LOCAL);
    expect(slots).toHaveLength(14);
  });

  it('uses the service length for the slot end', () => {
    const slots = generateSlots('2026-11-15', { ...demo, serviceMinutes: 30 });
    expect(slots[0]?.end.toISOString()).toBe('2026-11-15T15:30:00.000Z');
  });

  it('derives the offset from the time zone database, not a fixed -6', () => {
    expect(generateSlots('2026-11-15', demo, 'America/Los_Angeles')[0]?.start.toISOString()).toBe(
      '2026-11-15T17:00:00.000Z',
    );
    expect(generateSlots('2026-07-15', demo, 'America/Los_Angeles')[0]?.start.toISOString()).toBe(
      '2026-07-15T16:00:00.000Z',
    );
  });

  it.each(['2026-02-30', '2026-13-01', '15-11-2026', '2026-11-5', '', '2026-11-15T00:00:00Z'])(
    'rejects the date %j',
    (date) => {
      expect(() => generateSlots(date, demo)).toThrow(InvalidDateError);
    },
  );
});

describe('localDateOf', () => {
  it('reads the calendar date in the business time zone', () => {
    expect(localDateOf(new Date('2026-11-16T00:45:00.000Z'), TZ)).toBe('2026-11-15');
    expect(localDateOf(new Date('2026-11-16T06:00:00.000Z'), TZ)).toBe('2026-11-16');
  });
});

describe('bookableSlot', () => {
  const now = new Date('2026-11-14T18:00:00.000Z');

  it('returns the offered slot that starts at the instant', () => {
    const slot = bookableSlot(new Date('2026-11-15T15:45:00.000Z'), demo, TZ, now);
    expect(slot).toEqual({ start: new Date('2026-11-15T15:45:00.000Z'), end: new Date('2026-11-15T16:30:00.000Z') });
  });

  it.each([
    ['off the grid', '2026-11-15T15:10:00.000Z'],
    ['before opening', '2026-11-15T14:15:00.000Z'],
    ['at closing', '2026-11-16T01:00:00.000Z'],
    ['already started', '2026-11-14T15:00:00.000Z'],
    ['starting now', '2026-11-14T18:00:00.000Z'],
  ])('rejects a slot %s', (_why, iso) => {
    expect(() => bookableSlot(new Date(iso), demo, TZ, now)).toThrow(SlotNotOfferedError);
  });

  it('rejects an invalid date', () => {
    expect(() => bookableSlot(new Date('nope'), demo, TZ, now)).toThrow(SlotNotOfferedError);
  });
});

describe('decideOnPayment', () => {
  it.each<[BookingStatus, Parameters<typeof decideOnPayment>[1], ReturnType<typeof decideOnPayment>]>([
    ['holding', 'PaymentSucceeded', { action: 'confirm', late: false }],
    ['expired', 'PaymentSucceeded', { action: 'confirm_if_free' }],
    ['confirmed', 'PaymentSucceeded', { action: 'refund_due', reason: 'already_paid' }],
    ['canceled', 'PaymentSucceeded', { action: 'refund_due', reason: 'booking_canceled' }],
    ['expired', 'LatePaymentReceived', { action: 'confirm_if_free' }],
    ['holding', 'LatePaymentReceived', { action: 'confirm', late: true }],
    ['canceled', 'LatePaymentReceived', { action: 'refund_due', reason: 'booking_canceled' }],
    ['confirmed', 'LatePaymentReceived', { action: 'refund_due', reason: 'already_paid' }],
    ['checked_in', 'LatePaymentReceived', { action: 'refund_due', reason: 'already_paid' }],
    ['holding', 'DuplicatePaymentReceived', { action: 'refund_due', reason: 'duplicate_payment' }],
    ['confirmed', 'DuplicatePaymentReceived', { action: 'refund_due', reason: 'duplicate_payment' }],
    ['expired', 'DuplicatePaymentReceived', { action: 'refund_due', reason: 'duplicate_payment' }],
  ])('booking %s + %s → %o', (status, event, decision) => {
    expect(decideOnPayment(status, event)).toEqual(decision);
  });
});
