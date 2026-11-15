import { describe, expect, it } from 'vitest';
import { scannedPassToken, typedPassToken } from './pass-code';

const ORIGIN = 'https://pialy.example';
const TOKEN = 'Xk3_9fQe-2LmNpRsTuVwYz';
const PASS_URL = `${ORIGIN}/negocio/verificar/${TOKEN}`;

const NOT_A_PASS_URL = [
  ['another origin', `https://evil.example/negocio/verificar/${TOKEN}`],
  ['another scheme', `http://pialy.example/negocio/verificar/${TOKEN}`],
  ['another port', `https://pialy.example:8443/negocio/verificar/${TOKEN}`],
  ['a lookalike host', `https://pialy.example.evil.example/negocio/verificar/${TOKEN}`],
  ['this host as userinfo of another', `https://pialy.example@evil.example/negocio/verificar/${TOKEN}`],
  ['the booking page', `${ORIGIN}/c/${TOKEN}`],
  ['the board', `${ORIGIN}/negocio`],
  ['a nested path', `${PASS_URL}/extra`],
  ['a prefixed path', `${ORIGIN}/x/negocio/verificar/${TOKEN}`],
  ['a too short token', `${ORIGIN}/negocio/verificar/abc`],
  ['a too long token', `${ORIGIN}/negocio/verificar/${'a'.repeat(65)}`],
  ['an encoded token', `${ORIGIN}/negocio/verificar/abc%2Fdefghijklmnopqrs`],
  ['a malformed encoding', `${ORIGIN}/negocio/verificar/%E0%A4%Aabcdefghijklmnop`],
  ['an empty token', `${ORIGIN}/negocio/verificar/`],
  ['two trailing slashes', `${PASS_URL}//`],
  ['an encoded dot segment leaving the verify path', `${ORIGIN}/negocio/verificar/%2e%2e/${TOKEN}`],
  ['a dot segment dropping the token', `${PASS_URL}/..`],
] as const;

/** URL parsing normalizes these to the verify path; only the token is used, never the rest of the URL. */
const NORMALIZED_PASS_URL = [
  ['userinfo on this host', `https://user:pw@pialy.example/negocio/verificar/${TOKEN}`],
  ['a query', `${PASS_URL}?utm_source=whatsapp`],
  ['a hash', `${PASS_URL}#pase`],
  ['one trailing slash', `${PASS_URL}/`],
  ['a dot segment back into the verify path', `${ORIGIN}/c/../negocio/verificar/${TOKEN}`],
  ['a dot segment inside the verify path', `${ORIGIN}/negocio/verificar/x/../${TOKEN}`],
  ['a current-directory segment', `${ORIGIN}/negocio/verificar/./${TOKEN}`],
] as const;

const NOT_A_CODE = ['', '   ', 'hola', 'abc def ghi jkl mno pqr', 'javascript:alert(1)', `${TOKEN}!`, 'WIFI:S:casa;T:WPA;P:secreto;;'];

describe('scannedPassToken', () => {
  it('reads the token from a pass URL on this origin', () => {
    expect(scannedPassToken(PASS_URL, ORIGIN)).toBe(TOKEN);
    expect(scannedPassToken(`  ${PASS_URL}/\n`, ORIGIN)).toBe(TOKEN);
  });

  it.each(NORMALIZED_PASS_URL)('reads the token from a pass URL with %s', (_case, value) => {
    expect(scannedPassToken(value, ORIGIN)).toBe(TOKEN);
  });

  it('rejects a bare token: a pass QR always carries the full URL', () => {
    expect(scannedPassToken(TOKEN, ORIGIN)).toBeNull();
  });

  it.each(NOT_A_PASS_URL)('rejects a URL with %s', (_case, value) => {
    expect(scannedPassToken(value, ORIGIN)).toBeNull();
  });

  it.each(NOT_A_CODE)('rejects %j', (value) => {
    expect(scannedPassToken(value, ORIGIN)).toBeNull();
  });
});

describe('typedPassToken', () => {
  it('accepts the bare token shown on the pass', () => {
    expect(typedPassToken(TOKEN, ORIGIN)).toBe(TOKEN);
    expect(typedPassToken(` ${TOKEN} `, ORIGIN)).toBe(TOKEN);
  });

  it('accepts a pasted pass URL on this origin', () => {
    expect(typedPassToken(PASS_URL, ORIGIN)).toBe(TOKEN);
  });

  it.each(NORMALIZED_PASS_URL)('accepts a pasted pass URL with %s', (_case, value) => {
    expect(typedPassToken(value, ORIGIN)).toBe(TOKEN);
  });

  it.each(NOT_A_PASS_URL)('rejects a URL with %s', (_case, value) => {
    expect(typedPassToken(value, ORIGIN)).toBeNull();
  });

  it.each(NOT_A_CODE)('rejects %j', (value) => {
    expect(typedPassToken(value, ORIGIN)).toBeNull();
  });
});
