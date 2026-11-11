import { Types } from 'mongoose';
import type { AuthContext } from '../../middleware/authenticate.js';
import { Post } from '../../models/Post.model.js';
import {
  buildPaginationMeta,
  unwrapFacet,
  type FacetResult,
  type PaginationMeta,
} from '../../utils/pagination.js';
import { buildPostFeedPipeline, buildUserPostsPipeline } from './posts.pipelines.js';
import type { CreatePostInput, ListPostsQuery } from './posts.schemas.js';

export interface PostAuthor {
  id: string;
  name: string;
  email: string;
}

export interface PostDTO {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  author: PostAuthor | null;
}

export interface CreatedPostDTO extends Omit<PostDTO, 'author'> {
  user: string;
}

export async function createPost(
  actor: AuthContext,
  input: CreatePostInput,
): Promise<CreatedPostDTO> {
  const post = await Post.create({ ...input, user: new Types.ObjectId(actor.userId) });
  return {
    id: post._id.toString(),
    title: post.title,
    content: post.content,
    user: post.user.toString(),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

export async function listPosts(
  query: ListPostsQuery,
): Promise<{ posts: PostDTO[]; pagination: PaginationMeta }> {
  const [posts, totalRecords] = await Promise.all([
    Post.aggregate<PostDTO>(buildPostFeedPipeline(query)),
    Post.estimatedDocumentCount(),
  ]);
  return { posts, pagination: buildPaginationMeta(query, totalRecords) };
}

/**
 * Exactly ONE database operation: a single Post.aggregate() with $lookup.
 * No populate(), no User.find(), no separate count query. A well-formed but
 * unknown userId simply yields an empty page.
 */
export async function listUserPosts(
  userId: Types.ObjectId,
  query: ListPostsQuery,
): Promise<{ posts: PostDTO[]; pagination: PaginationMeta }> {
  const result = await Post.aggregate<FacetResult<PostDTO>>(buildUserPostsPipeline(userId, query));
  const { data, totalRecords } = unwrapFacet(result);
  return { posts: data, pagination: buildPaginationMeta(query, totalRecords) };
}
