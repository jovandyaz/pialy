import { describe, expect, it } from 'vitest';
import { passTokenFrom } from './pass-code';

const ORIGIN = 'https://pialy.example';
const TOKEN = 'Xk3_9fQe-2LmNpRsTuVwYz';

describe('passTokenFrom', () => {
  it('reads the token from a pass URL on this origin', () => {
    expect(passTokenFrom(`${ORIGIN}/negocio/verificar/${TOKEN}`, ORIGIN)).toBe(TOKEN);
    expect(passTokenFrom(`  ${ORIGIN}/negocio/verificar/${TOKEN}/\n`, ORIGIN)).toBe(TOKEN);
  });

  it('accepts a bare token, as typed from the pass', () => {
    expect(passTokenFrom(TOKEN, ORIGIN)).toBe(TOKEN);
    expect(passTokenFrom(` ${TOKEN} `, ORIGIN)).toBe(TOKEN);
  });

  it.each([
    ['another origin', `https://evil.example/negocio/verificar/${TOKEN}`],
    ['another scheme', `http://pialy.example/negocio/verificar/${TOKEN}`],
    ['another port', `https://pialy.example:8443/negocio/verificar/${TOKEN}`],
    ['a lookalike host', `https://pialy.example.evil.example/negocio/verificar/${TOKEN}`],
  ])('rejects a pass URL from %s', (_case, value) => {
    expect(passTokenFrom(value, ORIGIN)).toBeNull();
  });

  it.each([
    ['the booking page', `${ORIGIN}/c/${TOKEN}`],
    ['the board', `${ORIGIN}/negocio`],
    ['a nested path', `${ORIGIN}/negocio/verificar/${TOKEN}/extra`],
    ['a prefixed path', `${ORIGIN}/x/negocio/verificar/${TOKEN}`],
  ])('rejects a same-origin URL to %s', (_case, value) => {
    expect(passTokenFrom(value, ORIGIN)).toBeNull();
  });

  it.each([
    ['too short', `${ORIGIN}/negocio/verificar/abc`],
    ['too long', `${ORIGIN}/negocio/verificar/${'a'.repeat(65)}`],
    ['encoded characters', `${ORIGIN}/negocio/verificar/abc%2Fdefghijklmnopqrs`],
    ['malformed encoding', `${ORIGIN}/negocio/verificar/%E0%A4%Aabcdefghijklmnop`],
    ['an empty token', `${ORIGIN}/negocio/verificar/`],
  ])('rejects a pass URL with a token that is %s', (_case, value) => {
    expect(passTokenFrom(value, ORIGIN)).toBeNull();
  });

  it.each(['', '   ', 'hola', 'abc def ghi jkl mno pqr', 'javascript:alert(1)', `${TOKEN}!`, 'WIFI:S:casa;T:WPA;P:secreto;;'])(
    'rejects %j',
    (value) => {
      expect(passTokenFrom(value, ORIGIN)).toBeNull();
    },
  );
});
