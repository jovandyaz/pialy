import { useCallback, useMemo, useRef } from 'react';

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
