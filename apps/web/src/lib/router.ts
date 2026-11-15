import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';

export const ROUTES = {
  landing: '/',
  book: '/estudio-demo',
  booking: (token: string) => `/c/${encodeURIComponent(token)}`,
  board: '/negocio',
  login: '/negocio/entrar',
  verify: (token: string) => `/negocio/verificar/${encodeURIComponent(token)}`,
} as const;

export const NEXT_PARAM = 'siguiente';

export type Route =
  | { readonly name: 'landing' }
  | { readonly name: 'book' }
  | { readonly name: 'booking'; readonly token: string }
  | { readonly name: 'board' }
  | { readonly name: 'login'; readonly next: string }
  | { readonly name: 'verify'; readonly token: string }
  | { readonly name: 'notFound' };

const BOOKING_PATH = /^\/c\/([^/]+)\/?$/;
const VERIFY_PATH = /^\/negocio\/verificar\/([^/]+)\/?$/;
const TRAILING_SLASH = /\/+$/;

/** Only same-app paths are followed after login, never another origin. */
export function safeNext(value: string | null): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return ROUTES.board;
  return value;
}

export function matchRoute(pathname: string, search: string): Route {
  const path = pathname === '/' ? '/' : pathname.replace(TRAILING_SLASH, '');
  if (path === ROUTES.landing) return { name: 'landing' };
  if (path === ROUTES.book) return { name: 'book' };
  if (path === ROUTES.board) return { name: 'board' };
  if (path === ROUTES.login) return { name: 'login', next: safeNext(new URLSearchParams(search).get(NEXT_PARAM)) };
  const booking = BOOKING_PATH.exec(path)?.[1];
  if (booking !== undefined) return { name: 'booking', token: decodeURIComponent(booking) };
  const verify = VERIFY_PATH.exec(path)?.[1];
  if (verify !== undefined) return { name: 'verify', token: decodeURIComponent(verify) };
  return { name: 'notFound' };
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

const location = (): string => window.location.pathname + window.location.search;

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.scrollTo(0, 0);
  for (const listener of listeners) listener();
}

/** Click handler for same-origin `<a>` links: client-side navigation, but keeps modifier-click/new-tab behavior. */
export function spaLink(to: string) {
  return (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  };
}

export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, location);
  const url = new URL(href, window.location.origin);
  return matchRoute(url.pathname, url.search);
}

export function loginPath(next: string): string {
  return `${ROUTES.login}?${NEXT_PARAM}=${encodeURIComponent(next)}`;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Pialy`;
  }, [title]);
}
