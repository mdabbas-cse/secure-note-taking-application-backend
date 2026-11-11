import type { PipelineStage, Types } from 'mongoose';
import mongoose from 'mongoose';
import { findAccountRole } from '../../src/middleware/authenticate.js';
import { Note } from '../../src/models/Note.model.js';
import { Post } from '../../src/models/Post.model.js';
import { User } from '../../src/models/User.model.js';
import {
  buildNoteCountQuery,
  buildNoteListQuery,
  noteReadFilter,
} from '../../src/modules/notes/notes.queries.js';
import {
  buildPostFeedPipeline,
  buildUserPostsPipeline,
} from '../../src/modules/posts/posts.pipelines.js';
import {
  buildInterestGroupsPipeline,
  buildUserListQuery,
} from '../../src/modules/users/users.queries.js';

/**
 * Every important query the API runs, built with the SAME builders the services
 * use, paired with the index explain('executionStats') must show. Used by
 * tests/indexes.test.ts (assertions) and scripts/explain-queries.ts (report).
 */

export interface CatalogContext {
  /** A user that owns notes and posts. */
  ownerId: Types.ObjectId;
  /** One of the owner's notes. */
  noteId: Types.ObjectId;
  /** An existing user's email. */
  email: string;
  /** An interest that exists in the data set. */
  interest: string;
}

export interface CatalogEntry {
  name: string;
  endpoint: string;
  /** Index name expected in the winning plan, or 'COLLSCAN' when a scan is inherent. */
  expected: string;
  /** Plan stages that must NOT appear (e.g. an in-memory SORT). */
  forbiddenStages?: string[];
  /** For $lookup pipelines: index expected on the joined collection. */
  expectedLookupIndex?: string;
  explain(ctx: CatalogContext): Promise<unknown>;
}

const page = { page: 2, limit: 10 } as const;
const VERBOSITY = 'executionStats';

/** Mongoose types explain() as the query's result type; it actually returns the plan. */
const asExplain = (value: unknown): unknown => value;

/**
 * Mongoose cannot explain countDocuments() (it returns the count). Run the real
 * query, capture the exact aggregation the driver sends for it, and explain that.
 * Requires a connection opened with `monitorCommands: true`.
 */
async function captureAggregatePipeline(run: () => Promise<unknown>): Promise<PipelineStage[]> {
  const client = mongoose.connection.getClient();
  let pipeline: PipelineStage[] | undefined;
  const listener = (event: mongoose.mongo.CommandStartedEvent) => {
    if (event.commandName === 'aggregate') pipeline ??= event.command.pipeline as PipelineStage[];
  };
  client.on('commandStarted', listener);
  try {
    await run();
  } finally {
    client.off('commandStarted', listener);
  }
  if (!pipeline) throw new Error('No aggregate captured: connect with monitorCommands: true');
  return pipeline;
}

