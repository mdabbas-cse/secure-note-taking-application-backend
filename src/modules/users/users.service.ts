import type { Types } from 'mongoose';
import { Note } from '../../models/Note.model.js';
import { Post } from '../../models/Post.model.js';
import { User } from '../../models/User.model.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  buildPaginationMeta,
  unwrapFacet,
  type FacetResult,
  type PaginationMeta,
} from '../../utils/pagination.js';
import { toUserDTO, type UserDTO } from './user.dto.js';
import type {
  CreateUserInput,
  InterestGroupsQuery,
  ListUsersQuery,
  UpdateUserInput,
} from './users.schemas.js';
import {
  buildInterestGroupsPipeline,
  buildUserListQuery,
  type InterestGroup,
} from './users.queries.js';

const USER_NOT_FOUND = 'User not found';

export async function createUser(input: CreateUserInput): Promise<UserDTO> {
  // Duplicate email -> E11000 from email_1 -> 409 (errorHandler).
  const user = await User.create(input);
  return toUserDTO(user);
}

export async function listUsers(
  query: ListUsersQuery,
): Promise<{ users: UserDTO[]; pagination: PaginationMeta }> {
  const [users, totalRecords] = await Promise.all([
    buildUserListQuery(query),
    User.estimatedDocumentCount(),
  ]);
  return { users: users.map(toUserDTO), pagination: buildPaginationMeta(query, totalRecords) };
}

export async function getUser(id: Types.ObjectId): Promise<UserDTO> {
  const user = await User.findById(id).lean();
  if (!user) throw ApiError.notFound(USER_NOT_FOUND);
  return toUserDTO(user);
}

/**
 * Guards against locking everyone out: an admin may only be demoted or deleted
 * while at least one OTHER admin exists. This covers an admin removing their own
 * (last) admin account. Runs only on those rare write paths.
 */
async function assertAnotherAdminExists(excludedAdminId: Types.ObjectId): Promise<void> {
  const otherAdmin = await User.exists({ role: 'admin', _id: { $ne: excludedAdminId } });
  if (!otherAdmin) throw ApiError.conflict('Cannot remove the last admin account');
}

export async function updateUser(id: Types.ObjectId, input: UpdateUserInput): Promise<UserDTO> {
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound(USER_NOT_FOUND);

  if (user.role === 'admin' && input.role === 'user') {
    await assertAnotherAdminExists(user._id);
  }

  // Loading + save() (instead of findOneAndUpdate) runs schema validators and
  // the pre('save') hook, so a new password is always bcrypt-hashed.
  user.set(input);
  await user.save();
  return toUserDTO(user);
}

export async function deleteUser(id: Types.ObjectId): Promise<void> {
  const user = await User.findById(id).select({ role: 1 }).lean();
  if (!user) throw ApiError.notFound(USER_NOT_FOUND);

  if (user.role === 'admin') await assertAnotherAdminExists(user._id);

  await User.deleteOne({ _id: id });
  // Cascade: private notes and posts must not outlive their owner.
  // Both deleteMany calls use the { user: 1, createdAt: -1 } index prefix.
  await Promise.all([Note.deleteMany({ user: id }), Post.deleteMany({ user: id })]);
}

/** Exactly ONE database operation: a single User.aggregate() call. */
export async function groupUsersByInterests(
  query: InterestGroupsQuery,
): Promise<{ groups: InterestGroup[]; pagination: PaginationMeta }> {
  const result = await User.aggregate<FacetResult<InterestGroup>>(
    buildInterestGroupsPipeline(query),
  ).option({ allowDiskUse: true });
  const { data, totalRecords } = unwrapFacet(result);
  return { groups: data, pagination: buildPaginationMeta(query, totalRecords) };
}
