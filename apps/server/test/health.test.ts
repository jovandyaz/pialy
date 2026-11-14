import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/infrastructure/db/client.js';
import { openTestDb, testDeps } from './support.js';

const handle = openTestDb();
afterAll(() => handle.close());

describe('GET /healthz', () => {
  it('reports ok with a reachable database', async () => {
    const app = buildApp(testDeps(handle));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: true });
    await app.close();
  });

  it('answers 503 when the database is unreachable', async () => {
    const dead = createDb('postgres://postgres:postgres@127.0.0.1:1/none');
    const app = buildApp(testDeps(dead));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: false });
    await app.close();
    await dead.close();
  });

  it('sets security headers', async () => {
    const app = buildApp(testDeps(handle));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });
});

describe('problem details', () => {
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    app = buildApp(testDeps(handle));
    app.get('/boom', () => {
      throw new Error('secret internal detail with stack');
    });
    app.post('/json', (_req, reply) => reply.send({}));
    await app.ready();
  });
  afterAll(() => app.close());

  it('returns RFC 9457 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({ type: 'about:blank', title: 'Not Found', status: 404 });
  });

  it('hides details of unexpected errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({ type: 'about:blank', title: 'Internal Server Error', status: 500 });
    expect(res.body).not.toContain('secret internal detail');
    expect(res.body).not.toContain('stack');
  });

  it('maps client errors to 4xx problems', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().status).toBe(400);
  });
});

describe('log redaction', () => {
  it('redacts secrets and phone numbers', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const app = buildApp(testDeps(handle, { logStream }));
    app.log.info(
      {
        // `headers` has no serializer, unlike Fastify's `req`, so redaction is what hides these.
        headers: { authorization: 'Bearer SECRETTOKEN', 'webhook-signature': 'v1,SIGVALUE' },
        phone: '5500000001',
        phoneNumber: '5500000002',
        PEY_API_KEY: 'TOPAPIKEY',
        PEY_WEBHOOK_SECRET: 'TOPSECRET',
        customer: { phone: '5512345678', phoneNumber: '5587654321' },
        cfg: { PEY_API_KEY: 'APIKEYVALUE', PEY_WEBHOOK_SECRET: 'NESTEDSECRET' },
      },
      'probe',
    );
    await app.close();
    const out = chunks.join('');
    for (const leaked of [
      'SECRETTOKEN',
      'SIGVALUE',
      '5500000001',
      '5500000002',
      'TOPAPIKEY',
      'TOPSECRET',
      '5512345678',
      '5587654321',
      'APIKEYVALUE',
      'NESTEDSECRET',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[redacted]');
  });
});
