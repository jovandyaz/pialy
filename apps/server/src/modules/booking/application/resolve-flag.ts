import type { Clock } from '@pialy/payments';

/** Closes an open flag with the owner's note. Throws `FlagNotFoundError` when none is open under the id. */
export interface ResolveFlagStore {
  resolve(flagId: string, note: string, at: Date): Promise<void>;
}

export function resolveFlag(
  deps: { readonly store: ResolveFlagStore; readonly clock: Clock },
  flagId: string,
  note: string,
): Promise<Date> {
  const at = deps.clock.now();
  return deps.store.resolve(flagId, note, at).then(() => at);
}
