import { ApiError, HTTP_UNAUTHORIZED } from '../api';
import { loginPath, navigate } from './router';

/** Sends the owner to the PIN screen when the session is missing or expired; returns whether it did. */
export function redirectIfLoggedOut(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== HTTP_UNAUTHORIZED) return false;
  navigate(loginPath(window.location.pathname + window.location.search), { replace: true });
  return true;
}
