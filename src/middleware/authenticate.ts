import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/User.model.js';
import { ApiError } from '../utils/ApiError.js';
import { TokenExpiredError, verifyAccessToken, type AccessTokenPayload } from '../utils/jwt.js';

export const AUTH_COOKIE_NAME = 'access_token';

export type AuthContext = AccessTokenPayload;

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate` from a verified JWT. Never derived from body/query. */
    auth?: AuthContext;
  }
}

function extractToken(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const cookieToken = cookies?.[AUTH_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) return cookieToken;

  // Non-browser clients may send the same token as a Bearer header.
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token.length > 0) return token;
  }
  return undefined;
}

/** The per-request account check (exported so its plan is verified by explain tests). */
export function findAccountRole(userId: string) {
  return User.findById(userId).select({ role: 1 }).lean();
}

/**
 * 1. Verifies the JWT (signature, HS256, issuer, audience, expiry, claim shape).
 * 2. Confirms the account still exists AND still has the role the token was issued
 *    for. Without this, a demoted admin's unexpired token would keep admin rights
 *    (and could re-promote itself), and a deleted user could keep writing data.
 *    A role change therefore invalidates existing sessions: the user logs in again.
 *
 * Cost: one point read by _id per authenticated request (EXPRESS_IXSCAN on _id_,
 * projection { role } only — verified in tests/indexes.test.ts).
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized();

  let claims: AccessTokenPayload;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    throw ApiError.unauthorized(
      error instanceof TokenExpiredError ? 'Token has expired' : 'Invalid token',
    );
  }

  const account = await findAccountRole(claims.userId);
  if (!account) throw ApiError.unauthorized('Account no longer exists');
  if (account.role !== claims.role) {
    throw ApiError.unauthorized('Your role has changed, please log in again');
  }

  req.auth = { userId: claims.userId, role: account.role };
  next();
}

/** Returns the authenticated principal or throws 401 (for use in controllers). */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}
