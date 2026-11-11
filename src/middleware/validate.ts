import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z, ZodType } from 'zod';
import { ApiError, type ErrorDetail } from '../utils/ApiError.js';

export interface RequestSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

type Output<S extends RequestSchemas, K extends keyof RequestSchemas> = S[K] extends ZodType
  ? z.output<S[K]>
  : undefined;

/** Parsed, coerced and normalised request input, typed from the Zod schemas. */
export interface ValidatedInput<S extends RequestSchemas> {
  params: Output<S, 'params'>;
  query: Output<S, 'query'>;
  body: Output<S, 'body'>;
}

export type ValidatedHandler<S extends RequestSchemas> = (
  input: ValidatedInput<S>,
  req: Request,
  res: Response,
) => Promise<void> | void;

const LOCATIONS = ['params', 'query', 'body'] as const;

/** Parses every configured location and reports all issues at once (400). */
export function parseRequest<S extends RequestSchemas>(
  req: Request,
  schemas: S,
): ValidatedInput<S> {
  const errors: ErrorDetail[] = [];
  const input: Record<string, unknown> = {};

  for (const location of LOCATIONS) {
    const schema = schemas[location];
    if (!schema) continue;

    const result = schema.safeParse(req[location] ?? {});
    if (result.success) {
      input[location] = result.data;
      continue;
    }
    for (const issue of result.error.issues) {
      errors.push({
        location,
        field: issue.path.length > 0 ? issue.path.join('.') : undefined,
        message: issue.message,
      });
    }
  }

  if (errors.length > 0) throw ApiError.badRequest('Validation failed', errors);
  return input as unknown as ValidatedInput<S>;
}

/**
 * Validation middleware bound to its handler: the handler only ever receives
 * validated input (unknown keys stripped, or rejected for strict schemas) and the
 * types are inferred from the schemas, so no casts are needed in controllers.
 * Express 5 forwards rejected promises to the error handler, so no asyncHandler.
 */
export function validated<S extends RequestSchemas>(
  schemas: S,
  handler: ValidatedHandler<S>,
): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    const input = parseRequest(req, schemas);
    await handler(input, req, res);
  };
}
