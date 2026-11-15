import { ROUTES } from './router';

/** Must match the server's booking token shape (128-bit base64url); nothing else can name a pass. */
const PASS_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const VERIFY_PREFIX = ROUTES.verify('');
const TRAILING_SLASH = /\/$/;

/** The booking token in a scanned pass QR (`<origin>/negocio/verificar/<token>` on this same origin), or `null`. */
export function scannedPassToken(code: string, origin: string): string | null {
  const url = absoluteUrl(code.trim());
  if (url === null || url.origin !== origin || !url.pathname.startsWith(VERIFY_PREFIX)) return null;
  const token = url.pathname.slice(VERIFY_PREFIX.length).replace(TRAILING_SLASH, '');
  return PASS_TOKEN.test(token) ? token : null;
}

/** The booking token in a typed pass code: the bare token printed on the pass, or a pasted pass URL; `null` otherwise. */
export function typedPassToken(code: string, origin: string): string | null {
  const value = code.trim();
  return PASS_TOKEN.test(value) ? value : scannedPassToken(value, origin);
}

function absoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
