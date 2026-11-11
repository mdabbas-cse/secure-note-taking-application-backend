import { Router } from 'express';
import { ensureDatabase } from '../middleware/ensureDatabase.js';
import { createAuthRouter, type AuthRouterOptions } from '../modules/auth/auth.routes.js';
import { createNotesRouter } from '../modules/notes/notes.routes.js';
import { createPostsRouter } from '../modules/posts/posts.routes.js';
import { createUsersRouter } from '../modules/users/users.routes.js';
import { healthCheck } from './health.js';

export type ApiRouterOptions = AuthRouterOptions;

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();

  // Health reports database problems itself (503 + status), so it runs first.
  router.get('/health', healthCheck);

  // Every other route needs MongoDB: open/reuse the cached connection once here.
  router.use(ensureDatabase);

  router.use('/auth', createAuthRouter(options));
  router.use('/notes', createNotesRouter());
  router.use('/users', createUsersRouter());
  router.use('/posts', createPostsRouter());
  return router;
}
