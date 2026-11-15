import { DUPLICATE_PAYMENT_REASON, FLAG_KIND, type BookingStatus, type Flag, type SlotState } from '../api';

export const TONES = ['hold', 'paid', 'late', 'free', 'done', 'gone'] as const;
export type Tone = (typeof TONES)[number];

export interface StatusLook {
  readonly tone: Tone;
  readonly label: string;
}

const BOOKING: Readonly<Record<BookingStatus, StatusLook>> = {
  holding: { tone: 'hold', label: 'Apartando' },
  confirmed: { tone: 'paid', label: 'Anticipo pagado' },
  checked_in: { tone: 'done', label: 'Atendida' },
  expired: { tone: 'gone', label: 'Vencido' },
  canceled: { tone: 'gone', label: 'Cancelada' },
};

const LATE: StatusLook = { tone: 'late', label: 'Tardío' };

export const FREE_LOOK: StatusLook = { tone: 'free', label: 'Libre' };

/** Color only ever says payment state: a late payment that still confirmed reads as Tardío. */
export function bookingLook(status: BookingStatus, late: boolean): StatusLook {
  return late && status === 'confirmed' ? LATE : BOOKING[status];
}

export const SLOT_LABEL: Readonly<Record<SlotState | 'selected', string>> = {
  free: 'Libre',
  held: 'Alguien paga',
  taken: 'Ocupado',
  selected: 'Elegido',
};

export const PAID_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>(['confirmed', 'checked_in']);

export const isPaid = (status: BookingStatus): boolean => PAID_STATUSES.has(status);

/** Alert title for an open flag on the owner's board. */
export function flagTitle(flag: Flag): string {
  if (flag.kind === FLAG_KIND.unmatchedPayment) return 'Pago sin reserva · devolución pendiente';
  if (flag.kind === FLAG_KIND.amountMismatch) return 'Monto distinto · revisar pago';
  if (flag.kind === FLAG_KIND.unknown) return 'Pago por revisar';
  if (isDuplicatePayment(flag)) return 'Pago repetido · devolución pendiente';
  return 'Pago tardío · devolución pendiente';
}

export const isDuplicatePayment = (flag: Flag): boolean =>
  flag.kind === FLAG_KIND.refundDue && flag.reason === DUPLICATE_PAYMENT_REASON;

/** Flags whose next action is a manual SPEI refund rather than a review. */
export const needsRefund = (flag: Flag): boolean =>
  flag.kind === FLAG_KIND.refundDue || flag.kind === FLAG_KIND.unmatchedPayment;
