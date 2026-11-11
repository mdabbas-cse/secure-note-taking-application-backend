import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { connectDatabase, DatabaseUnavailableError } from '../config/database.js';
import { env } from '../config/env.js';
import { logError } from '../utils/logger.js';

type DatabaseStatus = 'connected' | 'unreachable' | 'indexes_missing';

/**
 * GET /api/health — liveness + database readiness for deployment checks.
 * Opens (or reuses) the cached connection and pings MongoDB. Reports only a
 * status keyword: no hostnames, URIs or error details reach the client.
 */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  let database: DatabaseStatus = 'connected';
  try {
    await connectDatabase();
    await mongoose.connection.db!.command({ ping: 1 });
  } catch (error) {
    database = error instanceof DatabaseUnavailableError ? error.reason : 'unreachable';
    logError('Health check failed', error);
  }

  const healthy = database === 'connected';
  res.set('Cache-Control', 'no-store');
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? 'Service healthy' : 'Service unavailable',
    data: {
      status: healthy ? 'ok' : 'degraded',
      database,
      environment: env.nodeEnv,
      timestamp: new Date().toISOString(),
    },
    ...(!healthy && { errors: [] }),
  });
}
