import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { Note } from '../src/models/Note.model.js';
import { Post } from '../src/models/Post.model.js';
import { User } from '../src/models/User.model.js';
import { summarizeExplain } from '../scripts/lib/explainSummary.js';
import { queryCatalog, type CatalogContext } from '../scripts/lib/queryCatalog.js';

async function indexInventory(model: typeof User | typeof Note | typeof Post) {
  const indexes = await model.collection.indexes();
  return Object.fromEntries(indexes.map((index) => [index.name, index]));
}

describe('index inventory (no missing, no redundant indexes)', () => {
  it('users: _id, unique email, multikey interests — nothing else', async () => {
    const indexes = await indexInventory(User);
    expect(Object.keys(indexes).sort()).toEqual(['_id_', 'email_1', 'interests_1']);
    expect(indexes.email_1?.unique).toBe(true);
    expect(indexes.email_1?.key).toEqual({ email: 1 });
    expect(indexes.interests_1?.key).toEqual({ interests: 1 });
  });

  it('notes: _id and { user: 1, createdAt: -1 } only', async () => {
    const indexes = await indexInventory(Note);
    expect(Object.keys(indexes).sort()).toEqual(['_id_', 'user_1_createdAt_-1']);
    expect(indexes['user_1_createdAt_-1']?.key).toEqual({ user: 1, createdAt: -1 });
  });

  it('posts: _id and { user: 1, createdAt: -1 } only', async () => {
    const indexes = await indexInventory(Post);
    expect(Object.keys(indexes).sort()).toEqual(['_id_', 'user_1_createdAt_-1']);
    expect(indexes['user_1_createdAt_-1']?.key).toEqual({ user: 1, createdAt: -1 });
  });

  it('schemas declare indexes only through schema.index() (no field-level index/unique)', () => {
    for (const model of [User, Note, Post]) {
      const fieldLevel = Object.entries(model.schema.paths).filter(([path, schemaType]) => {
        const options = schemaType.options as { index?: unknown; unique?: unknown };
        return path !== '_id' && (options.index !== undefined || options.unique !== undefined);
      });
      expect(fieldLevel).toEqual([]);
    }
  });

  it('database indexes match the schemas exactly (diffIndexes is empty)', async () => {
    for (const model of [User, Note, Post]) {
      const diff = await model.diffIndexes();
      expect(diff).toEqual({ toDrop: [], toCreate: [] });
    }
  });
});

describe('query safety', () => {
  it('filters on paths outside the schema throw instead of being silently dropped', async () => {
    const owner = new Types.ObjectId();
    await Note.create({ title: 'keep me', user: owner });
    // A typo in an ownership filter must not become a delete of the whole collection.
    await expect(Note.deleteMany({ usr: owner } as never)).rejects.toThrow(/not in schema/);
    expect(await Note.countDocuments()).toBe(1);
  });
});

describe("explain('executionStats') for every important query", () => {
  let ctx: CatalogContext;

  beforeEach(async () => {
    const users = await User.insertMany(
      Array.from({ length: 40 }, (_, i) => ({
        name: `User ${i}`,
        email: `user${i}@example.com`,
        password: 'not-a-real-hash',
        role: i === 0 ? 'admin' : 'user',
        interests: i % 4 === 0 ? [] : i % 2 ? ['chess', 'reading'] : ['football'],
      })),
    );
    const now = Date.now();
    const notes = await Note.insertMany(
      users.flatMap((user, u) =>
        Array.from({ length: 25 }, (_, i) => ({
          title: `Note ${i}`,
          content: 'body',
          user: user._id,
          createdAt: new Date(now - (u * 25 + i) * 1000),
        })),
      ),
    );
    await Post.insertMany(
      users.flatMap((user) =>
        Array.from({ length: 15 }, (_, i) => ({
          title: `Post ${i}`,
          content: 'body',
          user: user._id,
        })),
      ),
    );
    ctx = {
      ownerId: users[3]!._id,
      noteId: notes.find((note) => note.user.equals(users[3]!._id))!._id,
      email: users[5]!.email,
      interest: 'chess',
    };
  });

  for (const entry of queryCatalog) {
    it(`${entry.endpoint} — ${entry.name} uses ${entry.expected}`, async () => {
      const summary = summarizeExplain(await entry.explain(ctx));

      if (entry.expected === 'COLLSCAN') {
        expect(summary.stages).toContain('COLLSCAN');
      } else {
        expect(summary.indexNames).toContain(entry.expected);
      }
      for (const stage of entry.forbiddenStages ?? []) {
        expect(summary.stages).not.toContain(stage);
      }
      if (entry.expectedLookupIndex) {
        expect(summary.lookupIndexesUsed).toContain(entry.expectedLookupIndex);
      }
    });
  }

  it('paginated owner listing reads only the requested page of documents', async () => {
    const entry = queryCatalog.find((item) => item.endpoint === 'GET /api/notes')!;
    const summary = summarizeExplain(await entry.explain(ctx));
    // page 2, limit 10: 20 index keys walked, only 10 documents fetched.
    expect(summary.totalKeysExamined).toBe(20);
    expect(summary.totalDocsExamined).toBe(10);
  });

  it('owner listing never touches another user’s index entries', async () => {
    const stranger = new Types.ObjectId();
    const entry = queryCatalog.find((item) => item.endpoint === 'GET /api/notes')!;
    const summary = summarizeExplain(await entry.explain({ ...ctx, ownerId: stranger }));
    expect(summary.totalKeysExamined).toBe(0);
    expect(summary.totalDocsExamined).toBe(0);
  });
});
