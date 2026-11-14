import { RailRejectedError, RailUnavailableError } from '@pialy/payments';
import { DatabaseQueryError } from '../infrastructure/db/errors.js';

/** Phone numbers and CLABEs inside error text are cut down to nothing before logging. */
const LONG_DIGIT_RUN = /\d{10,}/g;
const REDACTED = '[redacted]';

export interface SafeError {
  readonly name: string;
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
}

/**
 * What of an error a background job may log. Rail errors keep only their name and status: the
 * provider's text can echo the phone that was charged. Database errors keep their SQLSTATE.
 */
export function safeError(error: unknown): SafeError {
  if (error instanceof RailUnavailableError || error instanceof RailRejectedError) {
    return error.status === undefined ? { name: error.name } : { name: error.name, status: error.status };
  }
  if (error instanceof DatabaseQueryError) {
    return error.code === undefined ? { name: error.name } : { name: error.name, code: error.code };
  }
  if (error instanceof Error) return { name: error.name, message: error.message.replace(LONG_DIGIT_RUN, REDACTED) };
  return { name: typeof error };
}
