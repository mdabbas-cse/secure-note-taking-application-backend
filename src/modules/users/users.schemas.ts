import { z } from 'zod';
import { ROLES } from '../../models/User.model.js';
import { paginationQuerySchema } from '../../utils/pagination.js';
import {
  emailSchema,
  interestsSchema,
  nameSchema,
  passwordSchema,
} from '../../utils/validators.js';

export const createUserSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(ROLES).default('user'),
  interests: interestsSchema.default([]),
});

export const updateUserSchema = z
  .strictObject({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    password: passwordSchema.optional(),
    role: z.enum(ROLES).optional(),
    interests: interestsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

// createdAt -> ordered by the built-in _id index; email -> ordered by email_1.
export const listUsersQuerySchema = paginationQuerySchema(['createdAt', 'email'], {
  sortBy: 'createdAt',
  sortOrder: 'desc',
});

const interestFilterSchema = z
  .string()
  .max(1_100)
  .transform((csv) =>
    csv
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  )
  .pipe(z.array(z.string().max(50)).max(20))
  .transform((values) => (values.length > 0 ? [...new Set(values)] : undefined));

// Groups are produced by $group, so no index can order them; sorting happens on
// the (small) grouped result.
export const interestGroupsQuerySchema = paginationQuerySchema(['interest', 'userCount'], {
  sortBy: 'interest',
  sortOrder: 'asc',
}).extend({
  /** Optional comma-separated filter, e.g. ?interests=chess,reading (uses interests_1). */
  interests: interestFilterSchema.optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type InterestGroupsQuery = z.infer<typeof interestGroupsQuerySchema>;
