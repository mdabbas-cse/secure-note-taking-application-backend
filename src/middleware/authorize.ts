import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../models/User.model.js';
import { ApiError } from '../utils/ApiError.js';

/** Allows the request only if the authenticated role is in `roles`. Must run after `authenticate`. */
export function authorize(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw ApiError.unauthorized();
    if (!roles.includes(req.auth.role)) throw ApiError.forbidden();
    next();
  };
}
