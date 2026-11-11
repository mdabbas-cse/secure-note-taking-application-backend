import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Note } from '../src/models/Note.model.js';
import { Post } from '../src/models/Post.model.js';
import { User } from '../src/models/User.model.js';
import {
  api,
  createAdmin,
  createNotes,
  createPosts,
  createUser,
  DEFAULT_PASSWORD,
} from './helpers.js';

const newUser = {
  name: 'Created By Admin',
  email: 'Created@Example.com',
  password: 'Initial-pass1',
  interests: ['Chess'],
};

describe('admin-only protection', () => {
  const endpoints = (id: string) =>
    [
      ['post', '/api/users'],
      ['get', '/api/users'],
      ['get', `/api/users/${id}`],
      ['patch', `/api/users/${id}`],
      ['delete', `/api/users/${id}`],
      ['get', '/api/users/aggregation/interests'],
    ] as const;

  it('returns 401 for anonymous requests', async () => {
    const target = await createUser();
    for (const [method, path] of endpoints(target.id)) {
      await api()[method](path).expect(401);
    }
  });

  it('returns 403 for normal users on every user-management endpoint', async () => {
    const user = await createUser();
    const target = await createUser();
    for (const [method, path] of endpoints(target.id)) {
      const res = await api()[method](path).set('Cookie', user.cookie).send({ name: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    }
    expect((await User.findById(target.id).lean())?.name).toBe(target.name);
  });

  it('a user cannot promote themselves to admin', async () => {
    const user = await createUser();
    await api()
      .patch(`/api/users/${user.id}`)
      .set('Cookie', user.cookie)
      .send({ role: 'admin' })
      .expect(403);
    expect((await User.findById(user.id).lean())?.role).toBe('user');
  });
});

describe('admin user management', () => {
  it('creates a user (including another admin) without exposing the hash', async () => {
    const admin = await createAdmin();
    const res = await api()
      .post('/api/users')
      .set('Cookie', admin.cookie)
      .send({ ...newUser, role: 'admin' })
      .expect(201);

    expect(res.body.data).toMatchObject({
      name: 'Created By Admin',
      email: 'created@example.com',
      role: 'admin',
      interests: ['chess'],
    });
    expect(res.body.data).not.toHaveProperty('password');

    const stored = await User.findById(res.body.data.id).select('+password').lean();
    expect(stored?.password).toMatch(/^\$2[aby]\$/);
  });

  it('rejects duplicate emails and invalid roles', async () => {
    const admin = await createAdmin({ email: 'admin@example.com' });
    await api()
      .post('/api/users')
      .set('Cookie', admin.cookie)
      .send({ ...newUser, email: 'ADMIN@example.com' })
      .expect(409);
    await api()
      .post('/api/users')
      .set('Cookie', admin.cookie)
      .send({ ...newUser, role: 'superuser' })
      .expect(400);
  });

  it('lists users with pagination and never includes passwords', async () => {
    const admin = await createAdmin();
    for (let i = 0; i < 12; i += 1) await createUser();

    const res = await api()
      .get('/api/users?page=2&limit=5')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toEqual({
      currentPage: 2,
      limit: 5,
      totalRecords: 13,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/);
  });

  it('sorts users by creation (default, newest first) or by email', async () => {
    const admin = await createAdmin({ email: 'm-admin@example.com' });
    await createUser({ email: 'z@example.com' });
    await createUser({ email: 'a@example.com' });

    const newest = await api().get('/api/users').set('Cookie', admin.cookie).expect(200);
    expect(newest.body.data.map((u: { email: string }) => u.email)).toEqual([
      'a@example.com',
      'z@example.com',
      'm-admin@example.com',
    ]);

    const byEmail = await api()
      .get('/api/users?sortBy=email&sortOrder=asc')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(byEmail.body.data.map((u: { email: string }) => u.email)).toEqual([
      'a@example.com',
      'm-admin@example.com',
      'z@example.com',
    ]);

    await api().get('/api/users?sortBy=password').set('Cookie', admin.cookie).expect(400);
  });

  it('gets a single user, 404 for unknown and 400 for malformed ids', async () => {
    const admin = await createAdmin();
    const user = await createUser({ name: 'Target' });
    const res = await api().get(`/api/users/${user.id}`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.data).toMatchObject({ id: user.id, name: 'Target' });
    await api()
      .get(`/api/users/${new Types.ObjectId().toString()}`)
      .set('Cookie', admin.cookie)
      .expect(404);
    await api().get('/api/users/123').set('Cookie', admin.cookie).expect(400);
  });

  it('updates a user; a new password is re-hashed and usable for login', async () => {
    const admin = await createAdmin();
    const user = await createUser({ email: 'old@example.com' });

    const res = await api()
      .patch(`/api/users/${user.id}`)
      .set('Cookie', admin.cookie)
      .send({
        name: 'Renamed',
        email: 'New@Example.com',
        password: 'Brand-new-pass1',
        role: 'admin',
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Renamed',
      email: 'new@example.com',
      role: 'admin',
    });

    const stored = await User.findById(user.id).select('+password').lean();
    expect(stored?.password).toMatch(/^\$2[aby]\$/);
    await api()
      .post('/api/auth/login')
      .send({ email: 'new@example.com', password: 'Brand-new-pass1' })
      .expect(200);
  });

  it('rejects an update to an email that belongs to someone else', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await createUser({ email: 'taken@example.com' });
    await api()
      .patch(`/api/users/${user.id}`)
      .set('Cookie', admin.cookie)
      .send({ email: 'taken@example.com' })
      .expect(409);
  });

  it('deletes a user and cascades to their notes and posts only', async () => {
    const admin = await createAdmin();
    const doomed = await createUser();
    const survivor = await createUser();
    await createNotes(doomed.id, 3);
    await createPosts(doomed.id, 2);
    await createNotes(survivor.id, 1);
    await createPosts(survivor.id, 1);

    await api().delete(`/api/users/${doomed.id}`).set('Cookie', admin.cookie).expect(200);

    expect(await User.exists({ _id: doomed.id })).toBeNull();
    expect(await Note.countDocuments({ user: doomed.id })).toBe(0);
    expect(await Post.countDocuments({ user: doomed.id })).toBe(0);
    expect(await Note.countDocuments({ user: survivor.id })).toBe(1);
    expect(await Post.countDocuments({ user: survivor.id })).toBe(1);
  });
});

describe('role changes and deletions take effect immediately (no stale tokens)', () => {
  it('a demoted admin cannot use their old token to re-promote themselves', async () => {
    const adminA = await createAdmin();
    const adminB = await createAdmin();

    await api()
      .patch(`/api/users/${adminB.id}`)
      .set('Cookie', adminA.cookie)
      .send({ role: 'user' })
      .expect(200);

    // B still holds a signed, unexpired token that says role=admin.
    const retry = await api()
      .patch(`/api/users/${adminB.id}`)
      .set('Cookie', adminB.cookie)
      .send({ role: 'admin' })
      .expect(401);
    expect(retry.body.message).toBe('Your role has changed, please log in again');
    await api()
      .patch(`/api/users/${adminA.id}`)
      .set('Cookie', adminB.cookie)
      .send({ role: 'user' })
      .expect(401);
    await api().get('/api/notes').set('Cookie', adminB.cookie).expect(401);

    expect((await User.findById(adminB.id).lean())?.role).toBe('user');
    expect((await User.findById(adminA.id).lean())?.role).toBe('admin');
  });

  it('a deleted user’s token cannot create notes or posts', async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await api().delete(`/api/users/${user.id}`).set('Cookie', admin.cookie).expect(200);

    await api().post('/api/notes').set('Cookie', user.cookie).send({ title: 'x' }).expect(401);
    await api()
      .post('/api/posts')
      .set('Cookie', user.cookie)
      .send({ title: 'x', content: 'y' })
      .expect(401);
    expect(await Note.countDocuments()).toBe(0);
    expect(await Post.countDocuments()).toBe(0);
  });

  it('a promoted user must log in again to get a token with the new role', async () => {
    const admin = await createAdmin();
    const user = await createUser({ email: 'promoted@example.com' });
    await api()
      .patch(`/api/users/${user.id}`)
      .set('Cookie', admin.cookie)
      .send({ role: 'admin' })
      .expect(200);

    await api().get('/api/users').set('Cookie', user.cookie).expect(401);
    const login = await api()
      .post('/api/auth/login')
      .send({ email: 'promoted@example.com', password: DEFAULT_PASSWORD })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    await api().get('/api/users').set('Cookie', cookie).expect(200);
  });
});

describe('last admin protection', () => {
  it('the only admin cannot delete or demote their own account', async () => {
    const admin = await createAdmin();

    const del = await api()
      .delete(`/api/users/${admin.id}`)
      .set('Cookie', admin.cookie)
      .expect(409);
    expect(del.body.message).toBe('Cannot remove the last admin account');

    await api()
      .patch(`/api/users/${admin.id}`)
      .set('Cookie', admin.cookie)
      .send({ role: 'user' })
      .expect(409);

    expect((await User.findById(admin.id).lean())?.role).toBe('admin');
  });

  it('an admin may step down when another admin exists', async () => {
    const first = await createAdmin();
    const second = await createAdmin();

    await api()
      .patch(`/api/users/${first.id}`)
      .set('Cookie', first.cookie)
      .send({ role: 'user' })
      .expect(200);
    expect((await User.findById(first.id).lean())?.role).toBe('user');
    // `second` is now the last admin and is protected.
    await api().delete(`/api/users/${second.id}`).set('Cookie', second.cookie).expect(409);
  });

  it('an admin may delete their own account when another admin exists', async () => {
    const leaving = await createAdmin();
    await createAdmin();

    await api().delete(`/api/users/${leaving.id}`).set('Cookie', leaving.cookie).expect(200);
    expect(await User.exists({ _id: leaving.id })).toBeNull();
    // The deleted admin's token no longer works.
    await api().get('/api/users').set('Cookie', leaving.cookie).expect(401);
  });

  it('non-role updates to the last admin are allowed', async () => {
    const admin = await createAdmin();
    await api()
      .patch(`/api/users/${admin.id}`)
      .set('Cookie', admin.cookie)
      .send({ name: 'Still admin', role: 'admin' })
      .expect(200);
  });
});
