import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Note } from '../src/models/Note.model.js';
import { api, createAdmin, createNotes, createUser } from './helpers.js';

describe('notes CRUD (owner)', () => {
  it('creates a note owned by the authenticated user', async () => {
    const user = await createUser();
    const res = await api()
      .post('/api/notes')
      .set('Cookie', user.cookie)
      .send({ title: '  First note ', content: 'Hello' })
      .expect(201);

    expect(res.body).toMatchObject({
      success: true,
      message: 'Note created successfully',
      data: { title: 'First note', content: 'Hello', user: user.id },
    });
    expect(res.body.data.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('ignores no ownership hints: a `user` field in the body is rejected', async () => {
    const user = await createUser();
    const victim = await createUser();
    await api()
      .post('/api/notes')
      .set('Cookie', user.cookie)
      .send({ title: 'Sneaky', user: victim.id })
      .expect(400);
    expect(await Note.countDocuments()).toBe(0);
  });

  it('validates the note payload', async () => {
    const user = await createUser();
    const res = await api().post('/api/notes').set('Cookie', user.cookie).send({}).expect(400);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ location: 'body', field: 'title' }),
    ]);
  });

  it('requires authentication', async () => {
    await api().get('/api/notes').expect(401);
    await api().post('/api/notes').send({ title: 'x' }).expect(401);
  });

  it('lists only the caller’s own notes', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createNotes(alice.id, 2, 'Alice');
    await createNotes(bob.id, 3, 'Bob');

    const res = await api().get('/api/notes').set('Cookie', alice.cookie).expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((note: { user: string }) => note.user === alice.id)).toBe(true);
    expect(res.body.pagination.totalRecords).toBe(2);
  });

  it('gets, updates and deletes an own note', async () => {
    const user = await createUser();
    const [note] = await createNotes(user.id, 1);
    const id = note!._id.toString();

    const got = await api().get(`/api/notes/${id}`).set('Cookie', user.cookie).expect(200);
    expect(got.body.data).toMatchObject({ id, title: 'Note 1' });

    const updated = await api()
      .patch(`/api/notes/${id}`)
      .set('Cookie', user.cookie)
      .send({ title: 'Renamed' })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id, title: 'Renamed', content: 'Body 1' });

    await api().delete(`/api/notes/${id}`).set('Cookie', user.cookie).expect(200);
    await api().get(`/api/notes/${id}`).set('Cookie', user.cookie).expect(404);
    expect(await Note.countDocuments()).toBe(0);
  });

  it('rejects empty updates and attempts to change ownership', async () => {
    const user = await createUser();
    const other = await createUser();
    const [note] = await createNotes(user.id, 1);
    const id = note!._id.toString();

    await api().patch(`/api/notes/${id}`).set('Cookie', user.cookie).send({}).expect(400);
    await api()
      .patch(`/api/notes/${id}`)
      .set('Cookie', user.cookie)
      .send({ user: other.id })
      .expect(400);
    expect((await Note.findById(id).lean())?.user.toString()).toBe(user.id);
  });

  it('returns 400 for a malformed id and 404 for an unknown id', async () => {
    const user = await createUser();
    const res = await api().get('/api/notes/not-an-id').set('Cookie', user.cookie).expect(400);
    expect(res.body.errors[0]).toMatchObject({ location: 'params', field: 'id' });
    await api()
      .get(`/api/notes/${new Types.ObjectId().toString()}`)
      .set('Cookie', user.cookie)
      .expect(404);
  });
});

describe('notes authorization', () => {
  it('a user cannot read, update or delete another user’s note (404, no leak)', async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const [note] = await createNotes(owner.id, 1, 'Private');
    const id = note!._id.toString();

    await api().get(`/api/notes/${id}`).set('Cookie', intruder.cookie).expect(404);
    await api()
      .patch(`/api/notes/${id}`)
      .set('Cookie', intruder.cookie)
      .send({ title: 'Hacked' })
      .expect(404);
    await api().delete(`/api/notes/${id}`).set('Cookie', intruder.cookie).expect(404);

    const stored = await Note.findById(id).lean();
    expect(stored?.title).toBe('Private 1');
  });

  it('a user cannot list another user’s notes via ?userId=', async () => {
    const owner = await createUser();
    const intruder = await createUser();
    await createNotes(owner.id, 2);

    await api().get(`/api/notes?userId=${owner.id}`).set('Cookie', intruder.cookie).expect(403);
    // Passing your own id is fine.
    await api().get(`/api/notes?userId=${intruder.id}`).set('Cookie', intruder.cookie).expect(200);
  });

  it('an admin can list everyone’s notes and filter by user', async () => {
    const admin = await createAdmin();
    const alice = await createUser();
    const bob = await createUser();
    await createNotes(alice.id, 2);
    await createNotes(bob.id, 3);

    const all = await api().get('/api/notes').set('Cookie', admin.cookie).expect(200);
    expect(all.body.data).toHaveLength(5);
    expect(all.body.pagination.totalRecords).toBe(5);

    const onlyBob = await api()
      .get(`/api/notes?userId=${bob.id}`)
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(onlyBob.body.data).toHaveLength(3);
    expect(onlyBob.body.data.every((note: { user: string }) => note.user === bob.id)).toBe(true);
  });

  it('an admin can read any note but writes stay owner-scoped', async () => {
    const admin = await createAdmin();
    const alice = await createUser();
    const [note] = await createNotes(alice.id, 1);
    const id = note!._id.toString();

    await api().get(`/api/notes/${id}`).set('Cookie', admin.cookie).expect(200);
    await api()
      .patch(`/api/notes/${id}`)
      .set('Cookie', admin.cookie)
      .send({ title: 'Admin edit' })
      .expect(404);
    await api().delete(`/api/notes/${id}`).set('Cookie', admin.cookie).expect(404);
  });
});

