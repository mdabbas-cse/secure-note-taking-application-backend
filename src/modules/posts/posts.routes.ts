import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import * as postsController from './posts.controller.js';
import { createPostSchema, listPostsQuerySchema, userIdParamsSchema } from './posts.schemas.js';

/** Posts are public to every authenticated user (unlike private notes). */
export function createPostsRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.post('/', validated({ body: createPostSchema }, postsController.create));
  router.get('/', validated({ query: listPostsQuerySchema }, postsController.list));
  router.get(
    '/user/:userId',
    validated(
      { params: userIdParamsSchema, query: listPostsQuerySchema },
      postsController.listByUser,
    ),
  );

  return router;
}
