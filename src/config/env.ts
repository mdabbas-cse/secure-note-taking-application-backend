import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from './ConfigError.js';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const commaList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Normalises "https://app.example.com/" to the bare origin "https://app.example.com". */
function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

const LOCAL_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const isLocalOrigin = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGODB_URI: z
      .string({ error: 'MONGODB_URI is required' })
      .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),
    JWT_SECRET: z
      .string({ error: 'JWT_SECRET is required' })
      .min(32, 'JWT_SECRET must be at least 32 characters')
      // The value shipped in .env.example is public: anyone could forge tokens with it.
      .refine((value) => !value.startsWith('replace-with'), 'JWT_SECRET is still the placeholder'),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smhd]$/, 'JWT_EXPIRES_IN must look like 15m, 1h or 7d')
      .default('1h'),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    /** Exact browser origin(s) of the frontend, comma separated. Required in production. */
    FRONTEND_URL: z.string().optional(),
    COOKIE_SECURE: booleanString.optional(),
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).optional(),
    /** Number of reverse proxies in front of the app (Vercel: 1). */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).optional(),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    MONGO_AUTO_INDEX: booleanString.optional(),
    MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    /** Set automatically by Vercel at build and run time. */
    VERCEL: z.string().optional(),
  })
  .superRefine((raw, ctx) => {
    const isProduction = raw.NODE_ENV === 'production';
    const origins = raw.FRONTEND_URL ? commaList(raw.FRONTEND_URL) : [];

    if (isProduction && origins.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['FRONTEND_URL'],
        message: 'FRONTEND_URL is required in production (the exact frontend origin)',
      });
    }
    for (const value of origins) {
      const origin = toOrigin(value);
      if (!origin || value.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['FRONTEND_URL'],
          message: 'FRONTEND_URL must list exact http(s) origins (wildcards are not allowed)',
        });
      } else if (isProduction && (!origin.startsWith('https://') || isLocalOrigin(origin))) {
        ctx.addIssue({
          code: 'custom',
          path: ['FRONTEND_URL'],
          message: 'FRONTEND_URL must use https and must not be localhost in production',
        });
      }
    }

    const secure = raw.COOKIE_SECURE ?? isProduction;
    const sameSite = raw.COOKIE_SAME_SITE ?? (isProduction ? 'none' : 'strict');
    if (sameSite === 'none' && !secure) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SAME_SITE'],
        message: 'COOKIE_SAME_SITE=none requires secure cookies (browsers reject it otherwise)',
      });
    }
  });

export type SameSite = 'strict' | 'lax' | 'none';

/**
 * Parses and validates configuration. Throws (instead of process.exit) so that
 * the failure is reported correctly both by the local server and inside a
 * serverless function. Messages name the variable, never its value.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'env',
        message: issue.message,
      })),
    );
  }

  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';
  const configuredOrigins = raw.FRONTEND_URL
    ? commaList(raw.FRONTEND_URL).map((value) => toOrigin(value)!)
    : [];
  const cookieSecure = raw.COOKIE_SECURE ?? isProduction;
  const cookieSameSite: SameSite = raw.COOKIE_SAME_SITE ?? (isProduction ? 'none' : 'strict');

  return {
    nodeEnv: raw.NODE_ENV,
    isProduction,
    isTest: raw.NODE_ENV === 'test',
    isVercel: Boolean(raw.VERCEL),
    port: raw.PORT,
    mongoUri: raw.MONGODB_URI,
    jwt: {
      secret: raw.JWT_SECRET,
      expiresIn: raw.JWT_EXPIRES_IN as `${number}${'s' | 'm' | 'h' | 'd'}`,
      issuer: 'secure-notes-api',
      audience: 'secure-notes-client',
    },
    bcryptSaltRounds: raw.BCRYPT_SALT_ROUNDS,
    // Production: exactly the configured origins. Development/test: configured
    // origins plus the local Vite dev server (localhost is never allowed in production).
    corsOrigins: isProduction
      ? configuredOrigins
      : [...new Set([...configuredOrigins, ...LOCAL_DEV_ORIGINS])],
    cookie: {
      secure: cookieSecure,
      sameSite: cookieSameSite,
      // CHIPS: a cross-site (SameSite=None) cookie keyed to the frontend's site.
      // Browsers that block third-party cookies still accept partitioned ones.
      partitioned: cookieSameSite === 'none' && cookieSecure,
    },
    // Vercel terminates TLS in front of the function and sets X-Forwarded-For.
    // Trusting exactly one hop makes req.ip the real client IP (rate limiting).
    trustProxy: raw.TRUST_PROXY ?? (raw.VERCEL ? 1 : 0),
    authRateLimit: {
      windowMs: raw.AUTH_RATE_LIMIT_WINDOW_MS,
      max: raw.AUTH_RATE_LIMIT_MAX,
    },
    // Building indexes on boot is convenient in dev but blocks/locks in production;
    // there indexes are built explicitly with `npm run db:indexes -- --apply`.
    mongoAutoIndex: raw.MONGO_AUTO_INDEX ?? !isProduction,
    mongoMaxPoolSize: raw.MONGO_MAX_POOL_SIZE,
  } as const;
}

export type Env = ReturnType<typeof loadEnv>;

export const env: Env = loadEnv();