describe('notes pagination', () => {
  it('paginates with correct metadata, newest first by default', async () => {
    const user = await createUser();
    await createNotes(user.id, 25);

    const first = await api()
      .get('/api/notes?page=1&limit=10')
      .set('Cookie', user.cookie)
      .expect(200);
    expect(first.body.pagination).toEqual({
      currentPage: 1,
      limit: 10,
      totalRecords: 25,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(first.body.data.map((note: { title: string }) => note.title).slice(0, 3)).toEqual([
      'Note 25',
      'Note 24',
      'Note 23',
    ]);

    const last = await api()
      .get('/api/notes?page=3&limit=10')
      .set('Cookie', user.cookie)
      .expect(200);
    expect(last.body.data).toHaveLength(5);
    expect(last.body.pagination).toMatchObject({
      currentPage: 3,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    expect(last.body.data.at(-1).title).toBe('Note 1');

    const beyond = await api()
      .get('/api/notes?page=4&limit=10')
      .set('Cookie', user.cookie)
      .expect(200);
    expect(beyond.body.data).toEqual([]);
    expect(beyond.body.pagination.hasNextPage).toBe(false);
  });

  it('pages do not overlap and cover every record exactly once', async () => {
    const user = await createUser();
    await createNotes(user.id, 23);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await api().get(`/api/notes?page=${page}&limit=10`).set('Cookie', user.cookie);
      seen.push(...res.body.data.map((note: { id: string }) => note.id));
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it('supports ascending order', async () => {
    const user = await createUser();
    await createNotes(user.id, 3);
    const res = await api()
      .get('/api/notes?sortBy=createdAt&sortOrder=asc')
      .set('Cookie', user.cookie)
      .expect(200);
    expect(res.body.data.map((note: { title: string }) => note.title)).toEqual([
      'Note 1',
      'Note 2',
      'Note 3',
    ]);
  });

  it('applies defaults (page 1, limit 10)', async () => {
    const user = await createUser();
    await createNotes(user.id, 12);
    const res = await api().get('/api/notes').set('Cookie', user.cookie).expect(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.pagination).toMatchObject({ currentPage: 1, limit: 10, totalPages: 2 });
  });

  it.each([
    ['page=0', 'page'],
    ['page=-1', 'page'],
    ['page=abc', 'page'],
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['limit=2.5', 'limit'],
    ['sortBy=title', 'sortBy'],
    ['sortOrder=up', 'sortOrder'],
  ])('rejects invalid pagination input %s', async (query, field) => {
    const user = await createUser();
    const res = await api().get(`/api/notes?${query}`).set('Cookie', user.cookie).expect(400);
    expect(res.body.errors).toEqual([expect.objectContaining({ location: 'query', field })]);
  });

  it('query-string operator injection is inert (simple parser keeps keys literal)', async () => {
    const user = await createUser();
    const other = await createUser();
    await createNotes(user.id, 1, 'Mine');
    await createNotes(other.id, 2, 'Theirs');
    const res = await api()
      .get(`/api/notes?page[$gt]=1&user[$ne]=${user.id}&userId[$ne]=${user.id}`)
      .set('Cookie', user.cookie)
      .expect(200);
    // Still scoped to the caller: exactly their one note, nobody else's.
    expect(res.body.data.map((note: { title: string }) => note.title)).toEqual(['Mine 1']);
    expect(res.body.pagination).toMatchObject({ currentPage: 1, totalRecords: 1 });
  });

  it('admin listing across all users is paginated too', async () => {
    const admin = await createAdmin();
    const alice = await createUser();
    const bob = await createUser();
    await createNotes(alice.id, 8);
    await createNotes(bob.id, 7);
    const res = await api()
      .get('/api/notes?page=2&limit=10')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toMatchObject({
      totalRecords: 15,
      totalPages: 2,
      hasPreviousPage: true,
    });
  });
});
