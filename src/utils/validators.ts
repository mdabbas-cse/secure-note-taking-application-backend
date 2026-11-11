import { Types } from 'mongoose';
import { z } from 'zod';

/** Strict 24-hex ObjectId (mongoose.isValidObjectId also accepts any 12-char string). */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid ObjectId')
  .transform((value) => new Types.ObjectId(value));

export const idParamsSchema = z.object({ id: objectIdSchema });

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

// bcrypt silently ignores bytes beyond 72, so longer passwords are rejected.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes');

export const nameSchema = z.string().trim().min(1).max(100);

const interestSchema = z.string().trim().toLowerCase().min(1).max(50);

/** Normalised (trimmed, lowercase) and de-duplicated so grouping is consistent. */
export const interestsSchema = z
  .array(interestSchema)
  .max(20)
  .transform((values) => [...new Set(values)]);