export const queryCatalog: CatalogEntry[] = [
  {
    name: 'Login lookup by email',
    endpoint: 'POST /api/auth/login',
    expected: 'email_1',
    explain: async ({ email }) =>
      asExplain(await User.findOne({ email }).select('+password').explain(VERBOSITY)),
  },
  {
    name: 'Authentication: account role by _id',
    endpoint: 'every authenticated request',
    expected: '_id_',
    forbiddenStages: ['COLLSCAN'],
    explain: async ({ ownerId }) =>
      asExplain(await findAccountRole(ownerId.toString()).explain(VERBOSITY)),
  },
  {
    name: 'Own notes, newest first (page 2)',
    endpoint: 'GET /api/notes',
    expected: 'user_1_createdAt_-1',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    explain: async ({ ownerId }) =>
      asExplain(
        await buildNoteListQuery(ownerId, {
          ...page,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        }).explain(VERBOSITY),
      ),
  },
  {
    name: 'Own notes, oldest first (index walked backwards)',
    endpoint: 'GET /api/notes?sortOrder=asc',
    expected: 'user_1_createdAt_-1',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    explain: async ({ ownerId }) =>
      asExplain(
        await buildNoteListQuery(ownerId, {
          ...page,
          sortBy: 'createdAt',
          sortOrder: 'asc',
        }).explain(VERBOSITY),
      ),
  },
  {
    name: 'Own notes total (countDocuments)',
    endpoint: 'GET /api/notes (pagination total)',
    expected: 'user_1_createdAt_-1',
    forbiddenStages: ['COLLSCAN'],
    explain: async ({ ownerId }) => {
      const pipeline = await captureAggregatePipeline(() => buildNoteCountQuery(ownerId).exec());
      return Note.aggregate(pipeline).explain(VERBOSITY);
    },
  },
  {
    name: 'All notes for admin, newest first',
    endpoint: 'GET /api/notes (admin)',
    expected: '_id_',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    explain: async () =>
      asExplain(
        await buildNoteListQuery(undefined, {
          ...page,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        }).explain(VERBOSITY),
      ),
  },
  {
    name: 'Admin notes filtered by user',
    endpoint: 'GET /api/notes?userId= (admin)',
    expected: 'user_1_createdAt_-1',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    explain: async ({ ownerId }) =>
      asExplain(
        await buildNoteListQuery(ownerId, {
          ...page,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        }).explain(VERBOSITY),
      ),
  },
  {
    name: 'Single note scoped to owner',
    endpoint: 'GET/PATCH/DELETE /api/notes/:id',
    expected: '_id_',
    forbiddenStages: ['COLLSCAN'],
    explain: async ({ ownerId, noteId }) =>
      asExplain(await Note.findOne(noteReadFilter(noteId, ownerId)).explain(VERBOSITY)),
  },
  {
    name: 'Users list, newest first',
    endpoint: 'GET /api/users',
    expected: '_id_',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    explain: async () =>
      asExplain(
        await buildUserListQuery({ ...page, sortBy: 'createdAt', sortOrder: 'desc' }).explain(
          VERBOSITY,
        ),
      ),
  },
  {
    name: 'Users list sorted by email',
    endpoint: 'GET /api/users?sortBy=email',
    expected: 'email_1',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    explain: async () =>
      asExplain(
        await buildUserListQuery({ ...page, sortBy: 'email', sortOrder: 'asc' }).explain(VERBOSITY),
      ),
  },
  {
    name: 'Interest groups filtered by interest',
    endpoint: 'GET /api/users/aggregation/interests?interests=',
    expected: 'interests_1',
    forbiddenStages: ['COLLSCAN'],
    explain: async ({ interest }) =>
      User.aggregate(
        buildInterestGroupsPipeline({
          page: 1,
          limit: 10,
          sortBy: 'interest',
          sortOrder: 'asc',
          interests: [interest],
        }),
      ).explain(VERBOSITY),
  },
  {
    name: 'Interest groups, all users (full grouping)',
    endpoint: 'GET /api/users/aggregation/interests',
    // Grouping every user reads every user: a scan is inherent, no index helps.
    expected: 'COLLSCAN',
    explain: async () =>
      User.aggregate(
        buildInterestGroupsPipeline({ page: 1, limit: 10, sortBy: 'interest', sortOrder: 'asc' }),
      ).explain(VERBOSITY),
  },
  {
    name: "One user's posts with $lookup author",
    endpoint: 'GET /api/posts/user/:userId',
    expected: 'user_1_createdAt_-1',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    // The join runs only for documents on the page, so explain page 1.
    expectedLookupIndex: '_id_',
    explain: async ({ ownerId }) =>
      Post.aggregate(
        buildUserPostsPipeline(ownerId, {
          page: 1,
          limit: 10,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        }),
      ).explain(VERBOSITY),
  },
  {
    name: 'Global posts feed with $lookup author',
    endpoint: 'GET /api/posts',
    expected: '_id_',
    forbiddenStages: ['SORT', 'COLLSCAN'],
    expectedLookupIndex: '_id_',
    explain: async () =>
      Post.aggregate(
        buildPostFeedPipeline({ ...page, sortBy: 'createdAt', sortOrder: 'desc' }),
      ).explain(VERBOSITY),
  },
  {
    name: 'Last-admin guard (another admin exists?)',
    endpoint: 'PATCH/DELETE /api/users/:id when target is admin',
    // `role` is deliberately not indexed: this guard runs only when an admin is
    // demoted/deleted. The $ne bounds make it an _id_ scan that may read every
    // user — acceptable for a rare admin write, documented in the README.
    expected: '_id_',
    explain: async ({ ownerId }) =>
      asExplain(await User.exists({ role: 'admin', _id: { $ne: ownerId } }).explain(VERBOSITY)),
  },
  {
    name: 'Cascade delete of a user’s notes',
    endpoint: 'DELETE /api/users/:id',
    expected: 'user_1_createdAt_-1',
    forbiddenStages: ['COLLSCAN'],
    // explain on a write only plans it; nothing is deleted.
    explain: async ({ ownerId }) =>
      mongoose.connection.db!.command({
        explain: {
          delete: Note.collection.collectionName,
          deletes: [{ q: { user: ownerId }, limit: 0 }],
        },
        verbosity: VERBOSITY,
      }),
  },
];
