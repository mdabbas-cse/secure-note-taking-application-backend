import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ROLES, type Role } from '../models/User.model.js';

export interface AccessTokenPayload {
  userId: string;
  role: Role;
}

const payloadSchema = z.object({
  userId: z.string().regex(/^[0-9a-f]{24}$/),
  role: z.enum(ROLES),
});

export class TokenExpiredError extends Error {}
export class InvalidTokenError extends Error {}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ userId: payload.userId, role: payload.role }, env.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: env.jwt.expiresIn,
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
  });
}

/**
 * Verifies signature, algorithm (pinned to HS256 to prevent alg confusion),
 * issuer, audience and expiry, then validates the claim shape.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.jwt.secret, {
      algorithms: ['HS256'],
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw new TokenExpiredError('Token has expired');
    throw new InvalidTokenError('Invalid token');
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) throw new InvalidTokenError('Invalid token');
  return parsed.data;
}
