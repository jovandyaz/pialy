import type { BusinessConfig } from '../domain/slots.js';

/** The business that takes bookings, with the one resource its slots belong to. */
export interface BookableBusiness extends BusinessConfig {
  readonly businessId: string;
  readonly resourceId: string;
  readonly timezone: string;
}
