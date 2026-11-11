import type { Response } from 'express';
import type { PaginationMeta } from './pagination.js';

interface SuccessOptions<T> {
  statusCode?: number;
  message: string;
  data?: T;
  pagination?: PaginationMeta;
}

export function sendSuccess<T>(
  res: Response,
  { statusCode = 200, message, data, pagination }: SuccessOptions<T>,
): void {
  res.status(statusCode).json({
    success: true,
    message,
    ...(data !== undefined && { data }),
    ...(pagination && { pagination }),
  });
}
