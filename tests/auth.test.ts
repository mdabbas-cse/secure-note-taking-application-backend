import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { User } from '../src/models/User.model.js';
import { api, authCookie, createUser, DEFAULT_PASSWORD } from './helpers.js';

const validRegistration = {
  name: 'Abbas',
  email: 'Abbas@Example.com ',
  password: 'S3cure-password',
  interests: ['Chess', 'reading', 'chess'],
};

function cookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((cookie) => cookie.startsWith('access_token=')) ?? '';
}

describe('POST /api/auth/register', () => {
  it('registers a user, hashes the password and sets an HttpOnly auth cookie', async () => {
    const res = await api().post('/api/auth/register').send(validRegistration).expect(201);

    expect(res.body).toMatchObject({
      success: true,
      message: 'Registration successful',
      data: {
        user: {
          name: 'Abbas',
          email: 'abbas@example.com', // normalised
          role: 'user',
          interests: ['chess', 'reading'], // normalised + de-duplicated
        },
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/);

    const cookie = cookieHeader(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api/);

    const stored = await User.findOne({ email: 'abbas@example.com' }).select('+password').lean();
    expect(stored?.password).toMatch(/^\$2[aby]\$/);
    expect(stored?.password).not.toBe(validRegistration.password);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await api().post('/api/auth/register').send(validRegistration).expect(201);
    const res = await api()
      .post('/api/auth/register')
      .send({ ...validRegistration, email: 'ABBAS@example.COM' })
      .expect(409);
    expect(res.body).toEqual({
      success: false,
      message: 'Email is already registered',
      errors: [],
    });
    expect(await User.countDocuments()).toBe(1);
  });

  it('rejects an attempt to self-assign the admin role', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ ...validRegistration, role: 'admin' })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(await User.countDocuments()).toBe(0);
  });

  it('validates input and reports every invalid field', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short' })
      .expect(400);
    const fields = (res.body.errors as { field: string }[]).map((error) => error.field).sort();
    expect(fields).toEqual(['email', 'name', 'password']);
  });

  it('rejects passwords longer than bcrypt’s 72-byte limit', async () => {
    await api()
      .post('/api/auth/register')
      .send({ ...validRegistration, password: 'a'.repeat(73) })
      .expect(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await api()
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(res.body.message).toBe('Malformed JSON body');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with valid credentials and sets the auth cookie', async () => {
    const user = await createUser({ email: 'login@example.com' });
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'LOGIN@example.com', password: DEFAULT_PASSWORD })
      .expect(200);

    expect(res.body.data.user).toMatchObject({
      id: user.id,
      email: 'login@example.com',
      role: 'user',
    });
    expect(res.body.data.user.password).toBeUndefined();
    expect(cookieHeader(res)).toMatch(/^access_token=.+HttpOnly/i);

    // The issued cookie authenticates subsequent requests.
    const me = await api()
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(res).split(';')[0]!)
      .expect(200);
    expect(me.body.data.user.id).toBe(user.id);
  });

  it('returns the same generic 401 for a wrong password and an unknown email', async () => {
    await createUser({ email: 'victim@example.com' });

    const wrongPassword = await api()
      .post('/api/auth/login')
      .send({ email: 'victim@example.com', password: 'wrong-password' })
      .expect(401);
    const unknownEmail = await api()
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);

    expect(wrongPassword.body).toEqual({
      success: false,
      message: 'Invalid email or password',
      errors: [],
    });
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(cookieHeader(wrongPassword)).toBe('');
  });

  it('rejects NoSQL operator injection in credentials', async () => {
    await createUser({ email: 'victim@example.com' });
    await api()
      .post('/api/auth/login')
      .send({ email: { $ne: null }, password: { $ne: null } })
      .expect(400);
  });

  it('rate limits repeated credential attempts', async () => {
    const limitedApp = createApp({ rateLimit: { windowMs: 60_000, max: 2 } });
    const attempt = () =>
      request(limitedApp).post('/api/auth/login').send({ email: 'a@example.com', password: 'x' });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
  });
});

