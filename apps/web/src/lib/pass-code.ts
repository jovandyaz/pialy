import { ROUTES } from './router';

/** Must match the server's booking token shape (128-bit base64url); nothing else can name a pass. */
const PASS_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const VERIFY_PREFIX = ROUTES.verify('');
const TRAILING_SLASH = /\/$/;

/**
 * The booking token in a scanned or typed pass code, or `null` when it is not a Pialy pass.
 * Accepts the pass QR (`<origin>/negocio/verificar/<token>` on this same origin) or the bare token.
 */
export function passTokenFrom(code: string, origin: string): string | null {
  const value = code.trim();
  if (PASS_TOKEN.test(value)) return value;
  const url = absoluteUrl(value);
  if (url === null || url.origin !== origin || !url.pathname.startsWith(VERIFY_PREFIX)) return null;
  const token = url.pathname.slice(VERIFY_PREFIX.length).replace(TRAILING_SLASH, '');
  return PASS_TOKEN.test(token) ? token : null;
}

function absoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
