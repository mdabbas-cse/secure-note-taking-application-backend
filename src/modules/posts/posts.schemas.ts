import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { objectIdSchema } from '../../utils/validators.js';

export const createPostSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
});

export const listPostsQuerySchema = paginationQuerySchema(['createdAt'], {
  sortBy: 'createdAt',
  sortOrder: 'desc',
});

export const userIdParamsSchema = z.object({ userId: objectIdSchema });

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;
