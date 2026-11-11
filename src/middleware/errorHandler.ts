import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ApiError, type ErrorDetail } from '../utils/ApiError.js';
import { logError } from '../utils/logger.js';

/** Errors from body-parser, the router (bad URI encoding) and other http-errors producers. */
interface HttpLikeError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
  expose?: boolean;
}

const GENERIC_CLIENT_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  413: 'Request body too large',
  415: 'Unsupported content type or encoding',
};

interface MongoDuplicateKeyError extends Error {
  code: number;
  keyPattern?: Record<string, unknown>;
}

function isDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
  return error instanceof Error && (error as Partial<MongoDuplicateKeyError>).code === 11000;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (isDuplicateKeyError(error)) {
    const field = Object.keys(error.keyPattern ?? {})[0];
    return field === 'email'
      ? ApiError.conflict('Email is already registered')
      : ApiError.conflict('Duplicate value');
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const errors: ErrorDetail[] = Object.values(error.errors).map((issue) => ({
      field: issue.path,
      message: issue.message,
    }));
    return ApiError.badRequest('Validation failed', errors);
  }

  if (error instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for ${error.path}`);
  }

  const httpError = error as HttpLikeError;
  if (httpError.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON body');

  // Client errors raised by Express internals (malformed %-encoding, unsupported
  // charset/encoding, oversized body, ...) keep their 4xx status instead of
  // being reported as a 500. The message stays generic.
  const status = httpError.status ?? httpError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new ApiError(status, GENERIC_CLIENT_MESSAGES[status] ?? 'Bad request');
  }

  return new ApiError(500, 'Internal server error');
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route ${req.method} ${req.path} not found`));
}

// Express recognises error middleware by its 4-argument signature.
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiError = toApiError(error);

  if (apiError.statusCode >= 500 && !(error instanceof ApiError)) {
    // Log the real error server-side (credentials redacted); never leak internals to the client.
    logError('Unhandled error', error);
  }

  res.status(apiError.statusCode).json({
    success: false,
    message: apiError.message,
    errors: apiError.errors,
  });
}
