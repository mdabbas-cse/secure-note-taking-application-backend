import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { CSRF_HEADER, csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createApiRouter, type ApiRouterOptions } from './routes/index.js';

export function createApp(options: Partial<ApiRouterOptions> = {}): Express {
  const app = express();

  // Behind Vercel's proxy req.ip must come from X-Forwarded-For (one trusted hop),
  // otherwise every client shares the proxy's IP in the rate limiter.
  app.set('trust proxy', env.trustProxy > 0 ? env.trustProxy : false);

  // Security headers (CSP, HSTS, noSniff, frameguard, hides X-Powered-By, ...).
  app.use(helmet());
  // Exact frontend origin(s) only — never a wildcard, because credentials
  // (the auth cookie) are allowed.
  app.use(
    cors({
      origin: [...env.corsOrigins],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
      maxAge: 600,
    }),
  );
  // JSON only, bounded size: forms cannot post here without a CORS preflight.
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(csrfProtection(env.corsOrigins));

  app.get('/', (_req, res) => {
    res.json({ success: true, message: 'Secure Notes API', data: { health: '/api/health' } });
  });
  app.use('/api', createApiRouter({ rateLimit: options.rateLimit ?? env.authRateLimit }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Vercel entry point. Vercel's Express preset detects this file (src/app.ts,
 * imports `express`) and serves the default export as a single Fluid-compute
 * function. No app.listen() here: the local server lives in src/server.ts.
 * The database connection is opened lazily (and cached) by ensureDatabase.
 */
const app = createApp();
export default app;
