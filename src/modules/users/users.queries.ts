import type { PipelineStage } from 'mongoose';
import { User } from '../../models/User.model.js';
import {
  getSkip,
  paginationFacet,
  sortDirection,
  type PaginationParams,
} from '../../utils/pagination.js';

/**
 * Query/pipeline builders shared by the service and the explain() tests/scripts.
 */

/**
 * GET /api/users
 *  - sortBy=createdAt -> { _id } on the built-in _id index. ObjectIds embed their
 *    creation time, so this is creation order without a { createdAt: -1 } index.
 *  - sortBy=email     -> walks the unique email_1 index.
 * `password` is excluded by `select: false` on the schema.
 */
export function buildUserListQuery(params: PaginationParams<'createdAt' | 'email'>) {
  const direction = sortDirection(params.sortOrder);
  const sort: Record<string, 1 | -1> =
    params.sortBy === 'email' ? { email: direction } : { _id: direction };
  return User.find({}).sort(sort).skip(getSkip(params)).limit(params.limit).lean();
}

export interface InterestGroupsParams extends PaginationParams<'interest' | 'userCount'> {
  interests?: string[] | undefined;
}

export interface InterestGroup {
  interest: string;
  userCount: number;
  users: { id: string; name: string; email: string }[];
}

/**
 * GET /api/users/aggregation/interests — executed with exactly ONE User.aggregate().
 *
 *  1. $match (only with ?interests=)  -> IXSCAN on the multikey interests_1 index,
 *                                        so only users having a requested interest are read.
 *  2. $project name/email/interests   -> narrow documents early; the password hash never
 *                                        enters the pipeline.
 *  3. $unwind interests               -> one document per (user, interest).
 *  4. $match again (only with filter) -> drop the user's *other* interests after unwind.
 *  5. $group by interest              -> $addToSet so a user appears once per interest even
 *                                        if legacy data contains duplicates.
 *  6. $set userCount, $sort           -> deterministic order (tie-break on interest).
 *  7. $facet                          -> total group count + one page of groups in the
 *                                        same round trip; members sorted by name.
 *
 * Without a filter every user must be read by definition, so the planner uses a
 * COLLSCAN; an index cannot speed up $unwind/$group over the whole collection.
 */
export function buildInterestGroupsPipeline(params: InterestGroupsParams): PipelineStage[] {
  const direction = sortDirection(params.sortOrder);
  const filter = params.interests?.length ? { interests: { $in: params.interests } } : undefined;
  const sort: Record<string, 1 | -1> =
    params.sortBy === 'userCount' ? { userCount: direction, _id: 1 } : { _id: direction };

  return [
    ...(filter ? [{ $match: filter }] : []),
    { $project: { _id: 1, name: 1, email: 1, interests: 1 } },
    { $unwind: '$interests' },
    ...(filter ? [{ $match: filter }] : []),
    {
      $group: {
        _id: '$interests',
        users: { $addToSet: { id: '$_id', name: '$name', email: '$email' } },
      },
    },
    { $set: { userCount: { $size: '$users' } } },
    { $sort: sort },
    paginationFacet(params, [
      {
        $project: {
          _id: 0,
          interest: '$_id',
          userCount: '$userCount',
          users: { $sortArray: { input: '$users', sortBy: { name: 1, email: 1 } } },
        },
      },
    ]),
  ];
}
