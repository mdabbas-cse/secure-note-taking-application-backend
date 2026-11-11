import type { ValidatedHandler } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/response.js';
import type { idParamsSchema } from '../../utils/validators.js';
import type {
  createUserSchema,
  interestGroupsQuerySchema,
  listUsersQuerySchema,
  updateUserSchema,
} from './users.schemas.js';
import * as usersService from './users.service.js';

type IdParams = { params: typeof idParamsSchema };

export const create: ValidatedHandler<{ body: typeof createUserSchema }> = async (
  { body },
  _req,
  res,
) => {
  const user = await usersService.createUser(body);
  sendSuccess(res, { statusCode: 201, message: 'User created successfully', data: user });
};

export const list: ValidatedHandler<{ query: typeof listUsersQuerySchema }> = async (
  { query },
  _req,
  res,
) => {
  const { users, pagination } = await usersService.listUsers(query);
  sendSuccess(res, { message: 'Users retrieved successfully', data: users, pagination });
};

export const get: ValidatedHandler<IdParams> = async ({ params }, _req, res) => {
  const user = await usersService.getUser(params.id);
  sendSuccess(res, { message: 'User retrieved successfully', data: user });
};

export const update: ValidatedHandler<IdParams & { body: typeof updateUserSchema }> = async (
  { params, body },
  _req,
  res,
) => {
  const user = await usersService.updateUser(params.id, body);
  sendSuccess(res, { message: 'User updated successfully', data: user });
};

export const remove: ValidatedHandler<IdParams> = async ({ params }, _req, res) => {
  await usersService.deleteUser(params.id);
  sendSuccess(res, { message: 'User deleted successfully' });
};

export const groupByInterests: ValidatedHandler<{
  query: typeof interestGroupsQuerySchema;
}> = async ({ query }, _req, res) => {
  const { groups, pagination } = await usersService.groupUsersByInterests(query);
  sendSuccess(res, { message: 'Users grouped by interests', data: groups, pagination });
};