describe('JWT verification (GET /api/auth/me)', () => {
  const sign = (payload: object, options: jwt.SignOptions = {}, secret = env.jwt.secret) =>
    jwt.sign(payload, secret, {
      algorithm: 'HS256',
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
      expiresIn: '1h',
      ...options,
    });

  it('returns the current profile without the password', async () => {
    const user = await createUser({ name: 'Current' });
    const res = await api().get('/api/auth/me').set('Cookie', user.cookie).expect(200);
    expect(res.body.data.user).toMatchObject({ id: user.id, name: 'Current', role: 'user' });
    expect(res.body.data.user).not.toHaveProperty('password');
  });

  it('accepts the token as a Bearer header for non-browser clients', async () => {
    const user = await createUser();
    const token = user.cookie.split('=')[1]!;
    await api().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('rejects a request without a token', async () => {
    const res = await api().get('/api/auth/me').expect(401);
    expect(res.body.message).toBe('Authentication required');
  });

  it('rejects an expired token', async () => {
    const user = await createUser();
    const expired = sign({ userId: user.id, role: 'user' }, { expiresIn: -10 });
    const res = await api().get('/api/auth/me').set('Cookie', authCookie(expired)).expect(401);
    expect(res.body.message).toBe('Token has expired');
  });

  it('rejects a token signed with a different secret (forged admin role)', async () => {
    const user = await createUser();
    const forged = sign(
      { userId: user.id, role: 'admin' },
      {},
      'attacker-controlled-secret-attacker-controlled',
    );
    const res = await api().get('/api/users').set('Cookie', authCookie(forged)).expect(401);
    expect(res.body.message).toBe('Invalid token');
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const user = await createUser();
    const unsigned = jwt.sign({ userId: user.id, role: 'admin' }, '', {
      algorithm: 'none',
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });
    await api().get('/api/auth/me').set('Cookie', authCookie(unsigned)).expect(401);
  });

  it('rejects a token with the wrong audience or a malformed payload', async () => {
    const user = await createUser();
    const wrongAudience = sign({ userId: user.id, role: 'user' }, { audience: 'other-app' });
    const badPayload = sign({ userId: 'not-an-id', role: 'superuser' });
    await api().get('/api/auth/me').set('Cookie', authCookie(wrongAudience)).expect(401);
    await api().get('/api/auth/me').set('Cookie', authCookie(badPayload)).expect(401);
    await api().get('/api/auth/me').set('Cookie', authCookie('garbage.token.value')).expect(401);
  });

  it('rejects a valid token whose account was deleted', async () => {
    const user = await createUser();
    await User.deleteOne({ _id: user.id });
    const res = await api().get('/api/auth/me').set('Cookie', user.cookie).expect(401);
    expect(res.body.message).toBe('Account no longer exists');
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the auth cookie', async () => {
    const res = await api().post('/api/auth/logout').expect(200);
    expect(cookieHeader(res)).toMatch(/^access_token=;.*Expires=Thu, 01 Jan 1970/);
  });
});

describe('security middleware', () => {
  it('sets security headers and restricts CORS to the configured origin', async () => {
    const allowed = await api().get('/api/unknown').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['x-powered-by']).toBeUndefined();
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await api().get('/api/unknown').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps 4xx status for malformed requests instead of reporting a 500', async () => {
    const user = await createUser();
    const badEncoding = await api().get('/api/notes/%E0%A4%A').set('Cookie', user.cookie);
    expect(badEncoding.status).toBe(400);
    expect(badEncoding.body).toEqual({ success: false, message: 'Bad request', errors: [] });

    const badCharset = await api()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json; charset=x-unknown')
      .send('{}');
    expect(badCharset.status).toBe(415);

    const tooLarge = await api()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(200_000) }));
    expect(tooLarge.status).toBe(413);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await api().get('/api/unknown').expect(404);
    expect(res.body).toEqual({
      success: false,
      message: 'Route GET /api/unknown not found',
      errors: [],
    });
  });
});
