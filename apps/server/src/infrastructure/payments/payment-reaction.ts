import type { PaymentEvent } from '@pialy/payments';
import { onPaymentEvent } from '../../modules/booking/application/on-payment-event.js';
import { createDrizzleBookingPaymentStore } from '../booking/drizzle-booking-repository.js';
import type { DbTx } from '../db/client.js';

/** Runs inside the unit of work that applied the payment. */
export type PaymentReaction = (tx: DbTx, event: PaymentEvent) => Promise<void>;

export const paymentReaction: PaymentReaction = (tx, event) =>
  onPaymentEvent(createDrizzleBookingPaymentStore(tx), event);
