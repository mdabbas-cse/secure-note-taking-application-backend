import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/createApp.js';
import { AUTH_COOKIE_NAME } from '../src/middleware/authenticate.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../src/middleware/csrf.js';
import { Note } from '../src/models/Note.model.js';
import { Post } from '../src/models/Post.model.js';
import { User, type Role } from '../src/models/User.model.js';
import { signAccessToken } from '../src/utils/jwt.js';

export const app = createApp();

/**
 * Like the real frontend, every request carries the CSRF header. A fresh agent
 * per call keeps tests independent (no cookie jar carried between requests).
 */
export const api = () => request.agent(app).set(CSRF_HEADER, CSRF_HEADER_VALUE);
/** Raw client without the CSRF header, for CSRF tests. */
export const rawApi = () => request(app);

export const DEFAULT_PASSWORD = 'Password123!';

let counter = 0;

export interface TestUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  cookie: string;
}

export async function createUser(
  overrides: Partial<{
    name: string;
    email: string;
    role: Role;
    interests: string[];
    password: string;
  }> = {},
): Promise<TestUser> {
  counter += 1;
  const user = await User.create({
    name: overrides.name ?? `User ${counter}`,
    email: overrides.email ?? `user${counter}@example.com`,
    password: overrides.password ?? DEFAULT_PASSWORD,
    role: overrides.role ?? 'user',
    interests: overrides.interests ?? [],
  });
  const id = user._id.toString();
  return {
    id,
    name: user.name,
    email: user.email,
    role: user.role,
    cookie: authCookie(signAccessToken({ userId: id, role: user.role })),
  };
}

export const createAdmin = (overrides: Parameters<typeof createUser>[0] = {}) =>
  createUser({ ...overrides, role: 'admin' });

export function authCookie(token: string): string {
  return `${AUTH_COOKIE_NAME}=${token}`;
}

/** Creates notes sequentially so createdAt / _id ordering is deterministic. */
export async function createNotes(ownerId: string, count: number, prefix = 'Note') {
  const notes = [];
  for (let i = 1; i <= count; i += 1) {
    notes.push(await Note.create({ title: `${prefix} ${i}`, content: `Body ${i}`, user: ownerId }));
    await tick();
  }
  return notes;
}

export async function createPosts(ownerId: string, count: number, prefix = 'Post') {
  const posts = [];
  for (let i = 1; i <= count; i += 1) {
    posts.push(await Post.create({ title: `${prefix} ${i}`, content: `Body ${i}`, user: ownerId }));
    await tick();
  }
  return posts;
}

/** Guarantees distinct millisecond timestamps between inserts. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

export interface CapturedCommand {
  name: string;
  collection: unknown;
  command: Record<string, unknown>;
}

const IGNORED_COMMANDS = new Set(['hello', 'ismaster', 'isMaster', 'ping', 'endSessions']);

/**
 * Records every command the driver sends to MongoDB while `fn` runs. This is the
 * ground truth for "exactly one aggregate() call": it sees populate(), find(),
 * count queries, getMore, etc., regardless of which Mongoose API issued them.
 */
export async function captureCommands<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; commands: CapturedCommand[] }> {
  const client = mongoose.connection.getClient();
  const commands: CapturedCommand[] = [];
  const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
    if (IGNORED_COMMANDS.has(event.commandName)) return;
    commands.push({
      name: event.commandName,
      collection: event.command[event.commandName],
      command: event.command,
    });
  };
  client.on('commandStarted', listener);
  try {
    const result = await fn();
    return { result, commands };
  } finally {
    client.off('commandStarted', listener);
  }
}

/**
 * Splits off `authenticate`'s per-request account check (find on users by the
 * caller's _id) so tests can assert what the endpoint's own operation sends.
 */
export function splitAuthLookup(commands: CapturedCommand[], callerId: string) {
  const isAuthLookup = (command: CapturedCommand) => {
    const filter = command.command.filter as { _id?: unknown } | undefined;
    return (
      command.name === 'find' && command.collection === 'users' && String(filter?._id) === callerId
    );
  };
  return {
    auth: commands.filter(isAuthLookup),
    operation: commands.filter((command) => !isAuthLookup(command)),
  };
}

export const commandSummary = (commands: CapturedCommand[]) =>
  commands.map(({ name, collection }) => ({ name, collection }));
