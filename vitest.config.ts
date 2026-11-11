import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    // Files share one mongod (each file uses its own database); run serially for
    // deterministic command-monitoring assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: 'test',
      // Real URI is injected by globalSetup; env.ts only needs a non-empty value.
      MONGODB_URI: 'mongodb://placeholder',
      JWT_SECRET: 'test-only-jwt-secret-that-is-at-least-32-characters',
      JWT_EXPIRES_IN: '1h',
      BCRYPT_SALT_ROUNDS: '4',
      AUTH_RATE_LIMIT_MAX: '10000',
      MONGO_AUTO_INDEX: 'true',
      FRONTEND_URL: 'http://localhost:5173',
    },
  },
});
