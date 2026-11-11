import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { AUTH_COOKIE_NAME } from './authenticate.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Header the frontend sends on every request. A cross-site page cannot add it without a CORS preflight. */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'XMLHttpRequest';

/**
 * CSRF defence for cookie authentication. In production the cookie is
 * SameSite=None (the frontend and API live on different sites), so the browser
 * would attach it to cross-site requests. Two independent checks on every
 * state-changing request:
 *
 * 1. Origin allow-list: if the browser sent an Origin header, it must be one of
 *    the configured frontend origins (OWASP "verify origin with standard headers").
 * 2. Custom header: a request that carries the auth cookie must also carry
 *    `X-Requested-With: XMLHttpRequest`. Forms cannot set headers, and a
 *    cross-origin fetch() with a custom header triggers a preflight that CORS
 *    rejects for unknown origins (OWASP "custom request headers").
 *
 * Requests without the cookie (Bearer-token API clients, login, register) are
 * not CSRF-able through the cookie, so only check 1 applies to them.
 */
export function csrfProtection(allowedOrigins: readonly string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin');
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      throw ApiError.forbidden('Cross-site request blocked: origin not allowed');
    }

    const cookies = req.cookies as Record<string, unknown> | undefined;
    const usesCookieAuth = typeof cookies?.[AUTH_COOKIE_NAME] === 'string';
    if (usesCookieAuth && req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      throw ApiError.forbidden(`Missing ${CSRF_HEADER} header`);
    }

    next();
  };
}
