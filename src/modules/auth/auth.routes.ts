import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import * as authController from './auth.controller.js';
import { loginSchema, registerSchema } from './auth.schemas.js';

export interface AuthRouterOptions {
  rateLimit: { windowMs: number; max: number };
}

export function createAuthRouter({ rateLimit: limits }: AuthRouterOptions): Router {
  const router = Router();

  // Brute-force / credential-stuffing protection for the credential endpoints.
  const credentialLimiter = rateLimit({
    windowMs: limits.windowMs,
    limit: limits.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new ApiError(429, 'Too many authentication attempts, please try again later'));
    },
  });

  router.post(
    '/register',
    credentialLimiter,
    validated({ body: registerSchema }, authController.register),
  );
  router.post('/login', credentialLimiter, validated({ body: loginSchema }, authController.login));
  router.post('/logout', authController.logout);
  router.get('/me', authenticate, authController.me);

  return router;
}
