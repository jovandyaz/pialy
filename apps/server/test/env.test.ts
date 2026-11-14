import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const DATABASE_URL = 'postgres://x:y@h/db';
const prodEnv = {
  NODE_ENV: 'production',
  DATABASE_URL,
  PEY_API_KEY: 'k',
  PEY_WEBHOOK_SECRET: 'whsec_x',
  PEY_BASE_URL: 'https://pey.example',
  BUSINESS_PIN: '1234',
  COOKIE_SECRET: 'c'.repeat(32),
  PHONE_HASH_SALT: 's'.repeat(16),
  PUBLIC_BASE_URL: 'https://pialy.example',
};

describe('parseEnv', () => {
  it('accepts a minimal development env with defaults', () => {
    const r = parseEnv({ DATABASE_URL });
    expect(r.ok && r.env.PORT).toBe(3000);
    expect(r.ok && r.env.DEMO_DEPOSIT_CENTS).toBe(1);
  });

  it('requires DATABASE_URL', () => {
    expect(parseEnv({}).ok).toBe(false);
  });

  it('rejects any deposit other than 1', () => {
    expect(parseEnv({ DATABASE_URL, DEMO_DEPOSIT_CENTS: '2' }).ok).toBe(false);
    expect(parseEnv({ DATABASE_URL, DEMO_DEPOSIT_CENTS: '1' }).ok).toBe(true);
  });

  it('requires every secret in production', () => {
    expect(parseEnv(prodEnv).ok).toBe(true);
    const missing: Record<string, string> = { ...prodEnv };
    delete missing.PEY_API_KEY;
    const r = parseEnv(missing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).toContain('PEY_API_KEY');
  });

  it('never echoes values in problems', () => {
    const r = parseEnv({ DATABASE_URL, DEMO_DEPOSIT_CENTS: '777' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).not.toContain('777');
  });

  it('reads PORT as a number', () => {
    const r = parseEnv({ DATABASE_URL, PORT: '8080' });
    expect(r.ok && r.env.PORT).toBe(8080);
  });
});
