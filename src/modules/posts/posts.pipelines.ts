import type { PipelineStage, Types } from 'mongoose';
import { User } from '../../models/User.model.js';
import {
  getSkip,
  paginationFacet,
  sortDirection,
  type PaginationParams,
} from '../../utils/pagination.js';

/**
 * Aggregation pipelines for posts. Exported so tests and the explain script run
 * explain('executionStats') on exactly what the API executes.
 */

/**
 * Joins the author from `users` and shapes the output document.
 *
 * - localField/foreignField equality on users._id => served by the built-in
 *   _id index; no extra index is needed for the join.
 * - The $lookup sub-pipeline projects only name/email, so the password hash and
 *   other user fields never enter the pipeline.
 * - Every $project field is an expression (not `1`) so output keys keep this order.
 * - preserveNullAndEmptyArrays keeps page size and totalRecords consistent even
 *   if an author is missing (author: null) instead of silently dropping posts.
 */
export function authorLookupStages(): PipelineStage.FacetPipelineStage[] {
  return [
    {
      $lookup: {
        from: User.collection.collectionName,
        localField: 'user',
        foreignField: '_id',
        pipeline: [{ $project: { _id: 0, id: '$_id', name: '$name', email: '$email' } }],
        as: 'author',
      },
    },
    { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        id: '$_id',
        title: '$title',
        content: '$content',
        createdAt: '$createdAt',
        updatedAt: '$updatedAt',
        author: { $ifNull: ['$author', null] },
      },
    },
  ];
}

/**
 * GET /api/posts/user/:userId — one Post.aggregate() call returns the page AND the total.
 *
 * Stage order (and why):
 *  1. $match { user }          -> pushed to the query layer; IXSCAN on user_1_createdAt_-1.
 *  2. $sort  { createdAt }      -> satisfied by the same index walk (no blocking SORT).
 *  3. $facet
 *       metadata: $count        -> total for pagination, same single round trip.
 *       data: $skip, $limit,    -> page is cut BEFORE the join...
 *             $lookup, $unwind, -> ...so at most `limit` lookups run (not one per post).
 *             $project
 * Putting $lookup before $sort/$skip/$limit (as in a naive pipeline) would join
 * every post of the user and then discard most of them.
 */
export function buildUserPostsPipeline(
  userId: Types.ObjectId,
  params: PaginationParams<'createdAt'>,
): PipelineStage[] {
  return [
    { $match: { user: userId } },
    { $sort: { createdAt: sortDirection(params.sortOrder) } },
    paginationFacet(params, authorLookupStages()),
  ];
}

/**
 * GET /api/posts — public feed across all users.
 * No `user` equality, so user_1_createdAt_-1 cannot order it; the built-in _id
 * index (creation order) does: $sort+$skip+$limit coalesce into an IXSCAN with a
 * limit. The total comes from estimatedDocumentCount() (collection metadata, O(1))
 * instead of a $count that would scan the whole collection on every request.
 */
export function buildPostFeedPipeline(params: PaginationParams<'createdAt'>): PipelineStage[] {
  return [
    { $sort: { _id: sortDirection(params.sortOrder) } },
    { $skip: getSkip(params) },
    { $limit: params.limit },
    ...(authorLookupStages() as PipelineStage[]),
  ];
}
