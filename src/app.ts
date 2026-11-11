import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ConfigError } from './config/ConfigError.js';

/**
 * Vercel entry point. Vercel's Express preset selects this file (src/app.ts,
 * imports `express`) and serves its default export as one Fluid-compute
 * function. The local server (src/server.ts) uses createApp() directly.
 *
 * The real application is loaded with a guarded dynamic import. Configuration
 * is validated when that module loads; if it is invalid, every request gets a
 * JSON 500 naming the bad variables (never their values) instead of the
 * function crashing with Vercel's opaque FUNCTION_INVOCATION_FAILED page.
 */
export function createMisconfiguredApp(error: ConfigError): Express {
  const fallback = express();
  fallback.disable('x-powered-by');
  fallback.use((_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.status(500).json({
      success: false,
      message: 'Server misconfigured: invalid environment variables. See the deployment logs.',
      errors: error.issues,
    });
  });
  return fallback;
}

export async function loadApp(): Promise<Express> {
  try {
    const { createApp } = await import('./createApp.js');
    return createApp();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    return createMisconfiguredApp(error);
  }
}

// Started once per function instance. No top-level await: the entry must stay
// loadable by CommonJS-style loaders (require() cannot load modules using it).
const ready = loadApp();
// Unexpected load failures are reported per request (below), not as an unhandled rejection.
ready.catch(() => undefined);

const app = express();
app.disable('x-powered-by');
app.use((req: Request, res: Response, next: NextFunction) => {
  ready.then((inner) => inner(req, res, next), next);
});

export default app;
