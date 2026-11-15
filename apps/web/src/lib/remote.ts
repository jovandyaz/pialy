import { ApiError } from '../api';

export const REMOTE = { loading: 'loading', ready: 'ready', error: 'error' } as const;

export type Remote<T> =
  | { readonly kind: typeof REMOTE.loading }
  | { readonly kind: typeof REMOTE.ready; readonly data: T }
  | { readonly kind: typeof REMOTE.error; readonly detail: string; readonly status: number };

export const loading = <T,>(): Remote<T> => ({ kind: REMOTE.loading });
export const ready = <T,>(data: T): Remote<T> => ({ kind: REMOTE.ready, data });

const GENERIC_DETAIL = 'Algo salió mal. Intenta de nuevo.';
const UNKNOWN_STATUS = 0;

export function failed<T>(error: unknown): Remote<T> {
  return error instanceof ApiError
    ? { kind: REMOTE.error, detail: error.detail, status: error.status }
    : { kind: REMOTE.error, detail: GENERIC_DETAIL, status: UNKNOWN_STATUS };
}

export function errorDetail(error: unknown): string {
  return error instanceof ApiError ? error.detail : GENERIC_DETAIL;
}
