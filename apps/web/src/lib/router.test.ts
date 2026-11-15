import { describe, expect, it } from 'vitest';
import { matchRoute, ROUTES, safeNext } from './router';

describe('safeNext', () => {
  it('keeps same-app paths', () => {
    expect(safeNext('/negocio')).toBe('/negocio');
    expect(safeNext('/c/abc?x=1')).toBe('/c/abc?x=1');
  });

  it.each([null, '', 'https://evil.com', '//evil.com', '/\\evil.com', '/\\\\evil.com', '/a\\b'])(
    'falls back to the board for %s',
    (value) => {
      expect(safeNext(value)).toBe(ROUTES.board);
    },
  );
});

describe('matchRoute', () => {
  it('serves the landing at the root and the demo booking at /estudio-demo', () => {
    expect(matchRoute('/', '')).toEqual({ name: 'landing' });
    expect(matchRoute('/estudio-demo', '')).toEqual({ name: 'book' });
    expect(matchRoute('/estudio-demo/', '')).toEqual({ name: 'book' });
    expect(ROUTES.book).toBe('/estudio-demo');
  });
});
