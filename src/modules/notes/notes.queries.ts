import type { Types } from 'mongoose';
import { Note } from '../../models/Note.model.js';
import { getSkip, sortDirection, type PaginationParams } from '../../utils/pagination.js';

/**
 * Query builders shared by the service and the explain() tests/scripts, so the
 * index usage that is verified is exactly the query the API runs.
 */

/** `owner` undefined => admin listing across all users. */
export function buildNoteListQuery(
  owner: Types.ObjectId | undefined,
  params: PaginationParams<'createdAt'>,
) {
  const direction = sortDirection(params.sortOrder);
  const query = owner
    ? // Equality on `user` + sort on `createdAt` => IXSCAN user_1_createdAt_-1, no SORT stage.
      Note.find({ user: owner }).sort({ createdAt: direction })
    : // No owner predicate: user_1_createdAt_-1 cannot provide this order, so walk
      // the built-in _id index instead (ObjectIds are creation-ordered).
      Note.find({}).sort({ _id: direction });

  return query.skip(getSkip(params)).limit(params.limit).lean();
}

export function buildNoteCountQuery(owner: Types.ObjectId | undefined) {
  return owner
    ? // COUNT_SCAN over the user_1 prefix of user_1_createdAt_-1.
      Note.countDocuments({ user: owner })
    : // Unfiltered total from collection metadata: O(1), no scan.
      Note.estimatedDocumentCount();
}

/** Read access: admins may read any note, users only their own. */
export function noteReadFilter(noteId: Types.ObjectId, owner: Types.ObjectId | undefined) {
  return owner ? { _id: noteId, user: owner } : { _id: noteId };
}

/** Write access is always owner-scoped (admins too): the owner check is part of the filter. */
export function noteWriteFilter(noteId: Types.ObjectId, owner: Types.ObjectId) {
  return { _id: noteId, user: owner };
}
