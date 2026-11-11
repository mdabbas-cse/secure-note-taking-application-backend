import type { Types } from 'mongoose';
import { Schema, model, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from './shared.js';

export interface IPost {
  title: string;
  content: string;
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type PostDocument = HydratedDocument<IPost>;

const postSchema = new Schema<IPost>(
  {
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    content: { type: String, required: true, minlength: 1, maxlength: 20_000 },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  baseSchemaOptions,
);

/* ------------------------------------------------------------------ *
 * Indexes (the _id index is created automatically by MongoDB)
 * ------------------------------------------------------------------ */

// user_1_createdAt_-1
// Queries:
//  - GET /api/posts/user/:userId — the aggregation starts with
//      { $match: { user } }, { $sort: { createdAt: ±1 } }
//    which MongoDB pushes down to the query layer: IXSCAN on this index, no
//    blocking SORT stage. The $lookup into `users` uses the built-in users._id index.
//  - deleteMany({ user }) when an admin deletes a user (cascade).
//
// The global feed (GET /api/posts) has no `user` equality, so it is ordered by
// the built-in _id index (creation order) rather than by a new { createdAt: -1 } index.
postSchema.index({ user: 1, createdAt: -1 });

export const Post = model<IPost>('Post', postSchema);
