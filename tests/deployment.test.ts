import request from 'supertest';
import { describe, expect, it } from 'vitest';
import vercelEntry, { createMisconfiguredApp } from '../src/app.js';
import { ConfigError } from '../src/config/ConfigError.js';
import { createConnectionCache } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { authCookieOptions } from '../src/modules/auth/auth.cookies.js';
import { redact } from '../src/utils/logger.js';
import { api, createUser, rawApi } from './helpers.js';

const FRONTEND = 'http://localhost:5173';

const productionEnv = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/secure_notes',
  JWT_SECRET: 'a-production-grade-secret-value-that-is-long-enough',
  FRONTEND_URL: 'https://secure-notes-frontend.vercel.app',
  ...overrides,
});

describe('GET /api/health', () => {
  it('reports the service and database as healthy, uncached', async () => {
    const res = await rawApi().get('/api/health').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      success: true,
      message: 'Service healthy',
      data: { status: 'ok', database: 'connected', environment: 'test' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb:\/\/|127\.0\.0\.1/);
  });

  it('serves a small JSON index at the root instead of a 404', async () => {
    const res = await rawApi().get('/').expect(200);
    expect(res.body.data).toEqual({ health: '/api/health' });
  });
});

describe('Vercel entry point (src/app.ts default export)', () => {
  it('delegates every request to the real application', async () => {
    const res = await request(vercelEntry).get('/api/health').expect(200);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'connected' });
    await request(vercelEntry).get('/api/unknown').expect(404);
  });

  it('answers with a JSON 500 naming invalid variables instead of crashing', async () => {
    let configError: unknown;
    try {
      loadEnv(productionEnv({ FRONTEND_URL: undefined, JWT_SECRET: 'too-short-secret-value' }));
    } catch (error) {
      configError = error;
    }
    expect(configError).toBeInstanceOf(ConfigError);

    const fallback = createMisconfiguredApp(configError as ConfigError);
    const res = await request(fallback).get('/api/health').expect(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      success: false,
      message: 'Server misconfigured: invalid environment variables. See the deployment logs.',
      errors: [
        { field: 'JWT_SECRET', message: 'JWT_SECRET must be at least 32 characters' },
        {
          field: 'FRONTEND_URL',
          message: 'FRONTEND_URL is required in production (the exact frontend origin)',
        },
      ],
    });
    // Variable names only: no values (secret, URI) are ever echoed.
    expect(JSON.stringify(res.body)).not.toMatch(/too-short-secret-value|user:pass|mongodb\+srv/);
    await request(fallback).post('/api/auth/login').send({}).expect(500);
  });
});

describe('CSRF protection (cookie auth)', () => {
  it('rejects a cookie-authenticated write without the X-Requested-With header', async () => {
    const user = await createUser();
    const res = await rawApi()
      .post('/api/notes')
      .set('Cookie', user.cookie)
      .send({ title: 'forged' })
      .expect(403);
    expect(res.body.message).toBe('Missing X-Requested-With header');
  });

  it('rejects writes from an origin that is not the configured frontend', async () => {
    const user = await createUser();
    const res = await api()
      .post('/api/notes')
      .set('Cookie', user.cookie)
      .set('Origin', 'https://evil.example')
      .send({ title: 'forged' })
      .expect(403);
    expect(res.body.message).toBe('Cross-site request blocked: origin not allowed');

    // Login CSRF from another site is blocked too (no cookie involved).
    await rawApi()
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.com', password: 'x' })
      .expect(403);
  });

  it('allows the configured frontend origin with the header', async () => {
    const user = await createUser();
    await api()
      .post('/api/notes')
      .set('Cookie', user.cookie)
      .set('Origin', FRONTEND)
      .send({ title: 'legit' })
      .expect(201);
  });

  it('does not require the header for Bearer-token clients (no cookie to abuse)', async () => {
    const user = await createUser();
    const token = user.cookie.split('=')[1]!;
    await rawApi()
      .post('/api/notes')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'api client' })
      .expect(201);
  });

  it('never blocks safe methods', async () => {
    const user = await createUser();
    await rawApi().get('/api/notes').set('Cookie', user.cookie).expect(200);
  });
});

