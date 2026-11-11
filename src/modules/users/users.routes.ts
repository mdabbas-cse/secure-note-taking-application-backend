import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validated } from '../../middleware/validate.js';
import { idParamsSchema } from '../../utils/validators.js';
import * as usersController from './users.controller.js';
import {
  createUserSchema,
  interestGroupsQuerySchema,
  listUsersQuerySchema,
  updateUserSchema,
} from './users.schemas.js';

/** Every route here is admin-only, enforced once for the whole router. */
export function createUsersRouter(): Router {
  const router = Router();
  router.use(authenticate, authorize('admin'));

  // Registered before '/:id' so "aggregation" is never parsed as an id.
  router.get(
    '/aggregation/interests',
    validated({ query: interestGroupsQuerySchema }, usersController.groupByInterests),
  );

  router.post('/', validated({ body: createUserSchema }, usersController.create));
  router.get('/', validated({ query: listUsersQuerySchema }, usersController.list));
  router.get('/:id', validated({ params: idParamsSchema }, usersController.get));
  router.patch(
    '/:id',
    validated({ params: idParamsSchema, body: updateUserSchema }, usersController.update),
  );
  router.delete('/:id', validated({ params: idParamsSchema }, usersController.remove));

  return router;
}
