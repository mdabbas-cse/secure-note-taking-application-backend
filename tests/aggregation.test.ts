import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Post } from '../src/models/Post.model.js';
import {
  api,
  captureCommands,
  commandSummary,
  createAdmin,
  createPosts,
  createUser,
  splitAuthLookup,
} from './helpers.js';

describe('GET /api/users/aggregation/interests (Scenario 1)', () => {
  async function seedInterviewExample() {
    const admin = await createAdmin({ name: 'Admin', email: 'admin@example.com', interests: [] });
    const abbas = await createUser({
      name: 'Abbas',
      email: 'abbas@example.com',
      interests: ['chess', 'reading'],
    });
    const john = await createUser({
      name: 'John',
      email: 'john@example.com',
      interests: ['reading', 'football'],
    });
    return { admin, abbas, john };
  }

  it('groups users by interest with a clean JSON structure', async () => {
    const { admin, abbas, john } = await seedInterviewExample();
    const res = await api()
      .get('/api/users/aggregation/interests')
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([
      {
        interest: 'chess',
        userCount: 1,
        users: [{ id: abbas.id, name: 'Abbas', email: 'abbas@example.com' }],
      },
      {
        interest: 'football',
        userCount: 1,
        users: [{ id: john.id, name: 'John', email: 'john@example.com' }],
      },
      {
        interest: 'reading',
        userCount: 2,
        users: [
          { id: abbas.id, name: 'Abbas', email: 'abbas@example.com' },
          { id: john.id, name: 'John', email: 'john@example.com' },
        ],
      },
    ]);
    expect(res.body.pagination).toMatchObject({ totalRecords: 3, totalPages: 1, currentPage: 1 });

    // Logical result from the brief: { chess: [Abbas], reading: [Abbas, John], football: [John] }
    const logical = Object.fromEntries(
      res.body.data.map((group: { interest: string; users: { name: string }[] }) => [
        group.interest,
        group.users.map((user) => user.name),
      ]),
    );
    expect(logical).toEqual({ chess: ['Abbas'], reading: ['Abbas', 'John'], football: ['John'] });
  });

  it('the aggregation is exactly ONE aggregate command (only other command: auth lookup)', async () => {
    const { admin } = await seedInterviewExample();
    const { result, commands } = await captureCommands(() =>
      api().get('/api/users/aggregation/interests').set('Cookie', admin.cookie),
    );

    expect(result.status).toBe(200);
    // Everything the request sent to MongoDB, in order.
    expect(commandSummary(commands)).toEqual([
      { name: 'find', collection: 'users' }, // authenticate: current role of the caller by _id
      { name: 'aggregate', collection: 'users' }, // the whole interests operation
    ]);
    const { auth, operation } = splitAuthLookup(commands, admin.id);
    expect(auth).toHaveLength(1);
    expect(commandSummary(operation)).toEqual([{ name: 'aggregate', collection: 'users' }]);

    const pipeline = operation[0]!.command.pipeline as Record<string, unknown>[];
    const stageNames = pipeline.map((stage) => Object.keys(stage)[0]);
    expect(stageNames).toEqual(['$project', '$unwind', '$group', '$set', '$sort', '$facet']);
  });

  it('never exposes password hashes', async () => {
    const { admin } = await seedInterviewExample();
    const res = await api().get('/api/users/aggregation/interests').set('Cookie', admin.cookie);
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/);
  });

  it('paginates and sorts interest groups', async () => {
    const { admin } = await seedInterviewExample();

    const page2 = await api()
      .get('/api/users/aggregation/interests?page=2&limit=2')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(page2.body.data.map((g: { interest: string }) => g.interest)).toEqual(['reading']);
    expect(page2.body.pagination).toEqual({
      currentPage: 2,
      limit: 2,
      totalRecords: 3,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });

    const byCount = await api()
      .get('/api/users/aggregation/interests?sortBy=userCount&sortOrder=desc')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(byCount.body.data.map((g: { interest: string }) => g.interest)).toEqual([
      'reading',
      'chess',
      'football',
    ]);
  });

  it('filters by interests (index-backed $match) in still one aggregate call', async () => {
    const { admin } = await seedInterviewExample();
    const { result, commands } = await captureCommands(() =>
      api()
        .get('/api/users/aggregation/interests?interests=Chess, football')
        .set('Cookie', admin.cookie),
    );

    expect(result.status).toBe(200);
    expect(result.body.data.map((g: { interest: string }) => g.interest)).toEqual([
      'chess',
      'football',
    ]);
    const { operation } = splitAuthLookup(commands, admin.id);
    expect(commandSummary(operation)).toEqual([{ name: 'aggregate', collection: 'users' }]);
    const firstStage = (operation[0]!.command.pipeline as Record<string, unknown>[])[0];
    expect(firstStage).toEqual({ $match: { interests: { $in: ['chess', 'football'] } } });
  });

  it('returns an empty result when no user has interests', async () => {
    const admin = await createAdmin({ interests: [] });
    await createUser({ interests: [] });
    const res = await api()
      .get('/api/users/aggregation/interests')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toMatchObject({
      totalRecords: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('validates query input', async () => {
    const admin = await createAdmin();
    await api()
      .get('/api/users/aggregation/interests?sortBy=name')
      .set('Cookie', admin.cookie)
      .expect(400);
    await api()
      .get('/api/users/aggregation/interests?limit=500')
      .set('Cookie', admin.cookie)
      .expect(400);
  });
});

describe('GET /api/posts/user/:userId (Scenario 2)', () => {
  it('returns the user’s posts joined with author details via $lookup', async () => {
    const viewer = await createUser();
    const author = await createUser({ name: 'Author', email: 'author@example.com' });
    const other = await createUser();
    await createPosts(author.id, 3);
    await createPosts(other.id, 2, 'Other');

    const res = await api()
      .get(`/api/posts/user/${author.id}`)
      .set('Cookie', viewer.cookie)
      .expect(200);

    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      title: 'Post 3',
      content: 'Body 3',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      author: { id: author.id, name: 'Author', email: 'author@example.com' },
    });
    expect(res.body.data.every((p: { author: { id: string } }) => p.author.id === author.id)).toBe(
      true,
    );
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$|"role"/);
  });

  it('the operation is exactly ONE Post.aggregate with $lookup (no populate/find)', async () => {
    const viewer = await createUser();
    const author = await createUser();
    await createPosts(author.id, 2);

    const { result, commands } = await captureCommands(() =>
      api().get(`/api/posts/user/${author.id}`).set('Cookie', viewer.cookie),
    );

    expect(result.status).toBe(200);
    expect(commandSummary(commands)).toEqual([
      { name: 'find', collection: 'users' }, // authenticate: caller's role by _id
      { name: 'aggregate', collection: 'posts' }, // the whole posts + author operation
    ]);
    const { operation } = splitAuthLookup(commands, viewer.id);
    expect(commandSummary(operation)).toEqual([{ name: 'aggregate', collection: 'posts' }]);

    const pipeline = operation[0]!.command.pipeline as Record<string, Record<string, unknown>>[];
    expect(pipeline[0]).toEqual({ $match: { user: new Types.ObjectId(author.id) } });
    expect(pipeline[1]).toEqual({ $sort: { createdAt: -1 } });
    const facet = pipeline[2]!.$facet as Record<string, Record<string, unknown>[]>;
    expect(facet.metadata).toEqual([{ $count: 'totalRecords' }]);
    expect(facet.data!.map((stage) => Object.keys(stage)[0])).toEqual([
      '$skip',
      '$limit',
      '$lookup',
      '$unwind',
      '$project',
    ]);
    expect(facet.data![2]!.$lookup).toMatchObject({
      from: 'users',
      localField: 'user',
      foreignField: '_id',
    });
  });

  it('paginates and sorts by createdAt', async () => {
    const viewer = await createUser();
    const author = await createUser();
    await createPosts(author.id, 15);

    const page2 = await api()
      .get(`/api/posts/user/${author.id}?page=2&limit=10`)
      .set('Cookie', viewer.cookie)
      .expect(200);
    expect(page2.body.data).toHaveLength(5);
    expect(page2.body.data[0].title).toBe('Post 5');
    expect(page2.body.pagination).toEqual({
      currentPage: 2,
      limit: 10,
      totalRecords: 15,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });

    const oldest = await api()
      .get(`/api/posts/user/${author.id}?limit=2&sortOrder=asc`)
      .set('Cookie', viewer.cookie)
      .expect(200);
    expect(oldest.body.data.map((p: { title: string }) => p.title)).toEqual(['Post 1', 'Post 2']);
  });

  it('returns an empty page for a valid id with no posts (still one aggregate)', async () => {
    const viewer = await createUser();
    const { result, commands } = await captureCommands(() =>
      api().get(`/api/posts/user/${new Types.ObjectId().toString()}`).set('Cookie', viewer.cookie),
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual([]);
    expect(result.body.pagination).toMatchObject({ totalRecords: 0, totalPages: 0 });
    expect(commandSummary(splitAuthLookup(commands, viewer.id).operation)).toEqual([
      { name: 'aggregate', collection: 'posts' },
    ]);
  });

  it('rejects an invalid user id with 400 before any posts query runs', async () => {
    const viewer = await createUser();
    const { result, commands } = await captureCommands(() =>
      api().get('/api/posts/user/not-a-valid-id').set('Cookie', viewer.cookie),
    );
    expect(result.status).toBe(400);
    expect(result.body.errors[0]).toMatchObject({ location: 'params', field: 'userId' });
    expect(splitAuthLookup(commands, viewer.id).operation).toEqual([]);
  });

  it('requires authentication', async () => {
    await api().get(`/api/posts/user/${new Types.ObjectId().toString()}`).expect(401);
  });
});

describe('posts: create and global feed', () => {
  it('creates a post owned by the caller', async () => {
    const user = await createUser();
    const res = await api()
      .post('/api/posts')
      .set('Cookie', user.cookie)
      .send({ title: 'Hello', content: 'World' })
      .expect(201);
    expect(res.body.data).toMatchObject({ title: 'Hello', content: 'World', user: user.id });
    await api()
      .post('/api/posts')
      .set('Cookie', user.cookie)
      .send({ title: 'x', content: 'y', user: new Types.ObjectId().toString() })
      .expect(400);
  });

  it('lists all posts newest first with author and pagination', async () => {
    const alice = await createUser({ name: 'Alice' });
    const bob = await createUser({ name: 'Bob' });
    await createPosts(alice.id, 2, 'Alice');
    await createPosts(bob.id, 2, 'Bob');

    const res = await api().get('/api/posts?limit=3').set('Cookie', alice.cookie).expect(200);
    expect(res.body.data.map((p: { title: string }) => p.title)).toEqual([
      'Bob 2',
      'Bob 1',
      'Alice 2',
    ]);
    expect(res.body.data[0].author).toMatchObject({ id: bob.id, name: 'Bob' });
    expect(res.body.pagination).toMatchObject({
      totalRecords: 4,
      totalPages: 2,
      hasNextPage: true,
    });
  });

  it('keeps posts whose author is missing (author: null) so page sizes stay consistent', async () => {
    const viewer = await createUser();
    await Post.create({ title: 'Orphan', content: 'x', user: new Types.ObjectId() });
    const res = await api().get('/api/posts').set('Cookie', viewer.cookie).expect(200);
    expect(res.body.data).toEqual([expect.objectContaining({ title: 'Orphan', author: null })]);
  });
});
