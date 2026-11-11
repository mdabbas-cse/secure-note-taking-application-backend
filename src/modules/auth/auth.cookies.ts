import type { CookieOptions } from 'express';
import type { Env } from '../../config/env.js';

/**
 * Auth cookie attributes.
 *
 *  - httpOnly: JavaScript (and therefore XSS) cannot read the token.
 *  - secure: HTTPS only (always on in production).
 *  - sameSite: `strict` locally (Vite proxy => same origin). `none` in production,
 *    because <app>.vercel.app and <api>.vercel.app are different *sites*
 *    (vercel.app is on the Public Suffix List) and a Strict/Lax cookie would never
 *    be sent. CSRF is then handled by middleware/csrf.ts.
 *  - partitioned (CHIPS): with SameSite=None the cookie is "third-party" from the
 *    browser's view. Partitioned cookies are keyed to the frontend's site and are
 *    still accepted where third-party cookies are blocked.
 *  - path /api: never sent to anything but the API.
 */
export function authCookieOptions(config: Env['cookie']): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    partitioned: config.partitioned,
    path: '/api',
  };
}
