/**
 * Long-running local / self-hosted server (`npm run dev`, `npm start`).
 * Not used on Vercel: Vercel serves the default export of src/app.ts.
 * This file intentionally does not import `express`, so Vercel's entry-point
 * detection never selects it. It uses createApp() directly so that invalid
 * configuration stops the process instead of serving the fallback app.
 */
import { createApp } from './createApp.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logError } from './utils/logger.js';

async function main(): Promise<void> {
  // Fail fast locally: connect (and verify indexes when autoIndex is off) before listening.
  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.info(`API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    console.info(`${signal} received, shutting down`);
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logError('Failed to start server', error);
  process.exit(1);
});
