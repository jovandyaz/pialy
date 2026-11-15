import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { openTestDb, TEST_DATABASE_URL, TEST_PIN, testDeps } from './support.js';

const handle = openTestDb();
const root = mkdtempSync(join(tmpdir(), 'pialy-web-'));
const INDEX = '<!doctype html><title>pialy</title><div id="root"></div>';

function depsWithWebRoot(webRoot: string) {
  const base = testDeps(handle);
  return {
    ...base,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      PHONE_HASH_SALT: 'test-phone-hash-salt',
      BUSINESS_PIN: TEST_PIN,
      COOKIE_SECRET: 'test-cookie-secret-test-cookie-secret',
      WEB_ROOT: webRoot,
    }),
  };
}

mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), INDEX);
writeFileSync(join(root, 'assets', 'x.js'), 'console.log(1)');
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await handle.close();
});

describe('web app serving', () => {
  const app = buildApp(depsWithWebRoot(root));
  afterAll(() => app.close());

  it('serves index.html at / without caching', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/negocio/verificar/abc', '/c/tok', '/negocio', '/negocio/entrar'])(
    'falls back to index.html for the client route %s',
    async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX);
      expect(res.headers['cache-control']).toBe('no-cache');
    },
  );

  it('serves assets with a long immutable cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/x.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps problem+json 404 for unknown API paths and missing files', async () => {
    for (const url of ['/api/nope', '/assets/missing.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toEqual({ type: 'about:blank', title: 'Not Found', status: 404 });
    }
  });

  it('keeps problem+json 404 for unknown non-GET requests', async () => {
    const res = await app.inject({ method: 'POST', url: '/negocio' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('leaves existing routes unaffected', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: true });
  });

  it('skips static serving when the directory is missing', async () => {
    const bare = buildApp(depsWithWebRoot(join(root, 'does-not-exist')));
    const res = await bare.inject({ method: 'GET', url: '/negocio' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    await bare.close();
  });
});
