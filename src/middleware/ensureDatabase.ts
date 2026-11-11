import type { NextFunction, Request, Response } from 'express';
import { connectDatabase } from '../config/database.js';
import { ApiError } from '../utils/ApiError.js';
import { logError } from '../utils/logger.js';

/**
 * Makes sure the (cached) MongoDB connection is open before any route touches
 * the database. On a warm instance this resolves immediately; on a cold start
 * it opens the connection once. Failures become a generic 503 for the client
 * and a credential-redacted log line for the operator.
 */
export async function ensureDatabase(_req: Request, _res: Response, next: NextFunction) {
  try {
    await connectDatabase();
  } catch (error) {
    logError('Database unavailable', error);
    throw new ApiError(503, 'Service temporarily unavailable, please retry shortly');
  }
  next();
}
