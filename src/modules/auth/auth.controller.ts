import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { AUTH_COOKIE_NAME, requireAuth } from '../../middleware/authenticate.js';
import type { ValidatedHandler } from '../../middleware/validate.js';
import { durationToMs } from '../../utils/duration.js';
import { sendSuccess } from '../../utils/response.js';
import type { loginSchema, registerSchema } from './auth.schemas.js';
import { authCookieOptions } from './auth.cookies.js';
import * as authService from './auth.service.js';

const cookieOptions = authCookieOptions(env.cookie);

function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...cookieOptions,
    maxAge: durationToMs(env.jwt.expiresIn),
  });
}

export const register: ValidatedHandler<{ body: typeof registerSchema }> = async (
  { body },
  _req,
  res,
) => {
  const { user, accessToken } = await authService.register(body);
  setAuthCookie(res, accessToken);
  sendSuccess(res, { statusCode: 201, message: 'Registration successful', data: { user } });
};

export const login: ValidatedHandler<{ body: typeof loginSchema }> = async (
  { body },
  _req,
  res,
) => {
  const { user, accessToken } = await authService.login(body);
  setAuthCookie(res, accessToken);
  sendSuccess(res, { message: 'Login successful', data: { user } });
};

export function logout(_req: Request, res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions);
  sendSuccess(res, { message: 'Logout successful' });
}

export async function me(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const user = await authService.getCurrentUser(userId);
  sendSuccess(res, { message: 'Profile retrieved successfully', data: { user } });
}
