import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { objectIdSchema } from '../../utils/validators.js';

const titleSchema = z.string().trim().min(1).max(200);
const contentSchema = z.string().max(20_000);

export const createNoteSchema = z.strictObject({
  title: titleSchema,
  content: contentSchema.default(''),
});

// strictObject: `user` (ownership) can never be reassigned through the API.
export const updateNoteSchema = z
  .strictObject({
    title: titleSchema.optional(),
    content: contentSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

// Only `createdAt` is sortable: it is the one sort the { user: 1, createdAt: -1 }
// index (or the _id index for unscoped admin listings) can serve without an in-memory SORT.
export const listNotesQuerySchema = paginationQuerySchema(['createdAt'], {
  sortBy: 'createdAt',
  sortOrder: 'desc',
}).extend({
  /** Admin-only filter; non-admins may only pass their own id. */
  userId: objectIdSchema.optional(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
