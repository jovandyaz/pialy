const LAST_HOLD_KEY = 'pialy:last-hold';

/**
 * Remembers this tab's latest hold, so a customer who left its page can get back to it. Storage
 * can throw (private mode, blocked site data); the hold itself does not depend on it.
 */
export function rememberHold(token: string): void {
  try {
    window.sessionStorage.setItem(LAST_HOLD_KEY, token);
  } catch {
    return;
  }
}

/** The token of this tab's latest hold, if storage kept it. */
export function lastHold(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_HOLD_KEY);
  } catch {
    return null;
  }
}
