import { requireAuth } from '../../middleware/authenticate.js';
import type { ValidatedHandler } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/response.js';
import type {
  createPostSchema,
  listPostsQuerySchema,
  userIdParamsSchema,
} from './posts.schemas.js';
import * as postsService from './posts.service.js';

export const create: ValidatedHandler<{ body: typeof createPostSchema }> = async (
  { body },
  req,
  res,
) => {
  const post = await postsService.createPost(requireAuth(req), body);
  sendSuccess(res, { statusCode: 201, message: 'Post created successfully', data: post });
};

export const list: ValidatedHandler<{ query: typeof listPostsQuerySchema }> = async (
  { query },
  _req,
  res,
) => {
  const { posts, pagination } = await postsService.listPosts(query);
  sendSuccess(res, { message: 'Posts retrieved successfully', data: posts, pagination });
};

export const listByUser: ValidatedHandler<{
  params: typeof userIdParamsSchema;
  query: typeof listPostsQuerySchema;
}> = async ({ params, query }, _req, res) => {
  const { posts, pagination } = await postsService.listUserPosts(params.userId, query);
  sendSuccess(res, { message: 'User posts retrieved successfully', data: posts, pagination });
};
