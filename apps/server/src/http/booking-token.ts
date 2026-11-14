import { z } from 'zod';

/** Booking tokens are 128-bit base64url strings; anything else cannot name a booking. */
const BOOKING_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

const tokenParams = z.object({ token: z.string().regex(BOOKING_TOKEN) });

/** The `:token` route parameter when it can be a booking token, otherwise `null`. */
export function bookingTokenParam(params: unknown): string | null {
  const parsed = tokenParams.safeParse(params);
  return parsed.success ? parsed.data.token : null;
}