describe('CORS', () => {
  it('answers a credentialed preflight from the frontend origin', async () => {
    const res = await rawApi()
      .options('/api/notes')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-requested-with')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Requested-With/);
  });

  it('gives no CORS grant to other origins (never a wildcard)', async () => {
    const res = await rawApi()
      .options('/api/notes')
      .set('Origin', 'https://attacker.vercel.app')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('environment validation (loadEnv)', () => {
  it('accepts a complete production configuration', () => {
    const config = loadEnv(productionEnv());
    expect(config.corsOrigins).toEqual(['https://secure-notes-frontend.vercel.app']);
    expect(config.cookie).toEqual({ secure: true, sameSite: 'none', partitioned: true });
    expect(config.mongoAutoIndex).toBe(false);
  });

  it('normalises FRONTEND_URL to exact origins and supports several', () => {
    const config = loadEnv(
      productionEnv({
        FRONTEND_URL: 'https://secure-notes-frontend.vercel.app/, https://notes.example.com/app',
      }),
    );
    expect(config.corsOrigins).toEqual([
      'https://secure-notes-frontend.vercel.app',
      'https://notes.example.com',
    ]);
  });

  it.each([
    ['missing FRONTEND_URL', { FRONTEND_URL: undefined }, /FRONTEND_URL is required/],
    ['wildcard origin', { FRONTEND_URL: 'https://*.vercel.app' }, /wildcards are not allowed/],
    ['localhost in production', { FRONTEND_URL: 'https://localhost:5173' }, /not be localhost/],
    ['plain http in production', { FRONTEND_URL: 'http://notes.example.com' }, /must use https/],
    ['missing MONGODB_URI', { MONGODB_URI: undefined }, /MONGODB_URI is required/],
    ['non-mongo URI', { MONGODB_URI: 'postgres://x' }, /must start with mongodb/],
    [
      'placeholder secret',
      { JWT_SECRET: 'replace-with-a-long-random-secret-of-at-least-32-chars' },
      /placeholder/,
    ],
    ['short secret', { JWT_SECRET: 'short' }, /at least 32/],
    ['SameSite=None without Secure', { COOKIE_SECURE: 'false' }, /requires secure cookies/],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => loadEnv(productionEnv(overrides))).toThrow(message);
  });

  it('never echoes secret values in validation errors', () => {
    try {
      loadEnv(productionEnv({ JWT_SECRET: 'short', FRONTEND_URL: 'not a url' }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toMatch(/user:pass|short|not a url/);
    }
  });

  it('only allows localhost origins outside production', () => {
    const dev = loadEnv({ ...productionEnv(), NODE_ENV: 'development', FRONTEND_URL: undefined });
    expect(dev.corsOrigins).toContain('http://localhost:5173');
    expect(dev.cookie).toEqual({ secure: false, sameSite: 'strict', partitioned: false });

    const prod = loadEnv(productionEnv());
    expect(prod.corsOrigins.some((origin) => origin.includes('localhost'))).toBe(false);
  });

  it('trusts exactly one proxy hop on Vercel', () => {
    expect(loadEnv(productionEnv({ VERCEL: '1' })).trustProxy).toBe(1);
    expect(loadEnv(productionEnv()).trustProxy).toBe(0);
  });
});

describe('auth cookie attributes', () => {
  it('production: HttpOnly; Secure; SameSite=None; Partitioned; Path=/api', () => {
    const options = authCookieOptions(loadEnv(productionEnv()).cookie);
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/api',
    });
  });
});

describe('serverless connection cache', () => {
  it('shares one in-flight connect between concurrent cold-start requests', async () => {
    let opened = 0;
    const cache = createConnectionCache(async () => {
      opened += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'connection';
    });
    const results = await Promise.all([cache.connect(), cache.connect(), cache.connect()]);
    expect(results).toEqual(['connection', 'connection', 'connection']);
    await cache.connect(); // warm instance: reused
    expect(opened).toBe(1);
  });

  it('does not cache failures: the next request retries', async () => {
    let attempts = 0;
    const cache = createConnectionCache(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('Atlas unreachable'))
        : Promise.resolve('connection');
    });
    await expect(cache.connect()).rejects.toThrow('Atlas unreachable');
    await expect(cache.connect()).resolves.toBe('connection');
    expect(attempts).toBe(2);
  });
});

describe('log redaction', () => {
  it('removes credentials from MongoDB connection strings', () => {
    const text =
      'MongoServerSelectionError: mongodb+srv://admin:S3cr3t@cluster0.abc.mongodb.net/db and mongodb://u:p@localhost';
    expect(redact(text)).toBe(
      'MongoServerSelectionError: mongodb+srv://***:***@cluster0.abc.mongodb.net/db and mongodb://***:***@localhost',
    );
  });
});
