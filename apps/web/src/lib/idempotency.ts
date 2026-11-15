import { useCallback, useMemo, useRef } from 'react';
import { ApiError, HTTP_CONFLICT } from '../api';

const NETWORK_FAILURE_STATUS = 0;
const FIRST_ERROR_STATUS = 400;
const REQUEST_IN_PROGRESS_TYPE = 'urn:pialy:problem:request-in-progress';

/**
 * Keep the Idempotency-Key only when the outcome is unknown (network failure, or the server is
 * still processing the same key). Any other error is final and the server stored it on the key, so
 * a retry must use a new one.
 */
export function shouldKeepKey(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  // 0 = network failure; 1xx-3xx = the call succeeded but the response was unusable (unseen success).
  if (error.status === NETWORK_FAILURE_STATUS || error.status < FIRST_ERROR_STATUS) return true;
  return error.status === HTTP_CONFLICT && error.problem?.['type'] === REQUEST_IN_PROGRESS_TYPE;
}

export interface IdempotencyKeys {
  readonly keyFor: (payload: string) => string;
  readonly reset: () => void;
}

/**
 * One Idempotency-Key per intent: the same key while the payload is unchanged, so a retry after a
 * lost response cannot charge twice; a fresh one when the payload changes or after `reset`.
 */
export function useIdempotencyKey(): IdempotencyKeys {
  const current = useRef<{ payload: string; key: string } | null>(null);
  const keyFor = useCallback((payload: string) => {
    if (current.current?.payload !== payload) current.current = { payload, key: crypto.randomUUID() };
    return current.current.key;
  }, []);
  const reset = useCallback(() => {
    current.current = null;
  }, []);
  return useMemo(() => ({ keyFor, reset }), [keyFor, reset]);
}
