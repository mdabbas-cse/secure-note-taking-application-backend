import type { Types } from 'mongoose';
import { Schema, model, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from './shared.js';

export interface INote {
  title: string;
  content: string;
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type NoteDocument = HydratedDocument<INote>;

const noteSchema = new Schema<INote>(
  {
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    content: { type: String, default: '', maxlength: 20_000 },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  baseSchemaOptions,
);

/* ------------------------------------------------------------------ *
 * Indexes (the _id index is created automatically by MongoDB)
 * ------------------------------------------------------------------ */

// user_1_createdAt_-1
// Queries:
//  - GET /api/notes (owner, or admin with ?userId=):
//      find({ user }).sort({ createdAt: ±1 }).skip().limit()
//    Equality on the prefix + sort on the suffix => IXSCAN with no in-memory SORT
//    (index is walked forwards or backwards for desc/asc).
//  - countDocuments({ user }) for pagination totals => COUNT_SCAN / IXSCAN.
//  - deleteMany({ user }) when an admin deletes a user (cascade).
// The `user` prefix makes a separate { user: 1 } index redundant.
//
// Not served by this index (and deliberately not indexed separately):
//  - single note lookups { _id, user } -> the built-in _id index is more selective.
//  - admin listing of ALL notes -> no `user` equality, so this index cannot provide
//    the sort; it is ordered by the built-in _id index instead (ObjectIds are
//    creation-ordered), avoiding an extra { createdAt: -1 } index on every write.
noteSchema.index({ user: 1, createdAt: -1 });

export const Note = model<INote>('Note', noteSchema);
